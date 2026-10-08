/**
 * Rupee display in the way an Indian buyer reads it: "Rs 12.4 lakh", "Rs 4.00 crore" (spec 18.9).
 * Display only. Never round before summing.
 */
export function formatRupees(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}Rs ${(abs / 1e7).toFixed(2)} crore`;
  if (abs >= 1e5) return `${sign}Rs ${(abs / 1e5).toFixed(1)} lakh`;
  return `${sign}Rs ${Math.round(abs).toLocaleString("en-IN")}`;
}
