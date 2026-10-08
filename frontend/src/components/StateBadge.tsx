import type { CellState } from "../api";

/** Spec 18.2: every state has its own icon, so it survives grayscale and colour blindness. */
export const STATE_LABEL: Record<CellState, string> = {
  CONFIRMED: "Confirmed",
  HIGH_CONF: "High confidence",
  BUYER_VERIFIED: "Buyer verified",
  INFERRED: "Inferred",
  NEEDS_REVIEW: "Needs review",
  MISSING: "Not quoted",
};

export function StateIcon({ state, size = 13 }: { state: CellState; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true, className: `icon icon-${state}` } as const;
  switch (state) {
    case "CONFIRMED":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.5 8.2l2.3 2.3 4.7-4.9" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "HIGH_CONF":
      return (
        <svg {...common}>
          <path d="M2.5 8.5l3.3 3.3 6.7-7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="13.5" cy="13" r="1.8" fill="currentColor" />
        </svg>
      );
    case "BUYER_VERIFIED":
      return (
        <svg {...common}>
          <circle cx="6" cy="4.5" r="2.6" fill="currentColor" />
          <path d="M1 14c0-3 2.2-5 5-5s3 .6 3.6 1.4" stroke="currentColor" strokeWidth="1.8" fill="none" />
          <path d="M9.5 12l1.8 1.8 3.7-4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "INFERRED":
      return (
        <svg {...common}>
          <path d="M2 9.5c1.5-3 3.5-3 5-1.2s3.5 1.8 5-1.3" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "NEEDS_REVIEW":
      return (
        <svg {...common}>
          <path d="M8 1.5l7 12.5H1z" fill="currentColor" />
          <path d="M8 6v4" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="12" r="1" fill="white" />
        </svg>
      );
    case "MISSING":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.6" fill="none" />
          <path d="M4.8 8h6.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}

export function StateBadge({ state }: { state: CellState }) {
  return (
    <span className={`badge badge-${state}`}>
      <StateIcon state={state} />
      {STATE_LABEL[state]}
    </span>
  );
}
