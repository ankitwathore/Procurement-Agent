import { useEffect, useState } from "react";
import { api, type CellDetail, type SourceExcerpt } from "../api";
import { num, rupees } from "../format";
import { ReasonDialog } from "./Dialogs";
import { STATE_LABEL, StateBadge, StateIcon } from "./StateBadge";
import { Icon, VendorDot } from "./ui";

function Source({ set, s, vendor }: { set: string; s: SourceExcerpt; vendor: string }) {
  const loc = s.locator;
  const where =
    loc.type === "xlsx" ? `${String(loc.sheet)}!${String(loc.cell)}` :
    loc.type === "pdf" ? `page ${String(loc.page)}` :
    loc.type === "docx" ? (typeof loc.paragraph_idx === "number" ? `paragraph ${String(loc.paragraph_idx)}` : `table ${String(loc.table_idx)} row ${String(loc.row)}`) :
    loc.type === "email" ? `characters ${String(loc.char_start)} to ${String(loc.char_end)}` :
    loc.type === "image" ? `photo${typeof loc.row === "number" ? `, row ${String(loc.row)}` : ""}` : String(loc.type);
  const box = Array.isArray(loc.box) ? (loc.box as number[]) : null;
  return (
    <div className="srcblock">
      <div className="srchead">
        <Icon.file />
        <span>{s.kind}</span>
        <span className="faint">·</span>
        <span className="mono">{where}</span>
        <span className="spacer" />
        <a href={api.fileUrl(set, s.file)} target="_blank" rel="noreferrer">Open {s.file.split("/").pop()}</a>
      </div>
      {s.snippet && <div className="verbatim"><span className="faint small">Verbatim</span> <span className="snippet">{s.snippet}</span></div>}
      {s.note && <div className="muted small" style={{ padding: "0 10px 8px" }}>{s.note}</div>}
      {box && <img className="crop" src={api.imageUrl(set, vendor, box)} alt={`Crop of the photo around ${where}`} />}
      {s.lines.length > 0 && (
        <div className="source">
          {s.lines.map((l, i) => (
            <pre key={i} className={`${l.highlight ? "hl" : ""} ${l.muted ? "quoted" : ""}`}>{l.text || " "}</pre>
          ))}
        </div>
      )}
      {s.lines.some((l) => l.muted) && <div className="small faint" style={{ padding: "6px 10px" }}>Grey lines are quoted history: never a source.</div>}
    </div>
  );
}

