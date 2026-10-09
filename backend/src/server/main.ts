import { existsSync, readFileSync, readdirSync } from "node:fs";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicChat, runAnalystTurn, type Message } from "../analyst/agent.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { buildSession } from "../cli/assemble.js";
import { DATA_SETS, ROOT, VENDORS, dataDir, latestRun, type DataSet } from "../cli/vendors.js";
import { loadConfig } from "../config.js";
import type { Policy } from "../award/optimizer.js";
import { confirmAward } from "../award/gate.js";
import { pendingConfirmations } from "../review/confirmations.js";
import { applyDecisions, regate, verifyQuote } from "../store/apply.js";
import { writeSnapshot } from "../store/snapshot.js";
import { Store } from "../store/store.js";
import { traceView } from "./trace.js";
import { awardDecision, awardView, cellView, clarificationView, comparisonView, vendorView, type Session } from "./views.js";

/**
 * The buyer UI's API (spec 18). Serves the saved live runs; only the analyst calls a model. Buyer decisions
 * (confirmations, cell verifications and overrides, gate waivers, confirmed awards) are stored in SQLite, one file per
 * data set (data/app.db for the demo set), re-applied to the rebuilt data on every load, and logged in the event log.
 * Usage: npm run api   (port 8787; the UI's dev server proxies /api here)
 *        npm start     (one server for a deployment: the API plus the built UI from frontend/dist, on $PORT)
 */

const PORT = Number(process.env.PORT ?? 8787);
const config = loadConfig();
/** The pipeline's output per set, rebuilt from the saved runs once; decisions are applied to a copy. */
const base = new Map<DataSet, Session>();
/** The current state per set: the pipeline output with every stored decision applied. Dropped after each write. */
const sessions = new Map<DataSet, Session>();
const stores = new Map<DataSet, Store>();
const ACTOR = "Meera";

function storeOf(set: DataSet): Store {
  let s = stores.get(set);
  if (!s) {
    s = new Store(join(dataDir(set), "app.db"));
    stores.set(set, s);
  }
  return s;
}
/** Analyst conversations, by set and conversation id: the full message history, for follow-up questions. */
const conversations = new Map<string, Message[]>();

async function session(set: DataSet): Promise<Session> {
  const cached = sessions.get(set);
  if (cached) return cached;
  let b = base.get(set);
  if (!b) {
    b = await buildSession(set, config);
    base.set(set, b);
  }
  const s = structuredClone(b);
  const report = applyDecisions(s, storeOf(set));
  if (report.skipped.length) console.log(`${set}: ${report.skipped.length} stored decision(s) no longer fit the data: ${report.skipped.map((x) => `${x.kind} ${x.ref} (${x.why})`).join("; ")}`);
  writeSnapshot(storeOf(set), s);
  sessions.set(set, s);
  return s;
}

/** After a buyer decision: the next read rebuilds the current state from the store. */
const changed = (set: DataSet) => sessions.delete(set);

