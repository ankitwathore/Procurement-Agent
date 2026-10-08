import { topCandidate, type Row } from "../ingest/extraction.js";
import { intake, type IncomingFile } from "../ingest/intake.js";
import { screenInjection } from "../ingest/injection.js";
import type { Quote } from "../ingest/quotes.js";
import type { EventRow } from "../store/store.js";
import type { Session, TraceStep } from "./views.js";

/**
 * The trace page (spec 18.8): for one vendor's document, every step from intake to the state of each cell, with the
 * model, time, tokens and cost of each model call, and the inputs and outputs behind it. A cell's slice shows only what
 * touched that cell, so an evaluator can see that nothing is canned. Never ground truth.
 */

export interface TraceRow {
  row_id: string;
  line_id: string;
  rate: string;
  unit: string | null;
  currency: string;
  snippet: string;
  locator: Record<string, unknown>;
  legibility: number;
  struck: boolean;
  carried_over: string[];
  assumptions: string[];
  rejected: string | null;
}

export interface TraceStage {
  id: string;
  title: string;
  /** The model call behind the stage, when there is one. */
  call: TraceStep | null;
  summary: string;
  /** Stage specific detail: a table (columns and rows) and/or free items. */
  table?: { columns: string[]; rows: (string | number | null)[][] };
  items?: string[];
}

const rowOf = (r: Row, rejected: Map<string, string>): TraceRow => ({
  row_id: r.row_id,
  line_id: topCandidate(r),
  rate: r.rate.value === null ? "(unreadable)" : String(r.rate.value),
  unit: r.rate.unit_as_written,
  currency: r.rate.currency,
  snippet: r.snippet,
  locator: r.locator,
  legibility: r.legibility,
  struck: r.struck_out_or_overwritten,
  carried_over: r.carried_over,
  assumptions: r.assumptions,
  rejected: rejected.get(r.row_id) ?? null,
});

const loc = (l: Record<string, unknown>) =>
  l.type === "xlsx" ? `${String(l.sheet)}!${String(l.cell)}` :
  l.type === "pdf" ? `page ${String(l.page)}` :
  l.type === "docx" ? (typeof l.paragraph_idx === "number" ? `P${String(l.paragraph_idx)}` : `T${String(l.table_idx)} R${String(l.row)}`) :
  l.type === "email" ? `chars ${String(l.char_start)}-${String(l.char_end)}` :
  l.type === "image" ? `row ${String(l.row ?? "?")}${Array.isArray(l.box) ? ` box ${(l.box as number[]).map((x) => x.toFixed(2)).join(",")}` : ""}` :
  String(l.type);

const money = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toFixed(2));