export function CellPanel({ set, vendor, line, onClose, onConfirm, onChanged, version }: { set: string; vendor: string; line: string; onClose: () => void; onConfirm: (id: string) => void; onChanged: (message?: string) => void; version: number }) {
  const [d, setD] = useState<CellDetail | null>(null);
  const [acting, setActing] = useState<"verify" | "override" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    api.cell(set, vendor, line).then(setD).catch((e: Error) => setError(e.message));
  }, [set, vendor, line, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vsLast = d && d.summary.point !== null && d.line.baseline_price_inr > 0 ? d.summary.point / d.line.baseline_price_inr - 1 : null;
  const ranged = d && d.summary.point !== null && d.summary.low !== null && d.summary.high !== null && d.summary.high - d.summary.low > 1e-9;

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <aside className="sheet" aria-label={`Cell ${vendor} ${line}`}>
        <div className="sheet-top">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <VendorDot id={vendor} /> {vendor}{d ? ` · ${d.vendor.name}` : ""} · {line}
            </div>
            <h2>{d ? d.line.description : "Loading"}</h2>
            {d && <div className="small muted">{d.line.spec_text} · per {d.line.base_uom} · {d.line.annual_qty.toLocaleString("en-IN")} a year</div>}
          </div>
          <a className="btn small" href={`#/trace/${vendor}/${line}`} onClick={onClose}><Icon.trace /> Trace</a>
          <button className="btn small ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sheet-body">
          {error && <div className="error">{error}</div>}
          {!d ? (
            <>{[80, 60, 90, 70].map((w, i) => <div key={i} className="skeleton" style={{ width: `${w}%` }} />)}</>
          ) : (
            <>
              <div className="hero">
                <span className="big">{d.summary.point === null ? (d.summary.state === "MISSING" ? "Not quoted" : "No usable price") : `Rs ${num(d.summary.point)}`}</span>
                <StateBadge state={d.summary.state} />
              </div>
              {d.summary.point !== null && (
                <div className="facts">
                  <div><span>Range</span><b>{ranged ? `${num(d.summary.low!)} to ${num(d.summary.high!)}` : "exact"}</b></div>
                  <div><span>Annual at point</span><b>{rupees(d.summary.point * d.line.annual_qty)}</b></div>
                  <div><span>Last year</span><b>{num(d.line.baseline_price_inr)}{vsLast !== null && <em className={vsLast > 0 ? "up" : "down"}> {vsLast > 0 ? "+" : ""}{(vsLast * 100).toFixed(1)}%</em>}</b></div>
                </div>
              )}
              <div className={`why ${d.summary.state}`}>
                <div className="why-t"><StateIcon state={d.summary.state} /> {STATE_LABEL[d.summary.state]}</div>
                {d.summary.reason}
                {d.summary.state === "MISSING" && <div className="small" style={{ marginTop: 4 }}>Not quoted. Never filled in.</div>}
                {d.summary.state === "NEEDS_REVIEW" && <div className="small" style={{ marginTop: 4 }}>Needs a decision. We will not pick for you.</div>}
              </div>
              {d.summary.flags.length > 0 && <div style={{ marginBottom: 8 }}>{d.summary.flags.map((f) => <span key={f} className="flag">{f.replace(/_/g, " ")}</span>)}</div>}
              {d.confirmation && (
                <div className="banner" style={{ margin: "8px 0" }}>
                  <span style={{ flex: 1 }}>{d.confirmation.question}</span>
                  <button className="btn small primary" onClick={() => onConfirm(d.confirmation!.id)}>Confirm or reject</button>
                </div>
              )}
              {d.summary.state !== "MISSING" && (
                <div className="actions">
                  {d.summary.point !== null && d.rate_component?.state !== "BUYER_VERIFIED" && <button className="btn small" onClick={() => setActing("verify")}><StateIcon state="BUYER_VERIFIED" /> Verify as correct</button>}
                  <button className="btn small" onClick={() => setActing("override")}>{d.summary.point === null ? "Enter the rate" : "Override the rate"}</button>
                  <span className="small faint">Every decision needs a reason and is logged.</span>
                </div>
              )}

              {d.quote && d.quote.components.length > 0 && (
                <section>
                  <h3>How the number was built</h3>
                  <div className="build">
                    {d.quote.components.map((c) => (
                      <div key={c.kind} className="build-row">
                        <StateIcon state={c.state} />
                        <div>
                          <div className="t">{c.kind === "base_rate" ? "Vendor rate" : "Freight"}</div>
                          <div className="small faint">{STATE_LABEL[c.state]} · {c.basis.replace(/_/g, " ")}</div>
                        </div>
                        <div className="num">
                          <b>{num(c.point)}</b>
                          {c.high - c.low > 1e-9 && <div className="small faint">{num(c.low)} to {num(c.high)}</div>}
                        </div>
                      </div>
                    ))}
                    <div className="build-row total">
                      <span />
                      <div className="t">Landed per {d.line.base_uom}</div>
                      <div className="num"><b>{d.summary.point === null ? "-" : num(d.summary.point)}</b></div>
                    </div>
                  </div>
                  {d.quote.chain.length > 0 && (
                    <ol className="chain">
                      {d.quote.chain.map((c, i) => <li key={i}>{c}</li>)}
                    </ol>
                  )}
                  {d.quote.suggested_reading && (
                    <div className="warn" style={{ marginTop: 8 }}>
                      Probable reading: Rs {num(d.quote.suggested_reading.suggested_rate)} (factor {d.quote.suggested_reading.factor} against the {d.quote.suggested_reading.against} {num(d.quote.suggested_reading.reference)}). Shown, never applied.
                    </div>
                  )}
                  {d.quote.arithmetic?.fails && (
                    <div className="warn" style={{ marginTop: 8 }}>
                      The vendor's amount {num(d.quote.arithmetic.stated)} is not quantity x rate ({num(d.quote.arithmetic.expected)}), {d.quote.arithmetic.diff_pct.toFixed(1)}% apart.
                    </div>
                  )}
                </section>
              )}

              {(d.sources.length > 0 || d.readings.length > 0) && (
                <section>
                  <h3>Source</h3>
                  {d.sources.filter((s) => s.component === "base_rate").map((s, i) => <Source key={i} set={set} s={s} vendor={vendor} />)}
                  {d.sources.length === 0 && d.readings.map((r, i) => (
                    <div key={i} style={{ marginBottom: 10 }}>
                      <div className="small muted" style={{ marginBottom: 4 }}>Pass {r.pass} read {r.currency} {r.value ?? "?"} {r.unit ?? ""}</div>
                      <Source set={set} s={r.source} vendor={vendor} />
                    </div>
                  ))}
                  {d.sources.filter((s) => s.component === "freight").map((s, i) => (
                    <div key={i} className="small muted" style={{ marginTop: 8 }}>Freight basis from the vendor: <span className="snippet">{s.snippet || "not stated"}</span></div>
                  ))}
                </section>
              )}

              {d.quote?.reconciliation && (
                <section>
                  <details className="fold">
                    <summary>Both passes: {d.quote.reconciliation.status.replace("_", " ")}{d.quote.reconciliation.adjudication ? `, adjudicated ${d.quote.reconciliation.adjudication.decision}` : ""}</summary>
                    <p className="muted">{d.quote.reconciliation.detail}</p>
                    <table className="plain">
                      <thead><tr><th>Pass</th><th className="num">Value</th><th>Currency</th><th>Unit</th><th>Snippet</th></tr></thead>
                      <tbody>
                        {d.quote.reconciliation.readings.map((r, i) => (
                          <tr key={i}><td>{r.pass}</td><td className="num">{r.value ?? "-"}</td><td>{r.currency || "-"}</td><td>{r.unit ?? "-"}</td><td className="mono">{r.snippet}</td></tr>
                        ))}
                      </tbody>
                    </table>
                    {d.quote.reconciliation.adjudication && (
                      <p><b>Adjudicator ({d.quote.reconciliation.adjudication.model ?? "model"}):</b> {d.quote.reconciliation.adjudication.reasoning}</p>
                    )}
                  </details>
                </section>
              )}

              {d.quote && (d.quote.spec_flags.length > 0 || d.quote.spec_unstated.length > 0) && (
                <section>
                  <h3>Spec offered vs required</h3>
                  {d.quote.spec_flags.map((f, i) => (
                    <div key={i} className="specrow"><span className="tag warn">{f.kind.replace(/_/g, " ")}</span> {f.detail} <span className="faint">({f.source === "test_report" ? "test report" : "offer"})</span></div>
                  ))}
                  {d.quote.spec_unstated.length > 0 && <div className="muted small">Not stated by the vendor: {d.quote.spec_unstated.join(", ")}</div>}
                </section>
              )}

              {d.quote && d.quote.hidden_values.length > 0 && (
                <section>
                  <h3>Hidden values</h3>
                  {d.quote.hidden_values.map((h, i) => (
                    <div key={i} className="warn" style={{ marginBottom: 6 }}>{h.value ?? "-"} in a hidden {String(h.locator.cell ?? "")} cell ("{h.snippet}"). Evidence only, never the price.</div>
                  ))}
                </section>
              )}

              {d.quote && d.quote.assumptions.length > 0 && (
                <section>
                  <details className="fold" open>
                    <summary>Assumptions ({d.quote.assumptions.length})</summary>
                    <ul className="items">{d.quote.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  </details>
                </section>
              )}

              {d.quote?.history && d.quote.history.length > 0 && (
                <section>
                  <h3>Earlier values</h3>
                  {d.quote.history.map((h, i) => (
                    <div key={i} className="hist">
                      <StateIcon state={h.state} />
                      <span className="strike">{h.landed ? `Rs ${num(h.landed.point)}` : "no price"}</span>
                      <span className="muted small">{STATE_LABEL[h.state]}, replaced by {h.replaced_by} on {h.replaced_at.slice(0, 10)}</span>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </aside>
      {acting && d && (
        <ReasonDialog
          title={acting === "verify" ? `Verify ${vendor} ${line} as correct` : `${d.summary.point === null ? "Enter" : "Override"} the rate for ${vendor} ${line}`}
          explain={
            acting === "verify"
              ? "The rate as read becomes buyer verified. The price does not change; freight estimates stay as they are."
              : `The rate you enter (INR per ${d.line.base_uom}, ex GST, before freight) replaces the one read from the document and is buyer verified. Freight is added again per the vendor's terms.`
          }
          valueLabel={acting === "override" ? `Rate, INR per ${d.line.base_uom}` : undefined}
          onSubmit={(reason, value) =>
            (acting === "verify" ? api.verify(set, vendor, line, reason) : api.override(set, vendor, line, value as number, reason))
              .then(() => onChanged(acting === "verify" ? `${vendor} ${line} verified and logged` : `${vendor} ${line} rate replaced and logged`))
          }
          onClose={() => setActing(null)}
        />
      )}
    </>
  );
}
