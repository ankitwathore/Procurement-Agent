import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/** Shared bits of the design system: vendor colours, icons, toasts, skeletons. */

export const vendorColor = (id: string) => `var(--${id.toLowerCase()}, var(--accent))`;

export function VendorDot({ id }: { id: string }) {
  return <span className="vdot" style={{ background: vendorColor(id) }} />;
}

const P = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const Icon = {
  grid: () => <svg {...P}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>,
  award: () => <svg {...P}><circle cx="8" cy="6" r="4" /><path d="M5.5 9.3 4.5 15l3.5-2 3.5 2-1-5.7" /></svg>,
  log: () => <svg {...P}><path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3M6 8h5M6 11h5" /></svg>,
  spark: () => <svg {...P}><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M12.6 3.4l-2 2M5.4 10.6l-2 2" /></svg>,
  search: () => <svg {...P} width={13} height={13}><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>,
  trace: () => <svg {...P}><circle cx="3.5" cy="4" r="1.5" /><circle cx="12.5" cy="8" r="1.5" /><circle cx="3.5" cy="12" r="1.5" /><path d="M5 4h3l3 4M5 12h3l3-4" /></svg>,
  file: () => <svg {...P}><path d="M4 1.5h5l3 3v10H4z" /><path d="M9 1.5v3h3" /></svg>,
  reset: () => <svg {...P}><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.5 2.5v2.5H5" /></svg>,
  flip: () => <svg {...P} width={11} height={11}><path d="M4 2v12M4 14l-2.5-2.5M4 14l2.5-2.5M12 14V2M12 2 9.5 4.5M12 2l2.5 2.5" /></svg>,
};

const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

/** One short confirmation at the bottom of the screen after a buyer action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; id: number } | null>(null);
  const show = useCallback((text: string) => setMsg({ text, id: Date.now() }), []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div key={msg.id} className="toast" onAnimationEnd={() => setMsg(null)}>{msg.text}</div>}
    </ToastCtx.Provider>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="page">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - (i % 3) * 18}%` }} />)}
    </div>
  );
}
