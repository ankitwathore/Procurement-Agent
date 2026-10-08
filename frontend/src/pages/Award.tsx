import { useEffect, useMemo, useState } from "react";
import { api, type Award, type AwardRecord } from "../api";
import { STATE_LABEL, StateIcon } from "../components/StateBadge";
import { Skeleton, VendorDot, vendorColor } from "../components/ui";
import { num, pct, rupees } from "../format";

const OPTIONS = {
  gate_policy: { label: "Quality gates", opts: [["cleared_only", "Cleared only"], ["include_unknown", "Include unknown"], ["ignore_gates", "Ignore"]] },
  spec_policy: { label: "Spec", opts: [["strict", "Strict"], ["allow_deviations", "Allow deviations"]] },
  cell_policy: { label: "Prices", opts: [["risk_adjusted", "Risk adjusted"], ["point", "Point"], ["trusted_only", "Trusted only"]] },
  include_expired: { label: "Lapsed quotes", opts: [["false", "Out"], ["true", "Include"]] },
} as const;

const GATE_TONE = { allowed: "good", acknowledge: "warn", blocked: "bad" } as const;
const GATE_TITLE = { allowed: "Ready to confirm", acknowledge: "Confirm with acknowledgment", blocked: "Blocked" } as const;

export function AwardPage({ set, version, onChanged }: { set: string; version: number; onChanged: (message?: string) => void }) {
  const [q, setQ] = useState<Record<string, string>>({ gate_policy: "cleared_only", spec_policy: "strict", cell_policy: "risk_adjusted", include_expired: "false" });
  const [a, setA] = useState<Award | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [history, setHistory] = useState<(AwardRecord & { stale: boolean })[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    api.award(set, q).then(setA).catch((e: Error) => setError(e.message));
    api.awards(set).then(setHistory).catch(() => setHistory([]));
    setAcks(new Set());
    setConfirmError(null);
  }, [set, q, version]);
  useEffect(() => {
    api.comparison(set).then((c) => setNames(Object.fromEntries(c.lines.map((l) => [l.line_id, l.description])))).catch(() => setNames({}));
  }, [set]);
  const policy = { gate_policy: q.gate_policy, spec_policy: q.spec_policy, cell_policy: q.cell_policy, include_expired_quotes: q.include_expired === "true" };
  const confirm = () => api.confirmAward(set, policy, [...acks]).then(() => onChanged("Award confirmed and logged")).catch((e: Error) => setConfirmError(e.message));
  const byVendor = useMemo(() => {
    const m: Record<string, number> = {};
    for (const x of a?.result.assignments ?? []) if (x.vendor_id) m[x.vendor_id] = (m[x.vendor_id] ?? 0) + 1;
    return m;
  }, [a]);
  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!a) return <Skeleton />;
  const r = a.result;
  const tone = GATE_TONE[a.gate.status];
  const allAcked = a.gate.required_acknowledgments.every((u) => acks.has(u.id));

  return (
    <div className="page">
      <div className="pagehead">
        <div>
          <div className="eyebrow">Award</div>
          <h1>Who gets which line</h1>
        </div>
        <span className="spacer" />
        <span className="muted small">{Object.keys(byVendor).length} vendor{Object.keys(byVendor).length === 1 ? "" : "s"} · {r.assignments.length - r.unfillable.length} of {r.assignments.length} lines filled</span>
      </div>

      <div className="scenario card" style={{ padding: "10px 14px" }}>
        {Object.entries(OPTIONS).map(([k, o]) => (
          <div key={k} className="scn">
            <span className="lbl">{o.label}</span>
            <span className="seg">
              {o.opts.map(([value, label]) => (
                <button key={value} className={q[k] === value ? "on" : ""} onClick={() => setQ({ ...q, [k]: value })}>{label}</button>
              ))}
            </span>
          </div>
        ))}
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Cost, point</div>
          <div className="value">{rupees(r.cost.point)}</div>
          <div className="hint">range {rupees(r.cost.low)} to {rupees(r.cost.high)}</div>
        </div>
        <div className={`tile ${r.savings_pct > 0 ? "good" : "warn"}`}>
          <div className="label">Against last year</div>
          <div className="value">{r.savings_pct > 0 ? "−" : "+"}{pct(Math.abs(r.savings_pct))}</div>
          <div className="hint">{rupees(Math.abs(r.savings))} {r.savings >= 0 ? "saved" : "more"} on {rupees(r.baseline_value)} (lines filled)</div>
        </div>
        <div className={`tile ${a.gate.exposure_inr > 0 ? "warn" : "good"}`}>
          <div className="label">Resting on unconfirmed figures</div>
          <div className="value">{rupees(a.gate.exposure_inr)}</div>
          <div className="hint">{pct(a.gate.exposure_pct)} of the award · {a.gate.unsafe_component_count} component{a.gate.unsafe_component_count === 1 ? "" : "s"}</div>
        </div>
        <div className={`tile ${tone}`}>
          <div className="label">Award gate</div>
          <div className="value"><span className={`pill ${a.gate.status}`} style={{ fontSize: 14 }}>{a.gate.status}</span></div>
          <div className="hint">{a.gate.headline}</div>
        </div>
      </div>

      {(a.gate.blocked_reasons.length > 0 || a.gate.warnings.length > 0 || r.notes.length > 0) && (
        <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
          {a.gate.blocked_reasons.map((x, i) => <div key={i} className="banner bad">{x}</div>)}
          {a.gate.warnings.map((x, i) => <div key={i} className="banner warn">{x}</div>)}
          {r.notes.map((x, i) => <div key={i} className="banner">{x}</div>)}
        </div>
      )}

      <div className="grid2">
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "14px 16px 4px" }}><h2>Lines</h2></div>
          <table className="plain">
            <thead><tr><th style={{ paddingLeft: 16 }}>Line</th><th>Vendor</th><th className="num">Landed</th><th>State</th><th>Notes</th></tr></thead>
            <tbody>
              {r.assignments.map((x) => (
                <tr key={x.line_id}>
                  <td style={{ paddingLeft: 16 }}><span className="mono faint">{x.line_id}</span> {names[x.line_id] ?? ""}</td>
                  <td>{x.vendor_id ? <span className="vchip"><VendorDot id={x.vendor_id} />{x.vendor_id}</span> : <span className="pill FAIL">unfillable</span>}</td>
                  <td className="num">{num(x.price)}</td>
                  <td>{x.quote && <span className="small" title={STATE_LABEL[x.quote.state]}><StateIcon state={x.quote.state} /> {STATE_LABEL[x.quote.state]}</span>}</td>
                  <td className="small muted">
                    {x.single_source && <span className="tag warn" style={{ marginRight: 4 }}>single source</span>}
                    {x.rejected.length > 0 && <details><summary>{x.rejected.length} not eligible</summary>{x.rejected.map((y, i) => <div key={i}>{y.vendor_id}: {y.reason}</div>)}</details>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <div className="card">
            <h2>Allocation by vendor</h2>
            <div className="stackbar">
              {r.vendors.filter((v) => v.share_pct > 0).map((v) => (
                <span key={v.vendor_id} title={`${v.vendor_id}: ${pct(v.share_pct)}`} style={{ width: `${v.share_pct}%`, background: vendorColor(v.vendor_id) }} />
              ))}
            </div>
            {r.vendors.map((v) => (
              <div key={v.vendor_id} className="legend-row">
                <VendorDot id={v.vendor_id} />
                <div>
                  <b>{v.vendor_id}</b> <span className="muted small">{v.lines} line{v.lines === 1 ? "" : "s"}</span>
                  {v.discount && <div className="small muted">{v.discount.pct}% discount above {rupees(v.discount.threshold_inr)}: {v.discount.applies ? `earned, ${rupees(v.discount.amount)}` : `not earned (${rupees(v.discount.margin)} short)`}</div>}
                </div>
                <div className="num"><b>{rupees(v.value_point)}</b> <span className="muted small">{pct(v.share_pct)}</span></div>
              </div>
            ))}
            {r.excluded_vendors.length > 0 && (
              <>
                <h3>Not eligible</h3>
                {r.excluded_vendors.map((x) => <div key={x.vendor_id} className="disc"><span className="vchip"><VendorDot id={x.vendor_id} />{x.vendor_id}</span><span className="muted">{x.reason}</span></div>)}
              </>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Resolve first <span className="sub">largest unconfirmed amounts in this award</span></h2>
            {a.gate.resolve_first.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing unconfirmed in this award.</p> : a.gate.resolve_first.map((u) => (
              <div key={u.id} className="legend-row">
                <StateIcon state={u.state} />
                <div><span className="vchip"><VendorDot id={u.vendor_id} />{u.vendor_id}</span> <span className="mono">{u.line_id}</span> <span className="muted small">{u.kind === "freight" ? "freight" : "rate"}, {STATE_LABEL[u.state].toLowerCase()}</span></div>
                <div className="num"><b>{rupees(u.value_inr)}</b></div>
              </div>
            ))}
          </div>

          <div className={`card confirm-card ${tone}`} style={{ marginTop: 16 }}>
            <h2>{GATE_TITLE[a.gate.status]}</h2>
            {a.gate.status === "blocked" ? (
              <p className="error" style={{ margin: 0 }}>{a.gate.blocked_reasons.join(" ")} Resolve the items above, or change the scenario.</p>
            ) : (
              <>
                {a.gate.required_acknowledgments.length > 0 && (
                  <>
                    <p className="small muted" style={{ marginTop: 0 }}>Tick each unconfirmed figure this award rests on ({acks.size} of {a.gate.required_acknowledgments.length}):</p>
                    {a.gate.required_acknowledgments.map((u) => (
                      <label key={u.id} className="ack">
                        <input type="checkbox" checked={acks.has(u.id)} onChange={(e) => { const n = new Set(acks); if (e.target.checked) n.add(u.id); else n.delete(u.id); setAcks(n); }} />
                        <span><b>{u.vendor_id} {u.line_id}</b> {u.kind === "freight" ? "freight" : "rate"} ({STATE_LABEL[u.state].toLowerCase()}), {rupees(u.value_inr)}</span>
                      </label>
                    ))}
                    <div className="row" style={{ marginTop: 4 }}>
                      <button className="linkbtn small" onClick={() => setAcks(new Set(a.gate.required_acknowledgments.map((u) => u.id)))}>Tick all</button>
                    </div>
                  </>
                )}
                <div className="row">
                  <button className="btn primary" disabled={!allAcked} onClick={confirm}>Confirm award · {rupees(r.cost.point)}</button>
                  <span className="small muted">{a.gate.headline}</span>
                </div>
                {confirmError && <div className="error" style={{ marginTop: 6 }}>{confirmError}</div>}
              </>
            )}
            {history.length > 0 && (
              <>
                <h3>Confirmed awards</h3>
                {history.map((h) => (
                  <div key={h.award_id} className="hrow">
                    <span className={`pill ${h.superseded ? "superseded" : h.stale ? "stale" : "current"}`}>{h.superseded ? "superseded" : h.stale ? "stale" : "current"}</span>
                    <div>
                      <b>{rupees(h.scenario.result.cost.point)}</b> <span className="muted small">by {h.actor}, {h.confirmed_at.slice(0, 16).replace("T", " ")}</span>
                      <div className="small faint">{rupees(h.exposure_inr)} on unconfirmed figures, {h.acknowledged.length} acknowledged{!h.superseded && h.stale ? " · the data changed since" : ""}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
