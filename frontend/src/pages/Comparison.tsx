import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type CellSummary, type Comparison, type OpenItem } from "../api";
import { CellPanel } from "../components/CellPanel";
import { ClarifyDialog, ConfirmDialog } from "../components/Dialogs";
import { STATE_LABEL, StateIcon } from "../components/StateBadge";
import { Icon, Skeleton, VendorDot, vendorColor } from "../components/ui";
import { num, rupees } from "../format";

type Mode = "unit" | "annual";
type Filter = "all" | "unsafe" | "review" | "missing";

/** The RFx's own grouping of its 30 lines, for readable sections. */
const GROUPS = [
  { title: "5 ply printed master cartons", from: 1, to: 8 },
  { title: "3 ply inner cartons and boxes", from: 9, to: 14 },
  { title: "7 ply outer cartons", from: 15, to: 17 },
  { title: "Partitions, pads, sleeves and trays", from: 18, to: 22 },
  { title: "Sheets and rolls", from: 23, to: 25 },
  { title: "Packing accessories", from: 26, to: 30 },
];
const lineNo = (id: string) => Number(id.slice(1));
const pctTxt = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

function CellValue({ c, mode, qty }: { c: CellSummary; mode: Mode; qty: number }) {
  if (c.state === "MISSING") return <span className="cellv"><StateIcon state="MISSING" /><span>not quoted</span></span>;
  if (c.point === null) return <span className="cellv"><StateIcon state={c.state} /><span>review</span></span>;
  const ranged = c.low !== null && c.high !== null && c.high - c.low > 1e-9;
  return (
    <span className="cellbox">
      <span className="cellv"><StateIcon state={c.state} /><span>{mode === "unit" ? num(c.point) : rupees(c.point * qty)}</span></span>
      {ranged && mode === "unit" && <span className="range">{num(c.low)} to {num(c.high)}</span>}
    </span>
  );
}