async function availableSets(): Promise<{ set: DataSet; vendors: number }[]> {
  const out: { set: DataSet; vendors: number }[] = [];
  for (const set of DATA_SETS) {
    if (!existsSync(join(dataDir(set), "ground_truth.json"))) continue;
    let n = 0;
    for (const id of Object.keys(VENDORS)) if (await latestRun(id, config, set)) n++;
    if (n > 0) out.push({ set, vendors: n });
  }
  return out;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** The built UI (npm run build -w frontend), served when present so one process runs the whole app. */
const UI_DIR = join(ROOT, "frontend", "dist");
const UI_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function serveUi(pathname: string, res: ServerResponse): boolean {
  if (!existsSync(UI_DIR)) return false;
  const path = normalize(join(UI_DIR, decodeURIComponent(pathname)));
  if (!path.startsWith(UI_DIR)) return false;
  // Assets by path; anything else is the app itself (its routes live after the #).
  const file = existsSync(path) && extname(path) ? path : join(UI_DIR, "index.html");
  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, { "content-type": UI_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
  res.end(readFileSync(file));
  return true;
}

const TYPES: Record<string, string> = { ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".eml": "message/rfc822" };

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/") && req.method === "GET" && serveUi(url.pathname, res)) return;
  const set = (url.searchParams.get("set") ?? "tuned") as DataSet;
  if (!DATA_SETS.includes(set)) return send(res, 400, { error: `unknown set ${set}` });
  const p = url.pathname;

  if (p === "/api/sets") return send(res, 200, await availableSets());
  if (p === "/api/comparison") return send(res, 200, comparisonView(await session(set)));
  if (p === "/api/cell") {
    const v = cellView(await session(set), url.searchParams.get("vendor") ?? "", url.searchParams.get("line") ?? "");
    return v ? send(res, 200, v) : send(res, 404, { error: "no such cell" });
  }
  if (p === "/api/vendor") {
    const v = vendorView(await session(set), url.searchParams.get("vendor") ?? "");
    return v ? send(res, 200, v) : send(res, 404, { error: "no such vendor" });
  }
  if (p === "/api/clarify") return send(res, 200, { draft: clarificationView(await session(set), url.searchParams.get("vendor") ?? "") });
  if (p === "/api/award") {
    const q = url.searchParams;
    const policy: Partial<Policy> = {};
    if (q.get("gate_policy")) policy.gate_policy = q.get("gate_policy") as Policy["gate_policy"];
    if (q.get("spec_policy")) policy.spec_policy = q.get("spec_policy") as Policy["spec_policy"];
    if (q.get("cell_policy")) policy.cell_policy = q.get("cell_policy") as Policy["cell_policy"];
    if (q.get("include_expired")) policy.include_expired_quotes = q.get("include_expired") === "true";
    return send(res, 200, awardView(await session(set), policy));
  }
  if (req.method === "POST" && ["/api/confirm", "/api/verify", "/api/override", "/api/waive", "/api/award/confirm"].includes(p)) {
    const body = await readJson(req);
    const reason = String(body.reason ?? "").trim();
    const at = new Date().toISOString();
    const s = await session(set);
    const store = storeOf(set);
    try {
      if (p === "/api/award/confirm") {
        const policy = (body.policy ?? {}) as Partial<Policy>;
        const d = awardDecision(s, policy);
        const r = confirmAward(d.result, d.gate, (body.acknowledged as string[]) ?? [], { actor: ACTOR, at });
        if (!r.ok) return send(res, 400, { error: r.reason, missing: r.missing_acknowledgments ?? [] });
        const summary = { cost: d.result.cost, savings: d.result.savings, vendors: d.result.vendors, lines: d.result.assignments.map((a) => ({ line_id: a.line_id, vendor_id: a.vendor_id, price: a.price })), unfillable: d.result.unfillable, exposure_pct: d.gate.exposure_pct, warnings: d.gate.warnings };
        const award = store.addAward({ constraints: d.policy, result: summary, actor: ACTOR, at, exposure_inr: r.record.exposure_inr, acknowledged: r.record.acknowledged_ids });
        changed(set);
        return send(res, 200, { award });
      }
      if (!reason) return send(res, 400, { error: "a decision needs a reason" });
      const vendor = String(body.vendor ?? "");
      const v = s.vendors.find((x) => x.vendor_id === vendor);
      if (p === "/api/confirm") {
        const id = String(body.id);
        const owner = s.vendors.find((x) => pendingConfirmations(x.quotes, s.config.currency_of_record).some((c) => c.id === id));
        const c = owner && pendingConfirmations(owner.quotes, s.config.currency_of_record).find((x) => x.id === id);
        if (!owner || !c) return send(res, 400, { error: `no pending confirmation ${id}` });
        const decision = body.decision === "rejected" ? "rejected" : "confirmed";
        store.addConfirmation({ confirmation_id: id, vendor_id: owner.vendor_id, decision, lines: c.lines, reason, actor: ACTOR, at });
        changed(set);
        return send(res, 200, { log: { confirmation_id: id, decision, lines: c.lines, actor: ACTOR, at, reason } });
      }
      if (!v) return send(res, 400, { error: `no vendor ${vendor}` });
      if (p === "/api/waive") {
        const q = String(body.q_id ?? "");
        const g = v.gates.gates.find((x) => x.q_id === q);
        if (!g) return send(res, 400, { error: `${q} is not a gate` });
        if (g.result === "PASS" || g.waiver) return send(res, 400, { error: `${vendor} ${q} needs no waiver (${g.waiver ? "already waived" : "passed"})` });
        store.addWaiver({ vendor_id: vendor, q_id: q, reason, actor: ACTOR, at });
        changed(set);
        return send(res, 200, { ok: true });
      }
      const line = String(body.line ?? "");
      const quote = v.quotes.find((x) => x.line_id === line);
      if (!quote) return send(res, 400, { error: `no cell ${vendor} ${line}` });
      const rateNow = quote.components.find((c) => c.kind === "base_rate")?.point ?? null;
      if (p === "/api/verify") {
        verifyQuote(quote, reason); // throws when there is nothing to verify
        store.addOverride({ vendor_id: vendor, line_id: line, field: "verify", old_value: quote.state, new_value: "BUYER_VERIFIED", reason, actor: ACTOR, at });
      } else {
        const rate = Number(body.rate);
        if (!Number.isFinite(rate) || rate <= 0) return send(res, 400, { error: "enter the rate as a positive number (INR per base unit, ex GST)" });
        store.addOverride({ vendor_id: vendor, line_id: line, field: "rate", old_value: rateNow === null ? null : String(rateNow), new_value: String(rate), reason, actor: ACTOR, at });
      }
      changed(set);
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }
  if (p === "/api/events") return send(res, 200, storeOf(set).events());
  if (p === "/api/trace") {
    const vendor = url.searchParams.get("vendor") ?? "";
    const dir = join(dataDir(set), "vendors", vendor);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith(".json")).map((f) => ({ vendor_id: vendor, filename: f, content: readFileSync(join(dir, f)) })) : [];
    const t = traceView(await session(set), vendor, { files, events: storeOf(set).events() }, url.searchParams.get("line") ?? undefined);
    return t ? send(res, 200, t) : send(res, 404, { error: "no such vendor" });
  }
  if (p === "/api/awards") {
    // A confirmed award is stale when the same scenario now gives a different cost or exposure (spec 10.8).
    const s = await session(set);
    return send(
      res,
      200,
      storeOf(set).awards().map((a) => {
        const now = awardDecision(s, a.scenario.constraints as Partial<Policy>);
        const then = a.scenario.result as { cost: { point: number } };
        const stale = Math.abs(now.result.cost.point - then.cost.point) > 0.5 || Math.abs(now.gate.exposure_inr - a.exposure_inr) > 0.5;
        return { ...a, stale, now: { cost: now.result.cost, exposure_inr: now.gate.exposure_inr } };
      }),
    );
  }
  if (p === "/api/image") {
    // A crop of a vendor's photo around a box (normalized x0,y0,x1,y1), wide enough to show the row it sits in.
    const v = (await session(set)).vendors.find((x) => x.vendor_id === url.searchParams.get("vendor"));
    const img = v?.doc.images?.[0];
    if (!img) return send(res, 404, { error: "no photo for this vendor" });
    const buf = Buffer.from(img.data, "base64");
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 1;
    const H = meta.height ?? 1;
    const box = (url.searchParams.get("box") ?? "").split(",").map(Number);
    let out: Buffer = buf;
    if (box.length === 4 && box.every((n) => Number.isFinite(n))) {
      const [x0, y0, x1, y1] = box as [number, number, number, number];
      const left = Math.max(0, Math.floor((x0 - 0.62) * W));
      const top = Math.max(0, Math.floor((y0 - 0.04) * H));
      const right = Math.min(W, Math.ceil((x1 + 0.06) * W));
      const bottom = Math.min(H, Math.ceil((y1 + 0.04) * H));
      out = await sharp(buf).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).jpeg({ quality: 85 }).toBuffer();
    }
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(out);
    return;
  }
  if (p === "/api/analyst" && req.method === "POST") {
    // The analyst (spec 14): server-sent events, tool chips as they run, then the answer blocks.
    const body = await readJson(req);
    const question = String(body.question ?? "").trim();
    const convId = String(body.conversation_id ?? "");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const event = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (!question) {
      event({ type: "error", message: "Ask a question." });
      return void res.end();
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      event({ type: "error", message: "The analyst needs an API key (ANTHROPIC_API_KEY in .env, or in the host's environment variables). Everything else works without it." });
      return void res.end();
    }
    try {
      const key = `${set}:${convId}`;
      const s = await session(set);
      let wrote = false;
      const r = await runAnalystTurn({
        session: s,
        writes: {
          // Stored and logged like the UI's own actions, and applied to this turn's data so later tool calls see them.
          verify: (vendor, line, reason) => {
            const v = s.vendors.find((x) => x.vendor_id === vendor);
            const q = v?.quotes.find((x) => x.line_id === line);
            if (!v || !q) throw new Error(`no cell ${vendor} ${line}`);
            const next = verifyQuote(q, `Verified by Meera (via the analyst): ${reason}`);
            storeOf(set).addOverride({ vendor_id: vendor, line_id: line, field: "verify", old_value: q.state, new_value: "BUYER_VERIFIED", reason, actor: "Meera (via the analyst)", at: new Date().toISOString() });
            v.quotes = v.quotes.map((x) => (x.line_id === line ? next : x));
            wrote = true;
          },
          waive: (vendor, q, reason) => {
            const v = s.vendors.find((x) => x.vendor_id === vendor);
            const g = v?.gates.gates.find((x) => x.q_id === q);
            if (!v || !g) throw new Error(`no gate ${vendor} ${q}`);
            if (g.result === "PASS" || g.waiver) throw new Error(`${vendor} ${q} needs no waiver`);
            storeOf(set).addWaiver({ vendor_id: vendor, q_id: q, reason, actor: "Meera (via the analyst)", at: new Date().toISOString() });
            regate(s, vendor, storeOf(set).waivers().filter((w) => w.vendor_id === vendor).map((w) => ({ q_id: w.q_id, reason: w.reason, actor: w.actor })));
            wrote = true;
          },
        },
        client: new AnthropicChat(new Anthropic({ timeout: config.limits.llm_timeout_s * 1000 * 2, maxRetries: config.limits.max_retries })),
        question,
        history: conversations.get(key) ?? [],
        model: config.models.analyst,
        onEvent: event,
      });
      conversations.set(key, r.messages);
      if (wrote) changed(set);
    } catch (err) {
      const msg = (err as Error).message;
      event({
        type: "error",
        message: /credit balance is too low/i.test(msg)
          ? "The Anthropic API account has no credit left, so the analyst cannot answer. Add credits in the Anthropic console (Plans & Billing); nothing else in the app needs them."
          : msg,
      });
    }
    return void res.end();
  }
  if (p === "/api/reset" && req.method === "POST") {
    storeOf(set).reset();
    for (const k of [...conversations.keys()]) if (k.startsWith(`${set}:`)) conversations.delete(k);
    sessions.delete(set);
    return send(res, 200, { ok: true });
  }
  if (p === "/api/file") {
    // A vendor file, for "open the original". Only files under the set's vendors folder.
    const base = join(dataDir(set), "vendors");
    const path = normalize(join(base, url.searchParams.get("path") ?? ""));
    if (!path.startsWith(base + sep) || !existsSync(path)) return send(res, 404, { error: "no such file" });
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "content-disposition": `inline; filename="${path.split(sep).pop()}"` });
    res.end(readFileSync(path));
    return;
  }
  send(res, 404, { error: "not found" });
}

createServer((req, res) => {
  route(req, res).catch((err) => send(res, 500, { error: (err as Error).message }));
}).listen(PORT, () => console.log(`QuoteKill API on http://localhost:${PORT}  (sets: ${DATA_SETS.join(", ")})${existsSync(UI_DIR) ? ", serving the built UI" : ""}`));
