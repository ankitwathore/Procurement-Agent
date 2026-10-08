import type { RfxLine } from "../schemas.js";
import type { CanonicalUnit } from "./parse.js";

/**
 * Deterministic conversions (spec 9.2). The LLM supplies raw values and unit text; this does the arithmetic.
 */

export type BaseRateResult =
  | { ok: true; rate: number; chain: string[] }
  | { ok: false; reason: string };

type LineBasis = Pick<RfxLine, "line_id" | "base_uom" | "weight_kg_per_uom"> & { conversion_hints?: RfxLine["conversion_hints"]; description?: string };

/** Converts a rate quoted per `unit` into a rate per the line's base UoM. Never guesses a missing count. */
export function toBaseUomRate(rate: number, unit: CanonicalUnit, line: LineBasis): BaseRateResult {
  const base = line.base_uom;

  if (unit.kind === "box") {
    return { ok: false, reason: "quoted per box with no stated count" };
  }
  // "Per carton" on a line that is itself a carton prices one piece of it; on anything else a carton is a pack
  // of unknown size, like a box.
  if (unit.kind === "carton") {
    const isCarton = base === "piece" && /\bcartons?\b/i.test(line.description ?? "");
    if (!isCarton || unit.per !== 1) return { ok: false, reason: "quoted per carton with no stated count" };
    return { ok: true, rate, chain: [`${rate} per carton = ${rate} per piece (${line.line_id} is itself a carton)`] };
  }

  if (unit.kind === "kg" || unit.kind === "ton") {
    const kgPer = unit.per * (unit.kind === "ton" ? 1000 : 1);
    const perKg = rate / kgPer;
    const chain = [`${rate} per ${unit.per} ${unit.kind} = ${perKg} per kg`];
    if (base === "kg") return { ok: true, rate: perKg, chain };
    const perBase = perKg * line.weight_kg_per_uom;
    chain.push(`x ${line.weight_kg_per_uom} kg per ${base} = ${perBase} per ${base}`);
    return { ok: true, rate: perBase, chain };
  }

  const count = unit.kind === "dozen" ? unit.per * 12 : unit.per;
  const countKind = unit.kind === "dozen" ? "piece" : unit.kind;
  // The RFx can say that a "piece" is this line's own unit (a partition set, a pad pair). Only then does it convert.
  const pieceAsBase = countKind === "piece" && base !== "piece" && line.conversion_hints?.piece_is_base_uom === true;
  if (countKind !== base && !pieceAsBase) {
    return { ok: false, reason: `quoted per ${unit.kind} but ${line.line_id} is priced per ${base}` };
  }
  const perBase = rate / count;
  const chain = [`${rate} per ${unit.per} ${unit.kind} = ${perBase} per ${base}`];
  if (pieceAsBase) chain.push(`one piece read as one ${base}, as the RFx states for ${line.line_id}`);
  return { ok: true, rate: perBase, chain };
}

export function toInr(rate: number, currency: "INR" | "USD", usdInr: number): { rate: number; chain: string[] } {
  if (currency === "INR") return { rate, chain: [] };
  const inr = rate * usdInr;
  return { rate: inr, chain: [`USD ${rate} x ${usdInr} = Rs ${inr}`] };
}

export function exGst(rate: number, gstPct: number, inclusive: boolean): number {
  return inclusive ? rate / (1 + gstPct / 100) : rate;
}

export function freightPerUom(laneRateInrPerKg: number, weightKgPerUom: number): number {
  return laneRateInrPerKg * weightKgPerUom;
}
