/** Rupee display the way an Indian buyer reads it (spec 18.9): "Rs 12.4 lakh", "Rs 4.00 crore". Display only. */
export function rupees(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}Rs ${(abs / 1e7).toFixed(2)} crore`;
  if (abs >= 1e5) return `${sign}Rs ${(abs / 1e5).toFixed(1)} lakh`;
  return `${sign}Rs ${Math.round(abs).toLocaleString("en-IN")}`;
}

export const num = (n: number | null | undefined, dp = 2): string =>
  n === null || n === undefined ? "-" : n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const pct = (x: number | null | undefined, dp = 1): string => (x === null || x === undefined ? "-" : `${x.toFixed(dp)}%`);
