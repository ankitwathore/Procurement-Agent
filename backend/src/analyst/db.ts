import Database from "better-sqlite3";
import { isSafe } from "../model/states.js";
import type { Session } from "../server/views.js";
import { comparisonView, vendorView } from "../server/views.js";

/**
 * The analyst's read-only database (spec 14.3): an in-memory SQLite holding only the curated views, built from the
 * session, with writes switched off. A query must be one SELECT (or WITH ... SELECT); results are capped. There are no
 * base tables to reach, so the guard is structural. Vendor-written text is not in these views; it comes only through
 * get_source, wrapped as untrusted.
 */

export const VIEWS: Record<string, string> = {
  v_rfx_lines: "line_id, description, spec, base_uom, annual_qty, baseline_price_inr, weight_kg_per_uom",
  v_quote_current: "vendor_id, line_id, state, landed_point, landed_low, landed_high, rate_inr, unsafe (1 if any component is unsafe), annual_value_point, reason, flags",
  v_components: "vendor_id, line_id, kind (base_rate | freight), state, point, low, high, basis",
  v_vendor_summary: "vendor_id, name, city, format, freight_basis, validity_status, valid_until, late (0/1), excluded_by_default (0/1), gate_overall, quoted_lines, trusted_value, total_value",
  v_coverage: "vendor_id, quoted, missing, needs_review, total",
  v_gate_status: "vendor_id, q_id, result, reason",
  v_discrepancy: "vendor_id, kind, detail",
  v_exposure_by_vendor: "vendor_id, unsafe_components, exposure_inr (annual quantity x max(point, high) over all of the vendor's unsafe components)",
};

export const ROW_LIMIT = 500;

export function buildDb(s: Session): Database.Database {
  const db = new Database(":memory:");
  const safe = s.config.exposure.safe_states;
  const cmp = comparisonView(s);
  db.exec(`
    CREATE TABLE v_rfx_lines (line_id TEXT, description TEXT, spec TEXT, base_uom TEXT, annual_qty REAL, baseline_price_inr REAL, weight_kg_per_uom REAL);
    CREATE TABLE v_quote_current (vendor_id TEXT, line_id TEXT, state TEXT, landed_point REAL, landed_low REAL, landed_high REAL, rate_inr REAL, unsafe INTEGER, annual_value_point REAL, reason TEXT, flags TEXT);
    CREATE TABLE v_components (vendor_id TEXT, line_id TEXT, kind TEXT, state TEXT, point REAL, low REAL, high REAL, basis TEXT);
    CREATE TABLE v_vendor_summary (vendor_id TEXT, name TEXT, city TEXT, format TEXT, freight_basis TEXT, validity_status TEXT, valid_until TEXT, late INTEGER, excluded_by_default INTEGER, gate_overall TEXT, quoted_lines INTEGER, trusted_value REAL, total_value REAL);
    CREATE TABLE v_coverage (vendor_id TEXT, quoted INTEGER, missing INTEGER, needs_review INTEGER, total INTEGER);
    CREATE TABLE v_gate_status (vendor_id TEXT, q_id TEXT, result TEXT, reason TEXT);
    CREATE TABLE v_discrepancy (vendor_id TEXT, kind TEXT, detail TEXT);
    CREATE TABLE v_exposure_by_vendor (vendor_id TEXT, unsafe_components INTEGER, exposure_inr REAL);
  `);
  const ins = (table: string, n: number) => db.prepare(`INSERT INTO ${table} VALUES (${new Array(n).fill("?").join(",")})`);
  const rfx = ins("v_rfx_lines", 7);
  for (const l of cmp.lines) {
    const line = s.lines.find((x) => x.line_id === l.line_id)!;
    rfx.run(l.line_id, l.description, l.spec, l.base_uom, l.annual_qty, l.baseline, line.weight_kg_per_uom);
  }
  const qi = ins("v_quote_current", 11);
  const ci = ins("v_components", 8);
  const ei = ins("v_exposure_by_vendor", 3);
  for (const v of s.vendors) {
    let n = 0;
    let exp = 0;
    for (const line of s.lines) {
      const q = v.quotes.find((x) => x.line_id === line.line_id);
      const c = cmp.lines.find((x) => x.line_id === line.line_id)!.cells[v.vendor_id]!;
      qi.run(v.vendor_id, line.line_id, c.state, c.point, c.low, c.high, c.rate, c.unsafe ? 1 : 0, c.point === null ? null : c.point * line.annual_qty, c.reason, c.flags.join(","));
      for (const comp of q?.components ?? []) {
        ci.run(v.vendor_id, line.line_id, comp.kind, comp.state, comp.point, comp.low, comp.high, comp.basis);
        if (!isSafe(comp.state, safe)) {
          n++;
          exp += Math.max(comp.point, comp.high) * line.annual_qty;
        }
      }
    }
    ei.run(v.vendor_id, n, exp);
  }
  const vs = ins("v_vendor_summary", 13);
  const cov = ins("v_coverage", 5);
  const gs = ins("v_gate_status", 4);
  const dis = ins("v_discrepancy", 3);
  for (const v of cmp.vendors) {
    const sv = s.vendors.find((x) => x.vendor_id === v.vendor_id)!;
    vs.run(v.vendor_id, v.name, v.city, v.format, v.freight, sv.assessment.validity.status, sv.assessment.validity.valid_until, sv.assessment.late ? 1 : 0, sv.assessment.excluded_by_default ? 1 : 0, v.gate, v.coverage.quoted, v.trusted_value, v.total_value);
    const states = sv.quotes.map((q) => q.state);
    cov.run(v.vendor_id, v.coverage.quoted, states.filter((x) => x === "MISSING").length, states.filter((x) => x === "NEEDS_REVIEW").length, v.coverage.total);
    for (const g of sv.gates.gates) gs.run(v.vendor_id, g.q_id, g.result, g.reason);
    for (const d of vendorView(s, v.vendor_id)!.discrepancies) dis.run(v.vendor_id, d.kind, d.detail);
  }
  db.pragma("query_only = ON");
  return db;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** Runs one guarded read-only query. Errors are messages the model can use to retry. */
export function guardedQuery(db: Database.Database, sql: string): QueryResult {
  const q = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(q)) throw new Error("only a single SELECT (or WITH ... SELECT) is allowed");
  let stmt: Database.Statement;
  try {
    stmt = db.prepare(`SELECT * FROM (${q}) LIMIT ${ROW_LIMIT + 1}`);
  } catch (err) {
    throw new Error(`query rejected: ${(err as Error).message}. Views: ${Object.keys(VIEWS).join(", ")}`);
  }
  if (!stmt.reader) throw new Error("only queries that return rows are allowed");
  const rows = stmt.raw(true).all() as unknown[][];
  const columns = stmt.columns().map((c) => c.name);
  return { columns, rows: rows.slice(0, ROW_LIMIT), truncated: rows.length > ROW_LIMIT };
}
