import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

/**
 * The SQLite store (spec 7.1, 8.2): one file per data set (data/app.db for the demo set).
 * Two kinds of tables. Pipeline output (quotes, components, terms, answers, certificates, discrepancies, traces) is a
 * snapshot, rebuilt from the saved runs, because the pipeline is deterministic. Buyer decisions (confirmations,
 * overrides, gate waivers, scenarios, awards) are durable and re-applied on top of every rebuild; each one also goes to
 * the event log, the audit trail. `reset` restores a clean state.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rfx (rfx_id TEXT PRIMARY KEY, title TEXT, category TEXT, buyer_org TEXT, delivery_location TEXT, currency TEXT, issue_date TEXT, due_date TEXT, terms_json TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS rfx_line (line_id TEXT, rfx_id TEXT, sku_code TEXT, description TEXT, spec_json TEXT, base_uom TEXT, annual_qty REAL, weight_kg_per_uom REAL, conversion_hints_json TEXT, baseline_price_inr REAL, baseline_basis TEXT, baseline_date TEXT, gst_rate_pct REAL, PRIMARY KEY (rfx_id, line_id));
CREATE TABLE IF NOT EXISTS question (q_id TEXT, rfx_id TEXT, text TEXT, type TEXT, is_gate INTEGER, file_required INTEGER, pass_rule_json TEXT, weight REAL, PRIMARY KEY (rfx_id, q_id));
CREATE TABLE IF NOT EXISTS vendor (vendor_id TEXT PRIMARY KEY, name TEXT, city TEXT, contact_email TEXT, aliases_json TEXT);
CREATE TABLE IF NOT EXISTS submission (submission_id TEXT PRIMARY KEY, rfx_id TEXT, vendor_id TEXT, revision INTEGER, received_at TEXT, channel TEXT, is_current INTEGER, supersedes_submission_id TEXT, subject TEXT, body_text TEXT, late INTEGER);
CREATE TABLE IF NOT EXISTS artifact (artifact_id TEXT PRIMARY KEY, submission_id TEXT, filename TEXT, path TEXT, sha256 TEXT, kind TEXT, status TEXT, error TEXT, pages INTEGER, doc_role TEXT);
CREATE TABLE IF NOT EXISTS quote (quote_id TEXT PRIMARY KEY, rfx_id TEXT, vendor_id TEXT, line_id TEXT, submission_id TEXT, artifact_id TEXT, raw_rate REAL, raw_currency TEXT, raw_uom TEXT, raw_text TEXT, qty_basis TEXT, normalized_rate_inr REAL, landed_unit_inr REAL, landed_low_inr REAL, landed_high_inr REAL, state TEXT, state_reason TEXT, spec_offered_json TEXT, spec_flags_json TEXT, pass_a_json TEXT, pass_b_json TEXT, adjudication_json TEXT, provenance_json TEXT, assumptions_json TEXT, is_current INTEGER);
CREATE TABLE IF NOT EXISTS quote_component (component_id TEXT PRIMARY KEY, quote_id TEXT, kind TEXT, value_inr_per_uom REAL, low_inr REAL, high_inr REAL, state TEXT, basis TEXT, provenance_json TEXT);
CREATE TABLE IF NOT EXISTS vendor_terms (vendor_id TEXT, submission_id TEXT, payment_terms TEXT, freight_basis TEXT, incoterms TEXT, gst_basis TEXT, validity_until TEXT, lead_time_days INTEGER, moq TEXT, conditional_discounts_json TEXT, price_variation_clause TEXT, fx_clause TEXT, other_conditions_json TEXT, provenance_json TEXT, state TEXT);
CREATE TABLE IF NOT EXISTS questionnaire_answer (vendor_id TEXT, q_id TEXT, answer_raw TEXT, answer_value TEXT, state TEXT, gate_result TEXT, evidence_artifact_id TEXT, provenance_json TEXT, note TEXT, PRIMARY KEY (vendor_id, q_id));
CREATE TABLE IF NOT EXISTS certificate_check (check_id TEXT PRIMARY KEY, vendor_id TEXT, artifact_id TEXT, cert_type TEXT, issuer TEXT, entity_name TEXT, valid_from TEXT, valid_to TEXT, scope TEXT, status TEXT, details_json TEXT);
CREATE TABLE IF NOT EXISTS discrepancy (discrepancy_id TEXT PRIMARY KEY, vendor_id TEXT, kind TEXT, severity TEXT, detail TEXT, affected_lines_json TEXT, rupee_exposure REAL, quote_ids_json TEXT, status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS override_log (override_id TEXT PRIMARY KEY, quote_id TEXT, field TEXT, old_value TEXT, new_value TEXT, reason TEXT, actor TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS gate_waiver (vendor_id TEXT, q_id TEXT, reason TEXT, actor TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS message (message_id TEXT PRIMARY KEY, thread_id TEXT, direction TEXT, vendor_id TEXT, from_addr TEXT, to_addr TEXT, subject TEXT, body TEXT, at TEXT, status TEXT, intent TEXT);
CREATE TABLE IF NOT EXISTS scenario (scenario_id TEXT PRIMARY KEY, session_id TEXT, name TEXT, constraints_json TEXT, objective TEXT, mode TEXT, result_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS award (award_id TEXT PRIMARY KEY, scenario_id TEXT, confirmed_at TEXT, actor TEXT, exposure_inr REAL, ack_json TEXT, superseded INTEGER);
CREATE TABLE IF NOT EXISTS run_trace (trace_id TEXT PRIMARY KEY, artifact_id TEXT, step TEXT, model TEXT, input_ref TEXT, output_json TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, ms INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS event_log (event_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, payload_json TEXT, at TEXT);
-- Added beyond spec 8.2: the buyer's decision on a batch confirmation (one decision settles several cells).
CREATE TABLE IF NOT EXISTS confirmation_decision (decision_id TEXT PRIMARY KEY, confirmation_id TEXT, vendor_id TEXT, decision TEXT, lines_json TEXT, reason TEXT, actor TEXT, at TEXT);
`;

/** Pipeline output: replaced wholesale by every snapshot. */
export const SNAPSHOT_TABLES = ["rfx", "rfx_line", "question", "vendor", "submission", "artifact", "quote", "quote_component", "vendor_terms", "questionnaire_answer", "certificate_check", "discrepancy", "run_trace"] as const;
/** Buyer decisions and the audit trail: kept until a reset. */
export const DECISION_TABLES = ["override_log", "gate_waiver", "message", "scenario", "award", "event_log", "confirmation_decision"] as const;

