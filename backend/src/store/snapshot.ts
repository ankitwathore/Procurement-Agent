import { QUESTIONS } from "../data/rfx.js";
import { VENDOR_REGISTRY } from "../data/vendors.js";
import { vendorView, type Session } from "../server/views.js";
import { quoteId, SNAPSHOT_TABLES, type Store } from "./store.js";

/**
 * Writes the current state of a session into the spec's pipeline tables (spec 8.2): RFx, lines, questions, vendors,
 * artifacts, quotes and their components, terms, answers, certificates and discrepancies. Replaced wholesale each
 * time; buyer decisions live in their own tables and are already applied to the session.
 */
export function writeSnapshot(store: Store, s: Session): void {
  const db = store.db;
  const ins = (table: string, values: unknown[]) => db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`).run(...values.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)));
  const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  db.transaction(() => {
    for (const t of SNAPSHOT_TABLES) db.exec(`DELETE FROM ${t}`);
    const r = s.rfx;
    ins("rfx", [r.rfx_id, r.title, "corrugated packaging", "Kaveri Home Appliances", "Chakan plant", s.config.currency_of_record, r.issue_date, r.due_date, j(r), "evaluating"]);
    for (const l of s.lines) ins("rfx_line", [l.line_id, r.rfx_id, null, l.description, j(l.spec), l.base_uom, l.annual_qty, l.weight_kg_per_uom, j(l.conversion_hints), l.baseline_price_inr, "delivered ex GST", null, s.config.gst.default_rate_pct]);
    for (const q of QUESTIONS) ins("question", [q.q_id, r.rfx_id, q.text, q.type, q.is_gate, q.file_required, j({ pass_check: q.pass_check, claim_check: q.claim_check, pass_rule: q.pass_rule }), null]);
    for (const v of VENDOR_REGISTRY) ins("vendor", [v.vendor_id, v.name, v.city, v.contact_email, j(v.aliases)]);
    for (const v of s.vendors) {
      const sub = `${v.vendor_id}:1`;
      ins("submission", [sub, r.rfx_id, v.vendor_id, 1, null, v.doc.kind === "email" || v.doc.kind === "image" ? "email" : "upload", 1, null, null, null, v.assessment.late]);
      ins("artifact", [`${v.vendor_id}:quote`, sub, v.file.split("/").pop(), v.file, null, v.doc.kind, "DONE", null, null, "quote"]);
      for (const d of v.evidence_docs) ins("artifact", [`${v.vendor_id}:${d.role}`, sub, d.file.split("/").pop(), d.file, null, /\.jpe?g$/i.test(d.file) ? "image" : "pdf", d.read ? "DONE" : "RECEIVED", null, null, d.role]);
      for (const q of v.quotes) {
        const id = quoteId(v.vendor_id, q.line_id);
        const rate = q.components.find((c) => c.kind === "base_rate");
        ins("quote", [id, r.rfx_id, v.vendor_id, q.line_id, sub, `${v.vendor_id}:quote`, null, null, null, null, null, rate?.point ?? null, q.landed?.point ?? null, q.landed?.low ?? null, q.landed?.high ?? null, q.state, q.state_reason, null, j(q.spec_flags), null, null, j(q.reconciliation), j(rate?.provenance ?? null), j(q.assumptions), 1]);
        q.components.forEach((c, i) => ins("quote_component", [`${id}:${c.kind}:${i}`, id, c.kind, c.point, c.low, c.high, c.state, c.basis, j(c.provenance)]));
      }
      const t = v.extraction.vendor_terms;
      ins("vendor_terms", [v.vendor_id, sub, null, t.freight_basis?.value ?? "unstated", null, t.gst_basis?.value ?? "unstated", v.assessment.validity.valid_until, null, null, j(v.assessment.conditional_discounts), null, t.fx_clause?.value_text ?? null, null, j(t), v.assessment.validity.status]);
      for (const g of v.gates.gates) ins("questionnaire_answer", [v.vendor_id, g.q_id, v.answers[g.q_id] ?? null, null, null, g.waiver ? "WAIVED" : g.result, null, null, g.reason]);
      for (const [q, a] of Object.entries(v.answers)) if (!v.gates.gates.some((g) => g.q_id === q)) ins("questionnaire_answer", [v.vendor_id, q, a, null, null, null, null, null, null]);
      if (v.certificate) ins("certificate_check", [`${v.vendor_id}:iso`, v.vendor_id, `${v.vendor_id}:certificate`, v.certificate.cert_type, v.certificate.issuer, v.certificate.entity_name, v.certificate.valid_from, v.certificate.valid_to, v.certificate.scope, null, null]);
      (vendorView(s, v.vendor_id)?.discrepancies ?? []).forEach((d, i) => ins("discrepancy", [`${v.vendor_id}:${i + 1}`, v.vendor_id, d.kind, null, d.detail, null, null, null, "open", null]));
      (v.traces ?? []).forEach((t, i) => ins("run_trace", [`${v.vendor_id}:${i + 1}`, t.file === v.file ? `${v.vendor_id}:quote` : t.file, t.step, t.model, t.prompt_version, j({ stop_reason: t.stop_reason, fallback_used: t.fallback_used, cache_read: t.cache_read, cache_write: t.cache_write }), t.tokens_in, t.tokens_out, t.cost_usd, t.ms, t.at]));
    }
  })();
}
