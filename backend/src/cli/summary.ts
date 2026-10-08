import { RFX_HEADER, RFX_LINES, QUESTIONS } from "../data/rfx.js";
import { loadConfig } from "../config.js";
import { EXPECTED_BASELINE_TOTAL_INR, baselineTotal, lineAnnualValue } from "../data/totals.js";

/**
 * Prints the RFx line table and the baseline total so the dataset can be checked by eye.
 * Exits non-zero if the total does not match the spec.
 */
function main(): void {
  const config = loadConfig();
  const inr = new Intl.NumberFormat("en-IN");

  console.log(`${RFX_HEADER.title} (${RFX_HEADER.rfx_id})`);
  console.log(`as_of ${config.as_of_date} | award ${config.expected_award_date} | lines ${RFX_LINES.length} | questions ${QUESTIONS.length} (gates: ${QUESTIONS.filter((q) => q.is_gate).map((q) => q.q_id).join(", ")})`);
  console.log("");
  console.log("line  group  uom    annual_qty   baseline   annual_value_inr");
  for (const line of RFX_LINES) {
    console.log(
      [
        line.line_id.padEnd(5),
        line.group.padEnd(6),
        line.base_uom.padEnd(6),
        inr.format(line.annual_qty).padStart(10),
        line.baseline_price_inr.toFixed(2).padStart(9),
        inr.format(lineAnnualValue(line)).padStart(17),
      ].join("  "),
    );
  }

  const total = baselineTotal(RFX_LINES);
  console.log("");
  console.log(`baseline total: Rs ${inr.format(total)}  (expected Rs ${inr.format(EXPECTED_BASELINE_TOTAL_INR)})`);

  if (total !== EXPECTED_BASELINE_TOTAL_INR) {
    console.error("MISMATCH: baseline total does not match spec section 17.2");
    process.exit(1);
  }
}

main();
