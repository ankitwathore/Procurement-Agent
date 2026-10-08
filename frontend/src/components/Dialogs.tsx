import { useEffect, useState } from "react";
import { api, type ClarificationDraft, type Confirmation } from "../api";

export function ConfirmDialog({ set, confirmation, onClose, onDone }: { set: string; confirmation: Confirmation | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!confirmation) return null;
  const go = (decision: "confirmed" | "rejected") => {
    setBusy(true);
    api.confirm(set, confirmation.id, decision, reason).then(onDone).catch((e: Error) => { setError(e.message); setBusy(false); });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Confirm a reading for {confirmation.vendor_id}</h2>
        <p>{confirmation.question}</p>
        <p className="small muted">One decision settles all {confirmation.lines.length} cells. Confirming marks their rates as buyer verified; rejecting sends them to review, unpriced. Either way it is logged.</p>
        <label className="small muted">Reason (required)</label>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. confirmed with Pankaj by phone" />
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !reason.trim()} onClick={() => go("confirmed")}>Confirm</button>
          <button className="btn danger" disabled={busy || !reason.trim()} onClick={() => go("rejected")}>Reject</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function ClarifyDialog({ set, vendor, onClose }: { set: string; vendor: string; onClose: () => void }) {
  const [draft, setDraft] = useState<ClarificationDraft | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.clarify(set, vendor).then((r) => setDraft(r.draft)).catch((e: Error) => setError(e.message));
  }, [set, vendor]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Clarification draft for {vendor}</h2>
        {error && <div className="error">{error}</div>}
        {draft === undefined ? (
          <p className="muted">Loading...</p>
        ) : draft === null ? (
          <p className="muted">Nothing to clarify for {vendor}.</p>
        ) : (
          <>
            <div className={draft.status === "drafted" ? "notice" : "error"}>
              {draft.status === "drafted" ? "Passed the confidentiality guard. Draft only: never sent." : "Blocked by the confidentiality guard:"}
              {draft.guard.problems.map((p, i) => <div key={i}>{p.kind} "{p.text}": {p.detail}</div>)}
            </div>
            <div className="small muted">To: {draft.to} · Subject: {draft.subject}</div>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", background: "#fbfcfd", border: "1px solid var(--line)", padding: 10, borderRadius: 4 }}>{draft.body}</pre>
          </>
        )}
        <div className="row"><span className="spacer" /><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/** A buyer decision that needs a reason (and sometimes a value): logged in the audit trail. */
export function ReasonDialog({ title, explain, valueLabel, onSubmit, onClose }: { title: string; explain: string; valueLabel?: string; onSubmit: (reason: string, value: number | null) => Promise<unknown>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = reason.trim() && (!valueLabel || Number(value) > 0);
  const go = () => {
    setBusy(true);
    onSubmit(reason.trim(), valueLabel ? Number(value) : null).then(onClose).catch((e: Error) => { setError(e.message); setBusy(false); });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="small muted">{explain}</p>
        {valueLabel && (
          <>
            <label className="small muted">{valueLabel}</label>
            <input type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
          </>
        )}
        <label className="small muted">Reason (required, kept in the audit log)</label>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !ready} onClick={go}>Save</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** Asks before something that cannot be undone. */
export function ConfirmDestructive({ title, explain, action, onYes, onClose }: { title: string; explain: string; action: string; onYes: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p>{explain}</p>
        <div className="row">
          <button className="btn danger" disabled={busy} onClick={() => { setBusy(true); void onYes().then(onClose); }}>{action}</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
