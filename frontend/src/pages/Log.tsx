import { useEffect, useState } from "react";
import { api } from "../api";
import { StateIcon } from "../components/StateBadge";
import { Icon, Skeleton, VendorDot } from "../components/ui";

/** The audit trail (spec 8.2 event_log, TR03): every buyer decision, newest first, with who and why. */
const LABEL: Record<string, string> = {
  confirmation_confirmed: "Reading confirmed",
  confirmation_rejected: "Reading rejected",
  cell_verified: "Cell verified",
  cell_overridden: "Rate entered",
  gate_waived: "Gate waived",
  award_confirmed: "Award confirmed",
};

function KindIcon({ kind }: { kind: string }) {
  if (kind === "award_confirmed") return <span className="kico award"><Icon.award /></span>;
  if (kind === "confirmation_rejected") return <span className="kico rej">✕</span>;
  if (kind === "gate_waived") return <span className="kico waive">W</span>;
  return <span className="kico ok"><StateIcon state="BUYER_VERIFIED" size={14} /></span>;
}

export function LogPage({ set, version }: { set: string; version: number }) {
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.events>> | null>(null);
  useEffect(() => {
    api.events(set).then(setEvents).catch(() => setEvents([]));
  }, [set, version]);
  if (!events) return <Skeleton />;
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Audit log</div>
          <h1>Every buyer decision, with who and why</h1>
        </div>
        <span className="spacer" />
        <span className="chip">{events.length} decision{events.length === 1 ? "" : "s"} · stored in the database</span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {events.length === 0 ? (
          <div className="empty">
            <Icon.log />
            <div><b>No decisions yet.</b></div>
            <div className="muted small">Confirmations, verified cells, entered rates, waivers and awards appear here as they are made.</div>
          </div>
        ) : events.map((e) => {
          const vendor = /^V\d/.test(e.ref) ? e.ref.slice(0, 2) : null;
          const detail = [
            e.payload.new !== undefined && e.payload.new !== null ? `new ${String(e.payload.new)}${e.payload.old ? `, was ${String(e.payload.old)}` : ""}` : "",
            Array.isArray(e.payload.lines) ? (e.payload.lines as string[]).join(", ") : "",
          ].filter(Boolean).join(" · ");
          return (
            <div key={e.event_id} className="logrow">
              <KindIcon kind={e.kind} />
              <div style={{ minWidth: 0 }}>
                <div className="t">
                  <b>{LABEL[e.kind] ?? e.kind}</b>
                  <span className="vchip">{vendor && <VendorDot id={vendor} />}<span className="mono">{e.ref}</span></span>
                </div>
                {e.payload.reason !== undefined && <div className="reason">"{String(e.payload.reason)}"</div>}
                {detail && <div className="small faint">{detail}</div>}
              </div>
              <div className="when">
                <div>{String(e.payload.actor ?? "")}</div>
                <div className="mono faint">{e.at.slice(0, 16).replace("T", " ")}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
