import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../llm/pricing.js";
import type { Session } from "../server/views.js";
import { comparisonView } from "../server/views.js";
import { formatRupees } from "../util/format.js";
import { buildDb } from "./db.js";
import { checkGrounding, toolNumbers } from "./grounding.js";
import { TOOLS, runTool, type Chart, type ToolDef, type TurnState } from "./tools.js";

/**
 * The analyst agent (spec 14): a tool loop over the comparison. It never computes in its head: every figure in its
 * answer must match a number from this turn's tool results (grounding check, spec 14.5). An answer with ungrounded
 * figures is sent back with the list; after two corrections it is shown with those figures marked unverified.
 */

const PROMPT = fileURLToPath(new URL("../../../prompts/analyst.md", import.meta.url));
export const MAX_STEPS = 14;
export const MAX_CORRECTIONS = 2;

export type Message = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;

export interface ChatTurn {
  content: Block[];
  stop_reason: string | null;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
}

/** One model call. The real one streams from the API; tests pass a stub. */
export interface ChatClient {
  turn(req: { model: string; system: string; tools: ToolDef[]; messages: Message[]; max_tokens: number }): Promise<ChatTurn>;
}

export class AnthropicChat implements ChatClient {
  constructor(private readonly client: Anthropic) {}
  async turn(req: { model: string; system: string; tools: ToolDef[]; messages: Message[]; max_tokens: number }): Promise<ChatTurn> {
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.client.beta.messages.stream({
          model: req.model,
          max_tokens: req.max_tokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          tools: req.tools as Anthropic.Beta.BetaTool[],
          messages: req.messages,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
        });
        const msg = await stream.finalMessage();
        return {
          content: msg.content,
          stop_reason: msg.stop_reason,
          model: msg.model,
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } catch (err) {
        // The SDK retries failed requests, not a stream that drops part way.
        if (!/terminated|ECONNRESET|socket hang up|other side closed/i.test(String((err as Error)?.message ?? err)) || attempt >= 2) throw err;
      }
    }
  }
}

export type AnswerBlock =
  | { type: "answer"; markdown: string }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "chart"; spec: Chart }
  | { type: "how"; tool_calls: { name: string; input: unknown; summary: string }[] }
  | { type: "assumptions"; items: string[] }
  | { type: "trust"; unsafe_components: number; exposure_inr: number; exposure_pct: number; cost_low: number; cost_high: number; cost_point: number; headline: string }
  | { type: "actions"; items: { label: string; kind: string; vendor_id: string; line_id: string }[] };

export type AnalystEvent =
  | { type: "tool"; name: string; status: "start" | "done" | "error"; summary: string }
  | { type: "correction"; ungrounded: string[] }
  | { type: "final"; blocks: AnswerBlock[]; unverified: string[]; cost_usd: number; model: string; steps: number };

export interface TurnResult {
  blocks: AnswerBlock[];
  unverified: string[];
  /** The conversation including this turn, to send back next time (multi-turn state, spec 14.7). */
  messages: Message[];
  cost_usd: number;
  steps: number;
  /** Every tool call of the turn with its full output, for checks (the eval) and traces. */
  tool_results: { name: string; input: unknown; output: unknown; error: string | null }[];
}

/** Numbers anyone may write without a tool call: the RFx's own figures, the buyer's question, the config basics. */
function basePool(s: Session, question: string): number[] {
  const pool: number[] = [];
  toolNumbers(s.lines.map((l) => [l.description, l.spec.dims_text, l.annual_qty, l.baseline_price_inr, l.spec.ply, l.spec.liner_gsm, l.spec.bf]), pool);
  toolNumbers(question, pool);
  pool.push(s.config.fx.USD_INR, s.lines.length, s.vendors.length);
  return pool;
}

const summarize = (name: string, out: unknown): string => {
  if (name === "query_comparison") return `${(out as { rows: unknown[] }).rows.length} rows`;
  if (name === "scenario_award") {
    const o = out as { cost: { point: number }; award_gate: { status: string } };
    return `cost ${formatRupees(o.cost.point)}, gate ${o.award_gate.status}`;
  }
  if (name === "calc") return `= ${(out as { value: number }).value}`;
  return "done";
};

function contextFor(s: Session): string {
  const c = comparisonView(s);
  return [
    `RFx ${s.rfx.rfx_id}: ${s.rfx.title}. ${s.lines.length} lines. Today is ${s.config.as_of_date}; expected award ${s.config.expected_award_date}. FX USD ${s.config.fx.USD_INR}.`,
    `Vendors: ${c.vendors.map((v) => `${v.vendor_id} ${v.name} (${v.city}, ${v.format}, ${v.freight.replace("_", " ")}, gates ${v.gate}, ${v.coverage.quoted}/${v.coverage.total} quoted)`).join("; ")}.`,
    "Delivery history, vendor financials and market prices are not stored.",
  ].join("\n");
}