export interface ConfirmationRow {
  decision_id: string;
  confirmation_id: string;
  vendor_id: string;
  decision: "confirmed" | "rejected";
  lines: string[];
  reason: string;
  actor: string;
  at: string;
}

/** A buyer's change to one cell: "verify" marks the read value correct; "rate" replaces it (INR per base unit, ex GST). */
export interface OverrideRow {
  override_id: string;
  vendor_id: string;
  line_id: string;
  field: "verify" | "rate";
  old_value: string | null;
  new_value: string | null;
  reason: string;
  actor: string;
  at: string;
}

export interface WaiverRow {
  vendor_id: string;
  q_id: string;
  reason: string;
  actor: string;
  at: string;
}

export interface AwardRow {
  award_id: string;
  scenario_id: string;
  confirmed_at: string;
  actor: string;
  exposure_inr: number;
  acknowledged: string[];
  superseded: boolean;
  scenario: { constraints: unknown; result: unknown };
}

export interface EventRow {
  event_id: string;
  kind: string;
  ref: string;
  payload: unknown;
  at: string;
}

export const quoteId = (vendor: string, line: string) => `${vendor}:${line}`;

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Restores a clean state: every decision and the audit trail removed, the snapshot emptied (spec 22 step 2). */
  reset(): void {
    this.db.transaction(() => {
      for (const t of [...DECISION_TABLES, ...SNAPSHOT_TABLES]) this.db.exec(`DELETE FROM ${t}`);
    })();
  }

  logEvent(kind: string, ref: string, payload: unknown, at = new Date().toISOString()): EventRow {
    const e = { event_id: randomUUID(), kind, ref, payload, at };
    this.db.prepare("INSERT INTO event_log VALUES (?, ?, ?, ?, ?)").run(e.event_id, kind, ref, JSON.stringify(payload), at);
    return e;
  }

  events(limit = 500): EventRow[] {
    return (this.db.prepare("SELECT * FROM event_log ORDER BY at DESC, rowid DESC LIMIT ?").all(limit) as { event_id: string; kind: string; ref: string; payload_json: string; at: string }[]).map((r) => ({ event_id: r.event_id, kind: r.kind, ref: r.ref, payload: JSON.parse(r.payload_json), at: r.at }));
  }

  addConfirmation(c: Omit<ConfirmationRow, "decision_id">): ConfirmationRow {
    const row = { decision_id: randomUUID(), ...c };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO confirmation_decision VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(row.decision_id, c.confirmation_id, c.vendor_id, c.decision, JSON.stringify(c.lines), c.reason, c.actor, c.at);
      this.logEvent(`confirmation_${c.decision}`, c.confirmation_id, { lines: c.lines, reason: c.reason, actor: c.actor }, c.at);
    })();
    return row;
  }

  confirmations(): ConfirmationRow[] {
    return (this.db.prepare("SELECT * FROM confirmation_decision ORDER BY at, rowid").all() as (Omit<ConfirmationRow, "lines"> & { lines_json: string })[]).map(({ lines_json, ...r }) => ({ ...r, lines: JSON.parse(lines_json) }));
  }

  addOverride(o: Omit<OverrideRow, "override_id">): OverrideRow {
    const row = { override_id: randomUUID(), ...o };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO override_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(row.override_id, quoteId(o.vendor_id, o.line_id), o.field, o.old_value, o.new_value, o.reason, o.actor, o.at);
      this.logEvent(o.field === "verify" ? "cell_verified" : "cell_overridden", quoteId(o.vendor_id, o.line_id), { old: o.old_value, new: o.new_value, reason: o.reason, actor: o.actor }, o.at);
    })();
    return row;
  }

  overrides(): OverrideRow[] {
    return (this.db.prepare("SELECT * FROM override_log ORDER BY at, rowid").all() as { override_id: string; quote_id: string; field: OverrideRow["field"]; old_value: string | null; new_value: string | null; reason: string; actor: string; at: string }[]).map((r) => {
      const [vendor_id, line_id] = r.quote_id.split(":") as [string, string];
      return { override_id: r.override_id, vendor_id, line_id, field: r.field, old_value: r.old_value, new_value: r.new_value, reason: r.reason, actor: r.actor, at: r.at };
    });
  }

  addWaiver(w: WaiverRow): WaiverRow {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO gate_waiver VALUES (?, ?, ?, ?, ?)").run(w.vendor_id, w.q_id, w.reason, w.actor, w.at);
      this.logEvent("gate_waived", `${w.vendor_id}:${w.q_id}`, { reason: w.reason, actor: w.actor }, w.at);
    })();
    return w;
  }

  waivers(): WaiverRow[] {
    return this.db.prepare("SELECT * FROM gate_waiver ORDER BY at, rowid").all() as WaiverRow[];
  }

  /** A confirmed award, with the scenario it came from. An earlier award is marked superseded. */
  addAward(a: { constraints: unknown; result: unknown; actor: string; at: string; exposure_inr: number; acknowledged: string[] }): AwardRow {
    const scenario_id = randomUUID();
    const award_id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare("UPDATE award SET superseded = 1 WHERE superseded = 0").run();
      this.db.prepare("INSERT INTO scenario VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(scenario_id, "ui", "confirmed award", JSON.stringify(a.constraints), "risk adjusted landed cost", "award", JSON.stringify(a.result), a.at);
      this.db.prepare("INSERT INTO award VALUES (?, ?, ?, ?, ?, ?, 0)").run(award_id, scenario_id, a.at, a.actor, a.exposure_inr, JSON.stringify(a.acknowledged));
      this.logEvent("award_confirmed", award_id, { scenario_id, exposure_inr: a.exposure_inr, acknowledged: a.acknowledged.length, actor: a.actor }, a.at);
    })();
    return { award_id, scenario_id, confirmed_at: a.at, actor: a.actor, exposure_inr: a.exposure_inr, acknowledged: a.acknowledged, superseded: false, scenario: { constraints: a.constraints, result: a.result } };
  }

  awards(): AwardRow[] {
    return (this.db.prepare("SELECT a.*, s.constraints_json, s.result_json FROM award a JOIN scenario s USING (scenario_id) ORDER BY a.confirmed_at DESC, a.rowid DESC").all() as { award_id: string; scenario_id: string; confirmed_at: string; actor: string; exposure_inr: number; ack_json: string; superseded: number; constraints_json: string; result_json: string }[]).map((r) => ({
      award_id: r.award_id,
      scenario_id: r.scenario_id,
      confirmed_at: r.confirmed_at,
      actor: r.actor,
      exposure_inr: r.exposure_inr,
      acknowledged: JSON.parse(r.ack_json),
      superseded: r.superseded === 1,
      scenario: { constraints: JSON.parse(r.constraints_json), result: JSON.parse(r.result_json) },
    }));
  }

  /** Counts per table, for the reset check and the status line. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of [...SNAPSHOT_TABLES, ...DECISION_TABLES]) out[t] = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return out;
  }
}
