import { useEffect, useState } from "react";
import { api, type CellState, type VendorDetail } from "../api";
import { ReasonDialog } from "../components/Dialogs";
import { STATE_LABEL, StateIcon } from "../components/StateBadge";
import { Icon, Skeleton, vendorColor } from "../components/ui";
import { num } from "../format";

const STATE_ORDER: CellState[] = ["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED", "INFERRED", "NEEDS_REVIEW", "MISSING"];
const STATE_COLOR: Record<CellState, string> = {
  CONFIRMED: "var(--ok)", HIGH_CONF: "#4fae73", BUYER_VERIFIED: "var(--accent)", INFERRED: "var(--violet)", NEEDS_REVIEW: "var(--amber)", MISSING: "#cfd4dc",
};
const GATE_MARK: Record<string, string> = { PASS: "✓", FAIL: "✕", UNKNOWN: "?", WAIVED: "W" };

export function VendorPage({ set, vendorId, version, onChanged }: { set: string; vendorId: string; version: number; onChanged: (message?: string) => void }) {
  const [d, setD] = useState<VendorDetail | null>(null);
  const [waiving, setWaiving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    api.vendor(set, vendorId).then(setD).catch((e: Error) => setError(e.message));
  }, [set, vendorId, version]);
  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!d) return <Skeleton />;

  const total = Object.values(d.states).reduce((s, n) => s + n, 0) || 1;
  const validityBad = d.validity.status !== "valid";
  return (
    <div className="page">
      <a className="back" href="#/comparison">← Comparison</a>
      <div className="vhero">
        <div className="avatar" style={{ background: vendorColor(d.vendor.vendor_id) }}>{d.vendor.vendor_id}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 20 }}>{d.vendor.name}</h1>
          <div className="muted small">
            {d.vendor.city} · {d.vendor.contact_name}, {d.vendor.contact_email} · source{" "}
            <a href={api.fileUrl(set, d.vendor.file)} target="_blank" rel="noreferrer">{d.vendor.file.split("/").pop()}</a> <span className="tag">{d.vendor.format}</span>
          </div>
        </div>
        <a className="btn" href={`#/trace/${d.vendor.vendor_id}`}><Icon.trace /> Pipeline trace</a>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Coverage</div>
          <div className="value">{d.coverage.quoted} <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}>of {d.coverage.total} lines</span></div>
          <div className="statebar">
            {STATE_ORDER.filter((s) => (d.states[s] ?? 0) > 0).map((s) => (
              <span key={s} title={`${STATE_LABEL[s]}: ${d.states[s]}`} style={{ width: `${((d.states[s] ?? 0) / total) * 100}%`, background: STATE_COLOR[s] }} />
            ))}
          </div>
          <div className="statelegend">
            {STATE_ORDER.filter((s) => (d.states[s] ?? 0) > 0).map((s) => (
              <span key={s}><StateIcon state={s} size={11} /> {d.states[s]} {STATE_LABEL[s].toLowerCase()}</span>
            ))}
          </div>
        </div>
        <div className={`tile ${d.gates.overall === "PASS" || d.gates.overall === "WAIVED" ? "good" : d.gates.overall === "FAIL" ? "bad" : "warn"}`}>
          <div className="label">Quality gates</div>
          <div className="value"><span className={`pill ${d.gates.overall}`} style={{ fontSize: 14 }}>{d.gates.overall}</span></div>
          <div className="hint">{d.gates.headline}</div>
        </div>
        <div className={`tile ${validityBad ? "warn" : ""}`}>
          <div className="label">Validity</div>
          <div className="value" style={{ fontSize: 17 }}>{d.validity.status.replace(/_/g, " ")}</div>
          <div className="hint">{d.validity.valid_until ? `until ${d.validity.valid_until}` : "no date stated"}{d.excluded_by_default ? " · left out of awards by default" : ""}</div>
        </div>
        <div className={`tile ${d.late ? "warn" : ""}`}>
          <div className="label">Reply</div>
          <div className="value" style={{ fontSize: 17 }}>{d.late ? "Late" : "On time"}</div>
          <div className="hint">{d.discrepancies.length} discrepanc{d.discrepancies.length === 1 ? "y" : "ies"} · {d.injection.length} AI-directed text{d.injection.length === 1 ? "" : "s"}</div>
        </div>
      </div>

      <div className="grid2">
        <div>
          <div className="card">
            <h2>Questionnaire gates <span className="sub">a waiver keeps the failure visible and is logged</span></h2>
            {d.gates.gates.map((g) => {
              const r = g.waiver ? "WAIVED" : g.result;
              return (
                <div key={g.q_id} className="gate-row">
                  <span className={`gico ${r}`}>{GATE_MARK[r] ?? "?"}</span>
                  <span className="mono" style={{ paddingTop: 2 }}>{g.q_id}</span>
                  <div>
                    <div>{g.reason}</div>
                    {d.answers[g.q_id] && <div className="small faint">Answer: "{d.answers[g.q_id]}"</div>}
                    {g.waiver && <div className="small" style={{ color: "var(--accent-ink)" }}>Waived by {g.waiver.actor}: {g.waiver.reason}</div>}
                  </div>
                  <div>{g.result !== "PASS" && !g.waiver && <button className="btn small" onClick={() => setWaiving(g.q_id)}>Waive</button>}</div>
                </div>
              );
            })}
            {Object.keys(d.answers).length > 0 && (
              <details className="fold" style={{ marginTop: 12 }}>
                <summary>All answers, as written ({Object.keys(d.answers).length})</summary>
                <table className="plain">
                  <tbody>{Object.entries(d.answers).map(([q, a]) => <tr key={q}><td className="mono">{q}</td><td>{a}</td></tr>)}</tbody>
                </table>
              </details>
            )}
            {Object.keys(d.answers).length === 0 && <p className="muted" style={{ marginBottom: 0 }}>No questionnaire answers received.</p>}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Discrepancies</h2>
            {d.discrepancies.length === 0 ? <p className="muted" style={{ margin: 0 }}>None found.</p> : d.discrepancies.map((x, i) => (
              <div key={i} className="disc">
                <span className="tag warn" style={{ alignSelf: "flex-start" }}>{x.kind.replace(/_/g, " ")}</span>
                <span>{x.detail}</span>
              </div>
            ))}
            {d.injection.length > 0 && (
              <>
                <h3>Text addressed to AI systems: ignored and recorded</h3>
                {d.injection.map((t, i) => <div key={i} className="quoteblock bad">{t}</div>)}
              </>
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Terms, as stated</h2>
            {d.terms.filter((t) => t.value || t.snippet).map((t) => (
              <div key={t.term} className="term">
                <div className="k">{t.term.replace(/_/g, " ")}</div>
                <div>
                  <div className="v">{/^[a-z_]+$/.test(t.value) ? t.value.replace(/_/g, " ") : t.value}</div>
                  {t.snippet && <div className="small faint">"{t.snippet}"</div>}
                </div>
              </div>
            ))}
            {d.discounts.length > 0 && (
              <>
                <h3>Conditional discounts: evaluated as cases in the award</h3>
                {d.discounts.map((x, i) => (
                  <div key={i} className="disc">
                    <span className="tag">{x.pct}%</span>
                    <span>above Rs {x.threshold_inr.toLocaleString("en-IN")} <span className="small faint">"{x.snippet}"</span></span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Evidence</h2>
            {d.evidence_docs.length === 0 && <p className="muted" style={{ margin: 0 }}>No certificate or test report attached.</p>}
            {d.evidence_docs.map((e) => (
              <div key={e.file} className="evdoc">
                <Icon.file />
                <span className="muted" style={{ minWidth: 90 }}>{e.role.replace(/_/g, " ")}</span>
                <a href={api.fileUrl(set, e.file)} target="_blank" rel="noreferrer">{e.file.split("/").pop()}</a>
                {!e.read && <span className="pill UNKNOWN">not read</span>}
              </div>
            ))}
            {d.certificate && (
              <div className="evcard">
                <b>{d.certificate.cert_type}</b>{d.certificate.number ? ` no. ${d.certificate.number}` : ""} for {d.certificate.entity_name ?? "unnamed entity"}
                <div className="small muted">Valid {d.certificate.valid_from ?? "?"} to {d.certificate.valid_to ?? "?"}{d.certificate.issuer ? ` · issued by ${d.certificate.issuer}` : ""}</div>
                {d.certificate.scope && <div className="small faint">{d.certificate.scope}</div>}
              </div>
            )}
            {d.test_report && (
              <div className="evcard">
                <b>Test report {d.test_report.report_no}</b>
                <div className="small muted">{d.test_report.lab}, dated {d.test_report.report_date}</div>
                <table className="plain" style={{ marginTop: 6 }}>
                  <thead><tr><th>Ply</th><th>Flute</th><th className="num">Liner GSM</th><th className="num">BF</th></tr></thead>
                  <tbody>{d.test_report.samples.map((s, i) => <tr key={i}><td>{s.ply}</td><td>{s.flute}</td><td className="num">{s.liner_gsm}</td><td className="num">{s.bf}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            {d.report_findings.length > 0 && (
              <>
                <h3>Report against the RFx</h3>
                {d.report_findings.map((f, i) => <div key={i} className="disc"><span className="mono">{f.line_id}</span><span>{f.detail}</span></div>)}
              </>
            )}
          </div>

          {d.extras.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h2>Offers the RFx did not ask for <span className="sub">listed, never compared</span></h2>
              {d.extras.map((x, i) => (
                <div key={i} className="term">
                  <div className="k">{x.description}</div>
                  <div className="v num" style={{ textAlign: "left" }}>{x.rate.currency} {num(x.rate.value)} {x.rate.unit_as_written ?? ""}</div>
                </div>
              ))}
            </div>
          )}

          {(d.rejected.length > 0 || d.notes.length > 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <details>
                <summary>Extraction notes and rejected rows ({d.notes.length + d.rejected.length})</summary>
                {d.rejected.map((r) => <div key={r.row_id} className="small">Rejected {r.row_id}: {r.reason}</div>)}
                <ul className="items small">{d.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </details>
            </div>
          )}
        </div>
      </div>
      {waiving && (
        <ReasonDialog
          title={`Waive ${waiving} for ${d.vendor.vendor_id}`}
          explain="The gate counts as cleared for awards. The failure stays visible, and the waiver is logged with your reason."
          onSubmit={(reason) => api.waive(set, d.vendor.vendor_id, waiving, reason).then(() => onChanged(`${waiving} waived for ${d.vendor.vendor_id} and logged`))}
          onClose={() => setWaiving(null)}
        />
      )}
    </div>
  );
}