export async function runAnalystTurn(opts: {
  session: Session;
  client: ChatClient;
  question: string;
  history?: Message[];
  model: string;
  onEvent?: (e: AnalystEvent) => void;
  /** Persists the two write tools; without it they refuse. */
  writes?: import("./tools.js").Writes;
}): Promise<TurnResult> {
  const { session: s, client, question } = opts;
  const emit = opts.onEvent ?? (() => undefined);
  const system = `${readFileSync(PROMPT, "utf8")}\n\nCURRENT COMPARISON\n${contextFor(s)}`;
  const db = buildDb(s);
  const state: TurnState = { charts: [], trust: null, instruction: question, writes: opts.writes };
  const pool = basePool(s, question);
  const log: { name: string; input: unknown; summary: string }[] = [];
  const toolResults: TurnResult["tool_results"] = [];
  const messages: Message[] = [...(opts.history ?? []), { role: "user", content: question }];
  let cost = 0;
  let model = opts.model;
  let corrections = 0;
  let final: { input: Record<string, unknown>; unverified: string[] } | null = null;

  const ground = (a: Record<string, unknown>) => {
    const charts = state.charts.filter((c) => c.id === a.chart_id);
    const prose = [a.markdown, ...((a.assumptions as string[]) ?? []), ...(((a.table_rows as string[][]) ?? []).flat()), ...charts.flatMap((c) => c.series.flatMap((x) => x.values.map(String)))].join("\n");
    return checkGrounding(prose, pool);
  };

  let steps = 0;
  for (; steps < MAX_STEPS && !final; steps++) {
    const res = await client.turn({ model: opts.model, system, tools: TOOLS, messages, max_tokens: 16000 });
    cost += costUsd(res.model, res.usage) ?? 0;
    model = res.model;
    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    if (uses.length === 0) {
      // Ended without the answer tool: take the text as the answer, still checked.
      const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
      const g = checkGrounding(text, pool);
      if (!g.ok && corrections < MAX_CORRECTIONS && res.stop_reason === "end_turn") {
        corrections++;
        emit({ type: "correction", ungrounded: g.ungrounded });
        messages.push({ role: "user", content: `These figures are not in any tool result of this turn: ${g.ungrounded.join(", ")}. Re-run the tools you need (calc for arithmetic), then call the answer tool.` });
        continue;
      }
      final = { input: { markdown: text || "I could not produce an answer.", table_columns: [], table_rows: [], chart_id: "", assumptions: [], actions: [] }, unverified: g.ungrounded };
      break;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const input = (u.input ?? {}) as Record<string, unknown>;
      if (u.name === "answer") {
        const g = ground(input);
        if (!g.ok && corrections < MAX_CORRECTIONS) {
          corrections++;
          emit({ type: "correction", ungrounded: g.ungrounded });
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `Not delivered. These figures are not in any tool result of this turn: ${g.ungrounded.join(", ")}. Re-run the tools you need (calc for arithmetic) or remove the figures, then call answer again.` });
        } else {
          final = { input, unverified: g.ungrounded };
          results.push({ type: "tool_result", tool_use_id: u.id, content: "Delivered to the buyer." });
        }
        continue;
      }
      emit({ type: "tool", name: u.name, status: "start", summary: JSON.stringify(input).slice(0, 160) });
      try {
        const out = runTool(u.name, input, s, db, state);
        toolNumbers(out, pool);
        const summary = summarize(u.name, out);
        log.push({ name: u.name, input, summary });
        toolResults.push({ name: u.name, input, output: out, error: null });
        emit({ type: "tool", name: u.name, status: "done", summary });
        const text = JSON.stringify(out);
        results.push({ type: "tool_result", tool_use_id: u.id, content: text.length > 30000 ? `${text.slice(0, 30000)}... (truncated; narrow the query)` : text });
      } catch (err) {
        const msg = (err as Error).message;
        log.push({ name: u.name, input, summary: `error: ${msg}` });
        toolResults.push({ name: u.name, input, output: null, error: msg });
        emit({ type: "tool", name: u.name, status: "error", summary: msg });
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: msg });
      }
    }
    messages.push({ role: "user", content: results });
  }

  const a = final?.input ?? { markdown: "I ran out of steps before finishing. Ask a narrower question.", table_columns: [], table_rows: [], chart_id: "", assumptions: [], actions: [] };
  const blocks: AnswerBlock[] = [{ type: "answer", markdown: String(a.markdown ?? "") }];
  const cols = (a.table_columns as string[]) ?? [];
  if (cols.length) blocks.push({ type: "table", columns: cols, rows: (a.table_rows as string[][]) ?? [] });
  const chart = state.charts.find((c) => c.id === a.chart_id);
  if (chart) blocks.push({ type: "chart", spec: chart });
  // The trust block comes from code, from the last award or exposure the agent ran (spec 14.4 rule 4).
  if (state.trust) {
    const t = state.trust;
    blocks.push({ type: "trust", ...t, headline: `${formatRupees(t.exposure_inr)} (${t.exposure_pct.toFixed(1)}%) rests on ${t.unsafe_components} unconfirmed component${t.unsafe_components === 1 ? "" : "s"}.` });
  }
  const assumptions = (a.assumptions as string[]) ?? [];
  if (assumptions.length) blocks.push({ type: "assumptions", items: assumptions });
  if (log.length) blocks.push({ type: "how", tool_calls: log });
  const actions = (a.actions as { label: string; kind: string; vendor_id: string; line_id: string }[]) ?? [];
  if (actions.length) blocks.push({ type: "actions", items: actions });

  const unverified = final?.unverified ?? [];
  emit({ type: "final", blocks, unverified, cost_usd: cost, model, steps });
  return { blocks, unverified, messages, cost_usd: cost, steps, tool_results: toolResults };
}
