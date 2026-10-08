import { useEffect, useState } from "react";
import { Icon, Skeleton, VendorDot } from "../components/ui";

/** The trace page (spec 18.8): every step behind a vendor's data, or behind one cell, with the model calls' cost. */

interface Call {
  step: string;
  file: string;
  model: string | null;
  fallback_used: boolean;
  stop_reason: string | null;
  prompt_version: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_usd: number | null;
  ms: number | null;
  at: string | null;
}

interface Stage {
  id: string;
  title: string;
  call: Call | null;
  summary: string;
  table?: { columns: string[]; rows: (string | number | null)[][] };
  items?: string[];
}

interface Trace {
  vendor_id: string;
  file: string;
  run_file: string;
  line: string | null;
  totals: { calls: number; cost_usd: number; ms: number };
  stages: Stage[];
}

function CallLine({ c }: { c: Call }) {
  const n = (x: number | null) => x?.toLocaleString("en-IN") ?? "-";
  return (
    <div className="callchips">
      <span className="cc model">{c.model ?? "model"}{c.fallback_used ? " (fallback)" : ""}</span>
      <span className="cc">{c.ms !== null ? `${(c.ms / 1000).toFixed(1)} s` : "-"}</span>
      <span className="cc">in {n(c.tokens_in)}{c.cache_read ? ` +${n(c.cache_read)} cached` : ""}{c.cache_write ? ` +${n(c.cache_write)} cache write` : ""}</span>
      <span className="cc">out {n(c.tokens_out)}</span>
      <span className="cc cost">${c.cost_usd?.toFixed(4) ?? "?"}</span>
      <span className="cc">stop {c.stop_reason ?? "-"}</span>
      {c.prompt_version && <span className="cc">{c.prompt_version}</span>}
      {c.at && <span className="cc faint">{c.at.slice(0, 19).replace("T", " ")}</span>}
    </div>
  );
}

export function TracePage({ set, vendorId, line }: { set: string; vendorId: string; line: string | null }) {
  const [t, setT] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    setT(null);
    fetch(`/api/trace?set=${set}&vendor=${vendorId}${line ? `&line=${line}` : ""}`)
      .then(async (r) => (r.ok ? (r.json() as Promise<Trace>) : Promise.reject(new Error((await r.json()).error))))
      .then((x) => {
        setT(x);
        // For one cell, everything open; for the whole document, the first stages only.
        setOpen(new Set(line ? x.stages.map((s) => s.id) : ["intake", "parse", "injection"]));
      })
      .catch((e: Error) => setError(e.message));
  }, [set, vendorId, line]);
  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!t) return <Skeleton />;
  const toggle = (id: string) => {
    const n = new Set(open);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setOpen(n);
  };
  return (
    <div className="page">
      <a className="back" href={t.line ? `#/trace/${t.vendor_id}` : `#/vendor/${t.vendor_id}`}>← {t.line ? "Whole document" : "Vendor page"}</a>
      <div className="pagehead">
        <div>
          <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 6 }}><Icon.trace /> Pipeline trace</div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 8 }}><VendorDot id={t.vendor_id} />{t.vendor_id}{t.line ? ` · ${t.line}` : ""}</h1>
        </div>
        <span className="spacer" />
        <div className="chips">
          <span className="chip"><Icon.file /> {t.file.split("/").pop()}</span>
          <span className="chip">{t.run_file}</span>
        </div>
      </div>
      <div className="tiles">
        <div className="tile"><div className="label">Model calls{t.line ? " that touched this cell" : ""}</div><div className="value">{t.totals.calls}</div></div>
        <div className="tile"><div className="label">Cost</div><div className="value">${t.totals.cost_usd.toFixed(3)}</div></div>
        <div className="tile"><div className="label">Model time</div><div className="value">{(t.totals.ms / 1000).toFixed(0)} s</div></div>
        <div className="tile"><div className="label">Stages</div><div className="value">{t.stages.length}</div><div className="hint">from the saved run and the code that rebuilt it, nothing canned</div></div>
      </div>
      <div className="row" style={{ marginTop: 0 }}>
        <button className="btn small ghost" onClick={() => setOpen(new Set(t.stages.map((s) => s.id)))}>Expand all</button>
        <button className="btn small ghost" onClick={() => setOpen(new Set())}>Collapse all</button>
      </div>
      <ol className="timeline">
        {t.stages.map((s) => {
          const more = Boolean(s.table?.rows.length || s.items?.length);
          return (
          <li key={s.id} className={`stage${s.call ? " model" : ""}`}>
            <div className="stage-head" onClick={() => more && toggle(s.id)} style={{ cursor: more ? "pointer" : "default" }}>
              <b>{s.title}</b>
              {s.call && <span className="tag" style={{ color: "var(--violet)", borderColor: "#ddd3fb", background: "var(--violet-soft)" }}>model</span>}
              <span className="muted"> {s.summary}</span>
              <span className="spacer" />
              {more ? <span className="faint small">{open.has(s.id) ? "▾ hide" : "▸ show"}</span> : null}
            </div>
            {s.call && <CallLine c={s.call} />}
            {open.has(s.id) && (
              <>
                {s.items && s.items.length > 0 && <pre className="mono stage-items">{s.items.join("\n")}</pre>}
                {s.table && s.table.rows.length > 0 && (
                  <div className="grid-wrap" style={{ marginTop: 6 }}>
                    <table className="plain">
                      <thead><tr>{s.table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>
                        {s.table.rows.map((r, i) => (
                          <tr key={i}>
                            {r.map((c, j) => (
                              <td key={j} className={typeof c === "number" ? "num" : j === 0 && /^L\d\d$/.test(String(c)) ? "mono" : ""}>
                                {j === 0 && /^L\d\d$/.test(String(c)) && !t.line ? <a href={`#/trace/${t.vendor_id}/${String(c)}`}>{String(c)}</a> : c === null ? <span className="faint">-</span> : String(c)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </li>
          );
        })}
      </ol>
    </div>
  );
}
