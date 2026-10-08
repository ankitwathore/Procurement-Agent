import { Fragment, useRef, useState, type ReactNode } from "react";
import { rupees } from "../format";
import { ClarifyDialog } from "./Dialogs";
import { Icon } from "./ui";

/** The analyst drawer (spec 18.7): ask in plain words; tool chips while it works; answers as typed blocks. */

type Block =
  | { type: "answer"; markdown: string }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "chart"; spec: { title: string; type: string; labels: string[]; series: { name: string; values: number[] }[]; unit: string } }
  | { type: "how"; tool_calls: { name: string; input: unknown; summary: string }[] }
  | { type: "assumptions"; items: string[] }
  | { type: "trust"; unsafe_components: number; exposure_inr: number; exposure_pct: number; cost_low: number; cost_high: number; cost_point: number; headline: string }
  | { type: "actions"; items: { label: string; kind: string; vendor_id: string; line_id: string }[] };

interface Turn {
  question: string;
  chips: { name: string; status: string; summary: string }[];
  corrections: string[][];
  blocks: Block[] | null;
  unverified: string[];
  cost: number | null;
  error: string | null;
}

const QUICK = [
  "Cheapest per line, but only among vendors who cleared the quality questionnaire",
  "Which of V5's numbers are guesses and how many rupees depend on them?",
  "Does any vendor contradict their own attachments?",
  "Why is V4 cheapest on the carton lines and should I believe it?",
  "How much do we save versus last year, and how much rests on a single vendor quote?",
  "Which vendor has the best on time delivery record?",
  "Who is best?",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bold, lists and paragraphs; unverified figures marked (spec 14.5). */
function Markdown({ text, unverified }: { text: string; unverified: string[] }) {
  const mark = (line: string): ReactNode[] => {
    const parts = unverified.length ? line.split(new RegExp(`(${unverified.map(esc).join("|")})`, "g")) : [line];
    return parts.map((p, i) =>
      unverified.includes(p) ? (
        <mark key={i} className="unverified" title="Unverified figure: not found in any tool result">{p}</mark>
      ) : (
        <Fragment key={i}>{p.split(/(\*\*[^*]+\*\*)/g).map((q, j) => (q.startsWith("**") ? <b key={j}>{q.slice(2, -2)}</b> : q))}</Fragment>
      ),
    );
  };
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`u${out.length}`}>{list.map((l, i) => <li key={i}>{mark(l)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*[-*]\s+/.test(line)) list.push(line.replace(/^\s*[-*]\s+/, ""));
    else {
      flush();
      if (line.trim()) out.push(<p key={`p${out.length}`}>{mark(line)}</p>);
    }
  }
  flush();
  return <>{out}</>;
}

function Chart({ spec }: { spec: Extract<Block, { type: "chart" }>["spec"] }) {
  const totals = spec.labels.map((_, i) => spec.series.reduce((s, x) => s + (spec.type === "stacked" ? (x.values[i] ?? 0) : 0), 0));
  const max = Math.max(1, ...(spec.type === "stacked" ? totals : spec.series.flatMap((x) => x.values)));
  const colours = ["var(--accent)", "#8b9cf0", "var(--amber)", "var(--ok)", "var(--violet)"];
  return (
    <div className="chart">
      <div className="small muted">{spec.title}{spec.unit ? ` (${spec.unit})` : ""}</div>
      {spec.labels.map((label, i) => (
        <div key={label} className="chart-row">
          <span className="chart-label">{label}</span>
          <span className="chart-bars">
            {spec.series.map((x, k) => (
              <span key={x.name} className="chart-bar" title={`${x.name}: ${x.values[i]}`} style={{ width: `${((x.values[i] ?? 0) / max) * 100}%`, background: colours[k % colours.length], display: spec.type === "stacked" ? "inline-block" : "block" }} />
            ))}
          </span>
          <span className="chart-value num">{spec.series.map((x) => x.values[i]?.toLocaleString("en-IN")).join(" / ")}</span>
        </div>
      ))}
      {spec.series.length > 1 && <div className="small muted">{spec.series.map((x, k) => <span key={x.name} style={{ marginRight: 10 }}><span className="dot" style={{ background: colours[k % colours.length] }} /> {x.name}</span>)}</div>}
    </div>
  );
}

export function AnalystDrawer({ set, onClose, onOpenCell }: { set: string; onClose: () => void; onOpenCell: (vendor: string, line: string) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState(() => Math.random().toString(36).slice(2));
  const [clarify, setClarify] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const update = (f: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), f(ts[ts.length - 1] as Turn)]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setQ("");
    setTurns((ts) => [...ts, { question, chips: [], corrections: [], blocks: null, unverified: [], cost: null, error: null }]);
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      const r = await fetch(`/api/analyst?set=${set}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, conversation_id: conv }) });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "");
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.type === "tool") update((t) => ({ ...t, chips: [...t.chips.filter((c) => !(c.name === e.name && c.status === "start" && e.status !== "start")), e] }));
          if (e.type === "correction") update((t) => ({ ...t, corrections: [...t.corrections, e.ungrounded] }));
          if (e.type === "final") update((t) => ({ ...t, blocks: e.blocks, unverified: e.unverified, cost: e.cost_usd }));
          if (e.type === "error") update((t) => ({ ...t, error: e.message }));
        }
        end.current?.scrollIntoView({ behavior: "smooth" });
      }
    } catch (err) {
      update((t) => ({ ...t, error: (err as Error).message }));
    }
    setBusy(false);
  };

  const act = (a: { kind: string; vendor_id: string; line_id: string }) => {
    if (a.kind === "draft_clarification" && a.vendor_id) setClarify(a.vendor_id);
    else if (a.kind === "open_vendor" && a.vendor_id) window.location.hash = `#/vendor/${a.vendor_id}`;
    else if (a.kind === "open_award") window.location.hash = "#/award";
    else if (a.kind === "open_cell" && a.vendor_id && a.line_id) onOpenCell(a.vendor_id, a.line_id);
  };

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="logo" style={{ width: 26, height: 26 }}><Icon.spark /></span>
        <div>
          <b>Analyst</b>
          <div className="tiny muted">answers from the data; every figure checked</div>
        </div>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => { setTurns([]); setConv(Math.random().toString(36).slice(2)); }}>New chat</button>
        <button className="btn small ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-body">
        {turns.length === 0 && (
          <div>
            <div className="welcome">
              <b>Ask about prices, vendors, risks or an award.</b>
              <div className="small muted">Every figure in an answer is checked against what the tools returned, and each answer says how much rests on unconfirmed numbers. About $0.10 to $0.40 a question.</div>
            </div>
            <div className="eyebrow" style={{ margin: "14px 0 6px" }}>Try one</div>
            {QUICK.map((x) => <button key={x} className="quick" onClick={() => ask(x)}>{x}</button>)}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="turn">
            <div className="q">{t.question}</div>
            {t.chips.length > 0 && (
              <div className="tchips">
                {t.chips.map((c, j) => <span key={j} className={`tchip ${c.status}`} title={c.summary}>{c.status === "start" ? "⋯ " : c.status === "error" ? "✕ " : "✓ "}{c.name.replace(/_/g, " ")}</span>)}
              </div>
            )}
            {t.corrections.map((c, j) => <div key={j} className="small faint" style={{ marginBottom: 4 }}>Grounding check sent back: {c.join(", ")}</div>)}
            <div className="a">
            {t.error && <div className="error">{t.error}</div>}
            {!t.blocks && !t.error && <div className="typing"><span /><span /><span /></div>}
            {t.blocks?.map((b, j) => {
              switch (b.type) {
                case "answer":
                  return <div key={j} className="answer"><Markdown text={b.markdown} unverified={t.unverified} /></div>;
                case "table":
                  return (
                    <div key={j} className="grid-wrap" style={{ marginTop: 6 }}>
                      <table className="plain">
                        <thead><tr>{b.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                        <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, m) => <td key={m}>{t.unverified.includes(c) ? <mark className="unverified">{c}</mark> : c}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  );
                case "chart":
                  return <Chart key={j} spec={b.spec} />;
                case "trust":
                  return (
                    <div key={j} className="trust">
                      <b>Trust:</b> {b.headline} Cost {rupees(b.cost_point)}, range {rupees(b.cost_low)} to {rupees(b.cost_high)}.
                    </div>
                  );
                case "assumptions":
                  return <details key={j} className="minifold"><summary>Assumptions ({b.items.length})</summary><ul>{b.items.map((x, k) => <li key={k} className="small">{x}</li>)}</ul></details>;
                case "how":
                  return (
                    <details key={j} className="minifold">
                      <summary>How I got this ({b.tool_calls.length} tool call{b.tool_calls.length === 1 ? "" : "s"})</summary>
                      <ol className="small">{b.tool_calls.map((c, k) => <li key={k}><b>{c.name}</b> {c.summary}<div className="mono faint" style={{ wordBreak: "break-word" }}>{JSON.stringify(c.input)}</div></li>)}</ol>
                    </details>
                  );
                case "actions":
                  return <div key={j} className="row" style={{ flexWrap: "wrap" }}>{b.items.map((a, k) => <button key={k} className="btn small" onClick={() => act(a)}>→ {a.label}</button>)}</div>;
              }
            })}
            {t.unverified.length > 0 && <div className="small warn" style={{ marginTop: 6 }}>Unverified figures (not found in any tool result): {t.unverified.join(", ")}</div>}
            {t.cost !== null && <div className="tiny faint" style={{ marginTop: 6, textAlign: "right" }}>${t.cost.toFixed(3)}</div>}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="drawer-input" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
        <textarea rows={2} value={q} placeholder={busy ? "Working..." : "Ask a question (Enter to send)"} disabled={busy} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(q); } }} />
        <button className="btn primary" disabled={busy || !q.trim()}>Ask</button>
      </form>
      {clarify && <ClarifyDialog set={set} vendor={clarify} onClose={() => setClarify(null)} />}
    </aside>
  );
}