export function ComparisonPage({ set, version, onChanged, openCell, onCellOpened }: { set: string; version: number; onChanged: (message?: string) => void; openCell?: { vendor: string; line: string } | null; onCellOpened?: () => void }) {
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("unit");
  const [bestMode, setBestMode] = useState<"overall" | "trusted">("overall");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ vendor: string; line: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [clarifying, setClarifying] = useState<string | null>(null);
  const [showAllItems, setShowAllItems] = useState(false);

  useEffect(() => {
    api.comparison(set).then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message));
  }, [set, version]);
  useEffect(() => {
    if (openCell) {
      setSelected(openCell);
      onCellOpened?.();
    }
  }, [openCell, onCellOpened]);

  const summary = useMemo(() => {
    if (!data) return null;
    const sum = (key: "best" | "best_trusted") => data.lines.reduce((s, l) => s + (l[key] ? l[key]!.point * l.annual_qty : 0), 0);
    const count = (key: "best" | "best_trusted") => data.lines.filter((l) => l[key]).length;
    const baseline = (key: "best" | "best_trusted") => data.lines.reduce((s, l) => s + (l[key] ? l.baseline * l.annual_qty : 0), 0);
    return {
      best: sum("best"), bestLines: count("best"), bestBase: baseline("best"),
      trusted: sum("best_trusted"), trustedLines: count("best_trusted"),
      atStake: data.open_items.reduce((s, i) => s + i.value_inr, 0),
      cleared: data.vendors.filter((v) => v.gate === "PASS" || v.gate === "WAIVED"),
      flipped: data.vendors.filter((v) => v.ranking?.flipped && v.ranking.landed_rank > v.ranking.headline_rank),
    };
  }, [data]);

  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!data || !summary) return <Skeleton rows={10} />;

  const matches = (l: Comparison["lines"][number]) => {
    const cells = Object.values(l.cells);
    if (filter === "unsafe" && !cells.some((c) => c.unsafe || c.state === "NEEDS_REVIEW")) return false;
    if (filter === "review" && !cells.some((c) => c.state === "NEEDS_REVIEW")) return false;
    if (filter === "missing" && !cells.some((c) => c.state === "MISSING")) return false;
    const q = query.trim().toLowerCase();
    return !q || l.line_id.toLowerCase().includes(q) || l.description.toLowerCase().includes(q) || l.spec.toLowerCase().includes(q);
  };
  const shown = data.lines.filter(matches);
  const act = (i: OpenItem) => {
    if (i.action === "confirm" && i.confirmation_id) setConfirming(i.confirmation_id);
    else if (i.action === "clarify") setClarifying(i.vendor_id);
    else setSelected({ vendor: i.vendor_id, line: i.line_id });
  };
  const items = showAllItems ? data.open_items : data.open_items.slice(0, 10);
  const maxItem = Math.max(1, ...data.open_items.map((i) => i.value_inr));
  const colSpan = data.vendors.length + 3;

  return (
    <div className="page">
      <div className="pagehead">
        <div>
          <div className="eyebrow">Comparison</div>
          <h1>{data.rfx.title}</h1>
        </div>
        <span className="spacer" />
        <div className="chips">
          <span className="chip">{data.vendors.length} vendors · {data.lines.length} lines</span>
          <span className="chip">Landed, ex GST, delivered Chakan</span>
          <span className="chip">FX USD {num(data.rfx.fx)} ({data.rfx.fx_date})</span>
          <span className="chip accent">Today {data.rfx.as_of}</span>
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Lowest landed, every line</div>
          <div className="value">{rupees(summary.best)}</div>
          <div className="hint">{summary.bestLines} of {data.lines.length} lines · {pctTxt(summary.bestBase ? summary.best / summary.bestBase - 1 : 0)} vs last year</div>
        </div>
        <div className="tile good">
          <div className="label"><StateIcon state="CONFIRMED" /> Lowest among trusted cells</div>
          <div className="value">{rupees(summary.trusted)}</div>
          <div className="hint">{summary.trustedLines} of {data.lines.length} lines have a fully safe price</div>
        </div>
        <div className="tile warn">
          <div className="label"><StateIcon state="NEEDS_REVIEW" /> Open items</div>
          <div className="value">{data.open_items.length}</div>
          <div className="hint">{rupees(summary.atStake)} resting on unconfirmed figures</div>
        </div>
        <div className={`tile ${summary.cleared.length ? "" : "bad"}`}>
          <div className="label">Cleared the quality gates</div>
          <div className="value">{summary.cleared.length} of {data.vendors.length}</div>
          <div className="hint">{summary.cleared.map((v) => v.vendor_id).join(", ") || "none yet"}</div>
        </div>
        {summary.flipped.length > 0 && (
          <div className="tile warn">
            <div className="label">{Icon.flip()} Ranking flips once delivered</div>
            {[...summary.flipped].sort((a, b) => a.ranking.headline_rank - b.ranking.headline_rank).map((v, i) => (
              <div key={v.vendor_id} title={`${pctTxt(v.ranking.headline_vs_baseline)} on paper, ${pctTxt(v.ranking.landed_vs_baseline)} landed (${v.freight.replace("_", " ")})`}>
                <div className="value" style={{ fontSize: i === 0 ? 17 : 13, marginTop: i === 0 ? 4 : 2, display: "flex", alignItems: "center", gap: 6 }}>
                  <VendorDot id={v.vendor_id} /> {v.vendor_id}: #{v.ranking.headline_rank} → #{v.ranking.landed_rank}
                  {i > 0 && <span className="hint" style={{ fontWeight: 400, margin: 0 }}>{v.freight.replace("_", " ")}</span>}
                </div>
                {i === 0 && <div className="hint">{pctTxt(v.ranking.headline_vs_baseline)} on paper, {pctTxt(v.ranking.landed_vs_baseline)} landed ({v.freight.replace("_", " ")})</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {data.confirmations.length > 0 && (
        <div className="banner">
          <b>{data.confirmations.length} reading{data.confirmations.length > 1 ? "s" : ""} to confirm.</b>
          <span>One decision settles each batch.</span>
          {data.confirmations.map((c) => (
            <button key={c.id} className="btn small" onClick={() => setConfirming(c.id)}>
              <VendorDot id={c.vendor_id} /> {c.vendor_id}: {c.kind === "currency_assumed" ? "currency" : c.fields.join(" and ")} on {c.lines.length} line{c.lines.length > 1 ? "s" : ""}
            </button>
          ))}
        </div>
      )}

      <div className="toolbar">
        <span className="seg">
          <button className={mode === "unit" ? "on" : ""} onClick={() => setMode("unit")}>Per unit</button>
          <button className={mode === "annual" ? "on" : ""} onClick={() => setMode("annual")}>Annual value</button>
        </span>
        <span className="seg" title="Best among every priced cell, or only among cells resting on safe components">
          <button className={bestMode === "overall" ? "on" : ""} onClick={() => setBestMode("overall")}>Best overall</button>
          <button className={bestMode === "trusted" ? "on" : ""} onClick={() => setBestMode("trusted")}>Best among trusted</button>
        </span>
        <span className="seg">
          {(["all", "unsafe", "review", "missing"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{{ all: "All lines", unsafe: "Unsafe cells", review: "Needs review", missing: "Not quoted" }[f]}</button>
          ))}
        </span>
        <span className="search">{Icon.search()}<input type="text" placeholder="Find a line" value={query} onChange={(e) => setQuery(e.target.value)} /></span>
        <span className="spacer" />
        <span className="legend">
          {(["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED", "INFERRED", "NEEDS_REVIEW", "MISSING"] as const).map((s) => <span key={s}><StateIcon state={s} /> {STATE_LABEL[s]}</span>)}
        </span>
      </div>

      <div className="grid-wrap tall">
        <table className="grid">
          <thead>
            <tr>
              <th className="sticky-col">Line <span className="faint small" style={{ fontWeight: 400 }}>{shown.length < data.lines.length ? `(${shown.length} of ${data.lines.length})` : ""}</span></th>
              {data.vendors.map((v) => (
                <th key={v.vendor_id} className="vhead">
                  <div className="vid"><VendorDot id={v.vendor_id} /><a href={`#/vendor/${v.vendor_id}`}>{v.vendor_id}</a> <span className={`pill ${v.gate}`}>{v.gate}</span></div>
                  <div className="vname" title={v.name}>{v.name}</div>
                  <div className="vtags">
                    <span className="tag">{v.format}</span>
                    <span className="tag">{v.freight.replace("_", " ")}</span>
                    {v.validity !== "ok" && <span className={`tag ${v.validity === "lapsed" ? "bad" : "warn"}`}>validity {v.validity.replace("_", " ")}</span>}
                    {v.injection && <span className="tag bad">AI-directed text</span>}
                  </div>
                  <div className="coverage" title={`${v.coverage.quoted} of ${v.coverage.total} lines quoted`}><span style={{ width: `${(v.coverage.quoted / v.coverage.total) * 100}%`, background: vendorColor(v.vendor_id) }} /></div>
                  {v.ranking?.flipped && (
                    <div className="flip" title={`Against last year: ${pctTxt(v.ranking.headline_vs_baseline)} headline, ${pctTxt(v.ranking.landed_vs_baseline)} landed`}>
                      {Icon.flip()} #{v.ranking.headline_rank} headline → #{v.ranking.landed_rank} landed
                    </div>
                  )}
                </th>
              ))}
              <th className="num">Last year</th>
              <th>Best</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const rows = shown.filter((l) => lineNo(l.line_id) >= g.from && lineNo(l.line_id) <= g.to);
              if (rows.length === 0) return null;
              return (
                <Fragment key={g.title}>
                  <tr className="group"><td className="sticky-col">{g.title}</td><td colSpan={colSpan - 1} /></tr>
                  {rows.map((l) => {
                    const best = bestMode === "trusted" ? l.best_trusted : l.best;
                    return (
                      <tr key={l.line_id}>
                        <td className="linecell sticky-col">
                          <div className="desc"><span className="lid">{l.line_id}</span>{l.description}</div>
                          <div className="meta">{l.spec} · {l.annual_qty.toLocaleString("en-IN")} {l.base_uom}s/yr</div>
                        </td>
                        {data.vendors.map((v) => {
                          const c = l.cells[v.vendor_id] as CellSummary;
                          const isSel = selected?.vendor === v.vendor_id && selected.line === l.line_id;
                          return (
                            <td
                              key={v.vendor_id}
                              className={`cell cell-${c.state}${isSel ? " selected" : ""}${best?.vendor_id === v.vendor_id ? " best" : ""}`}
                              title={`${STATE_LABEL[c.state]}: ${c.reason}`}
                              onClick={() => setSelected({ vendor: v.vendor_id, line: l.line_id })}
                            >
                              <CellValue c={c} mode={mode} qty={l.annual_qty} />
                            </td>
                          );
                        })}
                        <td className="num muted">{mode === "unit" ? num(l.baseline) : rupees(l.baseline * l.annual_qty)}</td>
                        <td className="best-col">
                          {best ? <span title={`The best cell is ${STATE_LABEL[best.state]}`}><VendorDot id={best.vendor_id} />{best.vendor_id} <StateIcon state={best.state} /></span> : <span className="faint">none</span>}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={colSpan} className="muted" style={{ padding: 20 }}>No line matches.</td></tr>}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky-col">Coverage</td>
              {data.vendors.map((v) => <td key={v.vendor_id} className="num">{v.coverage.quoted}/{v.coverage.total}</td>)}
              <td colSpan={2} />
            </tr>
            <tr>
              <td className="sticky-col" title="Annual value of lines resting only on safe components">Trusted value</td>
              {data.vendors.map((v) => <td key={v.vendor_id} className="num">{rupees(v.trusted_value)}</td>)}
              <td colSpan={2} />
            </tr>
            <tr>
              <td className="sticky-col">Total value</td>
              {data.vendors.map((v) => <td key={v.vendor_id} className="num">{rupees(v.total_value)}</td>)}
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Open items <span className="sub">by rupees at stake · {data.open_items.length} items, {rupees(summary.atStake)}</span></h2>
          {items.map((i, n) => (
            <div key={`${i.vendor_id}:${i.line_id}:${i.kind}`} className="oi">
              <div className="rank">{n + 1}</div>
              <div className="what">
                <div className="t"><VendorDot id={i.vendor_id} /><button className="linkbtn mono" onClick={() => setSelected({ vendor: i.vendor_id, line: i.line_id })}>{i.vendor_id} {i.line_id}</button><StateIcon state={i.state} /><span className="small">{i.kind === "freight" ? "Freight" : i.kind === "line" ? "No usable price" : "Rate"}</span></div>
                <div className="d" title={i.why}>{i.why}</div>
              </div>
              <div className="amt">{rupees(i.value_inr)}<div className="bar"><span style={{ width: `${(i.value_inr / maxItem) * 100}%` }} /></div></div>
              <div style={{ textAlign: "right" }}>
                {i.action === "confirm" && <button className="btn small" onClick={() => act(i)}>Confirm reading</button>}
                {i.action === "review" && <button className="btn small" onClick={() => act(i)}>Review</button>}
                {i.action === "clarify" && <button className="btn small" onClick={() => act(i)}>Draft clarification</button>}
              </div>
            </div>
          ))}
          {data.open_items.length > 10 && <button className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setShowAllItems(!showAllItems)}>{showAllItems ? "Show the top 10" : `Show all ${data.open_items.length}`}</button>}
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <h2>Clarifications <span className="sub">drafts only, never sent; checked by the confidentiality guard</span></h2>
            <div className="row" style={{ marginTop: 0 }}>
              {data.vendors.map((v) => <button key={v.vendor_id} className="btn small" onClick={() => setClarifying(v.vendor_id)}><VendorDot id={v.vendor_id} /> {v.vendor_id}</button>)}
            </div>
          </div>
          <div className="card">
            <h2>Recent decisions <a className="sub" href="#/log">audit log</a></h2>
            {data.decisions.length === 0 ? <p className="muted" style={{ margin: 0 }}>None yet. Decisions are stored and kept across restarts.</p> : (
              <ul className="items">{data.decisions.slice(-5).reverse().map((d, i) => <li key={i}><b>{d.decision}</b> {d.lines.join(", ")} <span className="muted">by {d.actor}: {d.reason}</span></li>)}</ul>
            )}
          </div>
        </div>
      </div>

      {selected && <CellPanel set={set} vendor={selected.vendor} line={selected.line} onClose={() => setSelected(null)} onConfirm={(id) => setConfirming(id)} onChanged={onChanged} version={version} />}
      {confirming && (
        <ConfirmDialog
          set={set}
          confirmation={data.confirmations.find((c) => c.id === confirming) ?? null}
          onClose={() => setConfirming(null)}
          onDone={() => {
            setConfirming(null);
            onChanged("Reading decided and logged");
          }}
        />
      )}
      {clarifying && <ClarifyDialog set={set} vendor={clarifying} onClose={() => setClarifying(null)} />}
    </div>
  );
}
