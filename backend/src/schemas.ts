import { z } from "zod";

/** Mirrors spec section 8.2 `rfx_line`. Spec fields are nullable when not applicable (e.g. n/a board specs on tape). */
export const RfxLineSchema = z.object({
  line_id: z.string().regex(/^L\d{2}$/),
  group: z.string(),
  description: z.string(),
  spec: z.object({
    ply: z.union([z.literal(3), z.literal(5), z.literal(7)]).nullable(),
    flute: z.string().nullable(),
    liner_gsm: z.number().positive().nullable(),
    bf: z.number().positive().nullable(),
    dims_text: z.string(),
    print: z.string(),
  }),
  base_uom: z.enum(["piece", "set", "pair", "kg", "roll"]),
  annual_qty: z.number().int().positive(),
  weight_kg_per_uom: z.number().positive(),
  conversion_hints: z.object({
    pieces_per_box: z.number().int().positive().optional(),
    rolls_per_carton: z.number().int().positive().optional(),
    quoting_basis_note: z.string().optional(),
    /** The RFx accepts "pcs" as this line's own unit (one piece = one set or pair), so "per 100 pcs" converts directly. */
    piece_is_base_uom: z.boolean().optional(),
  }),
  baseline_price_inr: z.number().positive(),
});
export type RfxLine = z.infer<typeof RfxLineSchema>;

/** Mirrors spec section 8.2 `question`. */
export const QuestionSchema = z.object({
  q_id: z.string().regex(/^Q\d{2}$/),
  text: z.string(),
  type: z.enum(["yes_no_file", "yes_no", "number", "text"]),
  is_gate: z.boolean(),
  file_required: z.boolean(),
  /** For a gate, the machine-checkable rule that decides it (spec 12.2: every gate has one). */
  pass_check: z.enum(["answer_yes", "valid_certificate", "test_report_covers_offered_plies"]).nullable().default(null),
  /** For a non-gate claim, what evidence it is checked against (spec E02). */
  claim_check: z.enum(["no_spec_deviations"]).nullable().default(null),
});
export type Question = z.infer<typeof QuestionSchema>;

/** Mirrors spec section 8.2 `rfx` header plus the 17.1 terms. */
export const RfxHeaderSchema = z.object({
  rfx_id: z.string(),
  title: z.string(),
  category: z.string(),
  buyer_org: z.string(),
  delivery_location: z.string(),
  currency: z.literal("INR"),
  issue_date: z.string(),
  due_date: z.string(),
  terms: z.object({
    payment_terms_days: z.number().int().positive(),
    delivery_basis_preferred: z.string(),
    prices_basis: z.string(),
    min_validity_days: z.number().int().positive(),
    max_lead_days: z.number().int().positive(),
  }),
  baseline: z.object({
    basis: z.string(),
    date: z.string(),
  }),
});
export type RfxHeader = z.infer<typeof RfxHeaderSchema>;