export function traceView(s: Session, vendorId: string, opts: { files: IncomingFile[]; events: EventRow[] }, line?: string) {
  const v = s.vendors.find((x) => x.vendor_id === vendorId);
  if (!v) return null;
  const run = v.run ?? {};
  const traces = v.traces ?? [];
  const call = (step: string) => traces.find((t) => t.step === step) ?? null;
  const rejected = new Map(v.rejected.map((r) => [r.row_id, r.reason]));
  const only = (id: string) => !line || id === line;
  const aRows = ((run.extraction?.rows ?? []) as Row[]).map((r) => rowOf(r, rejected)).filter((r) => only(r.line_id));
  const bRows = ((run.pass_b?.extraction?.rows ?? []) as Row[]).map((r) => rowOf(r, rejected)).filter((r) => only(r.line_id));
  const quotes = v.quotes.filter((q) => only(q.line_id));
  const stages: TraceStage[] = [];
  const rowTable = (rows: TraceRow[]) => ({
    columns: ["Row", "Line", "Rate", "Unit", "Currency", "Where", "Legibility", "Notes", "Provenance check"],
    rows: rows.map((r) => [r.row_id, r.line_id, r.rate, r.unit, r.currency || "-", loc(r.locator), r.legibility, [r.struck ? "struck/overwritten" : "", r.carried_over.length ? `carried: ${r.carried_over.join(", ")}` : "", ...r.assumptions].filter(Boolean).join("; ") || null, r.rejected ? `rejected: ${r.rejected}` : "passed"]),
  });

  if (!line) {
    const arts = intake(opts.files);
    stages.push({
      id: "intake",
      title: "Intake",
      call: null,
      summary: `${arts.length} file${arts.length === 1 ? "" : "s"} received; ${arts.filter((a) => a.status === "DUPLICATE").length} duplicate by hash.`,
      table: { columns: ["File", "Kind", "Size", "SHA-256", "Status"], rows: arts.map((a) => [a.filename, a.kind, a.size, a.sha256.slice(0, 12), a.duplicate_of ? `duplicate of ${arts.find((x) => x.artifact_id === a.duplicate_of)?.filename ?? a.duplicate_of}` : a.status]) },
    });
    const lines = v.doc.text.split("\n");
    stages.push({
      id: "parse",
      title: "Parse",
      call: null,
      summary: `${v.doc.kind} read into ${v.doc.text.length.toLocaleString("en-IN")} characters, ${lines.length} lines${v.doc.authoritative_end !== undefined ? `; the vendor's own message ends at character ${v.doc.authoritative_end}, the rest is quoted history` : ""}${v.doc.images?.length ? `; ${v.doc.images.length} photo${v.doc.images.length > 1 ? "s" : ""} sent to the model as image${v.doc.images.length > 1 ? "s" : ""}` : ""}.`,
      items: lines.slice(0, 12),
    });
    const findings = screenInjection(v.doc.text).findings;
    const flagged = [...new Set(findings.map((f) => f.line_index))];
    stages.push({
      id: "injection",
      title: "Injection screen",
      call: null,
      summary: flagged.length ? `${flagged.length} line${flagged.length > 1 ? "s" : ""} addressed to AI systems (${[...new Set(findings.map((f) => f.pattern))].join(", ")}): removed before the model saw the text, recorded for the buyer.` : "Nothing addressed to AI systems.",
      items: flagged.map((i) => findings.find((f) => f.line_index === i)!.line),
    });
  }

  stages.push({
    id: "pass_a",
    title: "Pass A (document first)",
    call: call("extract_a"),
    summary: `${aRows.length} row${aRows.length === 1 ? "" : "s"}${line ? ` for ${line}` : `, ${Object.keys(run.extraction?.vendor_terms ?? {}).length} terms, ${(run.questionnaire ?? []).length} questionnaire answers`}.`,
    table: rowTable(aRows),
    items: line ? [] : (run.notes ?? []),
  });
  if (run.pass_b) {
    stages.push({
      id: "pass_b",
      title: "Pass B (RFx first)",
      call: call("extract_b"),
      summary: `${bRows.length} row${bRows.length === 1 ? "" : "s"}${line ? ` for ${line}` : ""}; read without seeing pass A.`,
      table: rowTable(bRows),
      items: line ? [] : (run.pass_b.notes ?? []),
    });
  }
  const recon = quotes.filter((q) => q.reconciliation);
  if (recon.length) {
    const count = (st: string) => recon.filter((q) => q.reconciliation!.status === st).length;
    stages.push({
      id: "reconcile",
      title: "Reconcile the passes",
      call: null,
      summary: line ? recon[0]!.reconciliation!.detail : `agree ${count("agree")}, disagree ${count("disagree")}, only A ${count("a_only")}, only B ${count("b_only")}, neither ${count("neither")}.`,
      table: { columns: ["Line", "Status", "Detail"], rows: recon.filter((q) => line || q.reconciliation!.status !== "agree").map((q) => [q.line_id, q.reconciliation!.status, q.reconciliation!.detail]) },
    });
  }
  const adj = ((run.adjudication?.adjudications ?? []) as { line_id: string; decision: string; reasoning: string }[]).filter((a) => only(a.line_id));
  if (run.adjudication && (adj.length || !line)) {
    stages.push({
      id: "adjudicate",
      title: "Adjudicator (disputed lines only)",
      call: call("adjudicate"),
      summary: `${adj.length} line${adj.length === 1 ? "" : "s"} settled or left in review.`,
      table: { columns: ["Line", "Decision", "Reasoning"], rows: adj.map((a) => [a.line_id, a.decision, a.reasoning]) },
    });
  }
  const checked = quotes.filter((q) => q.flags.length || q.spec_flags.length || q.arithmetic?.fails || q.suggested_reading || q.hidden_values.length);
  stages.push({
    id: "checks",
    title: "Checks",
    call: null,
    summary: `${checked.length} cell${checked.length === 1 ? "" : "s"} with a finding: outliers and slips, arithmetic, spec against the RFx and the test report, hidden values, carried or assumed units and currency.`,
    table: {
      columns: ["Line", "Flags", "Detail"],
      rows: checked.map((q) => [
        q.line_id,
        q.flags.join(", ") || null,
        [
          q.suggested_reading ? `probable reading ${money(q.suggested_reading.suggested_rate)} (not applied)` : "",
          q.arithmetic?.fails ? `vendor total ${money(q.arithmetic.stated)} vs qty x rate ${money(q.arithmetic.expected)}` : "",
          ...q.spec_flags.map((f) => `${f.detail}${f.source === "test_report" ? " (test report)" : ""}`),
          ...q.hidden_values.map((h) => `hidden value ${h.value ?? "-"} in ${String(h.locator.cell ?? "")}`),
        ].filter(Boolean).join("; ") || null,
      ]),
    },
  });
  const priced = quotes.filter((q) => q.components.length);
  stages.push({
    id: "normalize",
    title: "Normalize to landed cost",
    call: null,
    summary: "Unit, currency, GST and freight conversions in code; each component keeps its own state and range.",
    table: {
      columns: ["Line", "Chain", "Rate", "Freight", "Landed (low to high)"],
      rows: priced.map((q) => {
        const r = q.components.find((c) => c.kind === "base_rate");
        const f = q.components.find((c) => c.kind === "freight");
        return [q.line_id, q.chain.join(" -> ") || "as written", r ? `${money(r.point)} ${r.state}` : "-", f ? `${money(f.point)} ${f.state} (${f.basis.replace("_", " ")})` : "-", q.landed ? `${money(q.landed.point)} (${money(q.landed.low)} to ${money(q.landed.high)})` : "-"];
      }),
    },
  });
  stages.push({
    id: "state",
    title: "State assignment",
    call: null,
    summary: line ? `${quotes[0]?.state ?? "MISSING"} by rule ${quotes[0]?.state_rule ?? "-"}.` : stateCounts(v.quotes),
    table: { columns: ["Line", "State", "Rule", "Why"], rows: quotes.map((q) => [q.line_id, q.state, q.state_rule, q.state_reason]) },
  });
  if (!line) {
    for (const t of traces.filter((x) => x.step === "extract_evidence")) {
      const e = v.evidence_docs.find((d) => d.file === t.file);
      stages.push({ id: `evidence:${t.file}`, title: `Evidence: ${t.file.split("/").pop()}`, call: t, summary: e ? `${e.role.replace("_", " ")}, ${e.read ? "read and checked" : "not read"}.` : "evidence document" });
    }
    stages.push({
      id: "gates",
      title: "Questionnaire gates",
      call: null,
      summary: v.gates.headline,
      table: { columns: ["Gate", "Result", "Why"], rows: v.gates.gates.map((g) => [g.q_id, g.waiver ? "WAIVED" : g.result, g.reason]) },
    });
  }
  const events = opts.events.filter((e) => (line ? e.ref === `${vendorId}:${line}` || (Array.isArray((e.payload as { lines?: string[] }).lines) && e.ref.startsWith(`${vendorId}:`) && (e.payload as { lines: string[] }).lines.includes(line)) : e.ref.startsWith(`${vendorId}:`)));
  if (events.length) {
    stages.push({
      id: "decisions",
      title: "Buyer decisions",
      call: null,
      summary: `${events.length} decision${events.length === 1 ? "" : "s"} applied on top, from the audit log.`,
      table: { columns: ["When", "What", "Ref", "Who", "Reason"], rows: events.map((e) => [e.at.slice(0, 16).replace("T", " "), e.kind, e.ref, String((e.payload as { actor?: string }).actor ?? ""), String((e.payload as { reason?: string }).reason ?? "")]) },
    });
  }
  const calls = (line ? stages.map((x) => x.call).filter((c): c is TraceStep => !!c) : traces);
  return {
    vendor_id: vendorId,
    file: v.file,
    run_file: v.run_file,
    line: line ?? null,
    totals: { calls: calls.length, cost_usd: calls.reduce((n, c) => n + (c.cost_usd ?? 0), 0), ms: calls.reduce((n, c) => n + (c.ms ?? 0), 0) },
    stages,
  };
}

function stateCounts(quotes: readonly Quote[]): string {
  const c = new Map<string, number>();
  for (const q of quotes) c.set(q.state, (c.get(q.state) ?? 0) + 1);
  return [...c.entries()].map(([s, n]) => `${s} ${n}`).join(", ");
}
