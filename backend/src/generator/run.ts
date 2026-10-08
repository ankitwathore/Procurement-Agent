import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RFX_HEADER, RFX_LINES, QUESTIONS } from "../data/rfx.js";
import { clarificationMessageId } from "../review/clarify.js";
import { V1_HOLDOUT, V1_HOLDOUT2, V1_TUNED, buildV1Certificate, buildV1TestReport, buildV1Workbook, v1GroundTruth, v1Traps, type V1Variant } from "./v1.js";
import { V2_HOLDOUT, V2_HOLDOUT2, V2_TUNED, buildV2Certificate, buildV2Quote, buildV2TestReport, v2GroundTruth, v2Traps, type V2Variant } from "./v2.js";
import { V3_HOLDOUT, V3_HOLDOUT2, V3_TUNED, buildV3Certificate, buildV3Quote, buildV3TestReport, v3GroundTruth, v3Traps, type V3Variant } from "./v3.js";
import { V4_HOLDOUT, V4_HOLDOUT2, V4_TUNED, buildV4CertificatePhoto, buildV4Eml, buildV4Photo, v4GroundTruth, v4Traps, type V4Variant } from "./v4.js";
import { V5_CLARIFICATION_REPLY_FILE, V5_HOLDOUT, V5_HOLDOUT2, V5_TUNED, buildV5ClarificationReplyEml, buildV5Eml, v5ClarificationReplyTruth, v5GroundTruth, v5Traps, type V5Variant } from "./v5.js";

/**
 * Writes the generated datasets (spec 17.10). Deterministic from the seed.
 *  - tuned (seed 42) under data/: the spec's files, used while building.
 *  - holdout (seed 7) under data/holdout/: the same vendor roles and classes of traps in other layouts, wording and
 *    placements. Never used to tune prompts (spec D26, 17.10).
 * Usage: npm run gen-data [-- --set tuned|holdout|holdout2]   (all by default)
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const setArg = process.argv.indexOf("--set");
const ONLY = setArg >= 0 ? process.argv[setArg + 1] : null;

interface SetSpec {
  name: "tuned" | "holdout" | "holdout2";
  seed: number;
  dir: string;
  v1: V1Variant;
  v2: V2Variant;
  v3: V3Variant;
  v4: V4Variant;
  v5: V5Variant;
}

const SETS: SetSpec[] = [
  { name: "tuned", seed: 42, dir: join(ROOT, "data"), v1: V1_TUNED, v2: V2_TUNED, v3: V3_TUNED, v4: V4_TUNED, v5: V5_TUNED },
  { name: "holdout", seed: 7, dir: join(ROOT, "data", "holdout"), v1: V1_HOLDOUT, v2: V2_HOLDOUT, v3: V3_HOLDOUT, v4: V4_HOLDOUT, v5: V5_HOLDOUT },
  // A fresh holdout, written after the fixes the seed 7 run prompted, so a first run on it is again on unseen files.
  { name: "holdout2", seed: 8, dir: join(ROOT, "data", "holdout2"), v1: V1_HOLDOUT2, v2: V2_HOLDOUT2, v3: V3_HOLDOUT2, v4: V4_HOLDOUT2, v5: V5_HOLDOUT2 },
];

function write(path: string, data: Buffer | string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
  return createHash("sha256").update(data).digest("hex").slice(0, 12);
}

async function generateSet(set: SetSpec): Promise<[string, string][]> {
  const { dir: data, seed, v1, v2, v3, v4, v5 } = set;
  const tuned = set.name === "tuned";
  const out: [string, string][] = [];
  const put = (path: string, bytes: Buffer | string) => out.push([path, write(path, bytes)]);

  put(join(data, "rfx.json"), JSON.stringify({ header: RFX_HEADER, lines: RFX_LINES, questions: QUESTIONS }, null, 2));

  const vendors: Record<string, unknown> = {};
  const revisions: Record<string, unknown> = {};
  const traps: Record<string, unknown> = {};
  // The holdout has no revision 2: trap 05 is exercised on the tuned set only.
  for (const revision of tuned ? ([1, 2] as const) : ([1] as const)) {
    const { buffer, content } = await buildV1Workbook(seed, revision, v1);
    put(join(data, "vendors", "V1", v1.files[revision]), buffer);
    if (revision === 1) {
      vendors.V1 = v1GroundTruth(content, v1);
      Object.assign(traps, v1Traps(v1, content));
    } else revisions.V1_rev2 = v1GroundTruth(content, v1);
  }
  const v1Dir = join(data, "vendors", "V1");
  put(join(v1Dir, v1.files.certificate), await buildV1Certificate(v1));
  put(join(v1Dir, v1.files.testReport), await buildV1TestReport(v1));

  const q2 = await buildV2Quote(seed, v2);
  const v2Dir = join(data, "vendors", "V2");
  // Trap 36: the same quotation arrives twice under different names; identical bytes, so it dedupes by hash.
  for (const name of [v2.files.quote, v2.files.duplicate]) put(join(v2Dir, name), q2.buffer);
  put(join(v2Dir, v2.files.certificate), await buildV2Certificate(v2));
  put(join(v2Dir, v2.files.testReport), await buildV2TestReport(v2));
  vendors.V2 = v2GroundTruth(q2.content, v2);
  Object.assign(traps, v2Traps(v2, q2.content));

  const q3 = await buildV3Quote(seed, v3);
  const v3Dir = join(data, "vendors", "V3");
  put(join(v3Dir, v3.files.quote), q3.buffer);
  put(join(v3Dir, v3.files.certificate), await buildV3Certificate(v3));
  put(join(v3Dir, v3.files.testReport), await buildV3TestReport(v3));
  vendors.V3 = v3GroundTruth(q3.content, v3);
  Object.assign(traps, v3Traps(v3));

  // V4: the rate card and certificate as phone photos, attached to an email whose body holds the questionnaire.
  const v4Dir = join(data, "vendors", "V4");
  const { photo, rows: v4Rows } = await buildV4Photo(seed, v4);
  const v4Cert = await buildV4CertificatePhoto(seed, v4);
  put(join(v4Dir, v4.files.photo), photo.jpeg);
  put(join(v4Dir, v4.files.certificate), v4Cert);
  put(join(v4Dir, v4.files.email), buildV4Eml(photo.jpeg, v4Cert, v4));
  put(join(v4Dir, v4.files.params), JSON.stringify({ params: photo.params, regions: photo.regions }, null, 2));
  vendors.V4 = v4GroundTruth(v4Rows, photo, v4);
  Object.assign(traps, v4Traps(v4));

  put(join(data, "vendors", "V5", v5.file), buildV5Eml(v5));
  vendors.V5 = v5GroundTruth(v5);
  Object.assign(traps, v5Traps(v5));
  traps["33"] = { vendor: "All", what: "landed ranking differs from headline ranking (V4 ex works: cheapest on paper, dearest delivered)" };
  const replies: Record<string, unknown> = {};
  if (tuned) {
    // The scripted reply to our first clarification to V5 (spec 13.2, 13.4).
    put(join(data, "vendors", "V5", V5_CLARIFICATION_REPLY_FILE), buildV5ClarificationReplyEml(clarificationMessageId("V5", RFX_HEADER.rfx_id)));
    replies.V5_clarification_1 = v5ClarificationReplyTruth();
  }

  // Every evidence file and its true attributes, for the eval (spec 17.7).
  const manifest = {
    [`V1/${v1.files.certificate}`]: { vendor: "V1", doc_role: "certificate", ...v1.certificate, status_on_as_of_date: "valid" },
    [`V1/${v1.files.testReport}`]: { vendor: "V1", doc_role: "test_report", ...v1.testReport, confirms: `lighter 120 GSM board on ${v1.lighter.join(", ")}` },
    [`V2/${v2.files.quote}`]: { vendor: "V2", doc_role: "quote", pages: tuned ? 4 : 3 },
    [`V2/${v2.files.duplicate}`]: { vendor: "V2", doc_role: "quote", duplicate_of: `V2/${v2.files.quote}` },
    [`V2/${v2.files.certificate}`]: { vendor: "V2", doc_role: "certificate", ...v2.certificate, status_on_as_of_date: "expired" },
    [`V2/${v2.files.testReport}`]: { vendor: "V2", doc_role: "test_report", ...v2.testReport },
    [`V3/${v3.files.quote}`]: { vendor: "V3", doc_role: "quote" },
    [`V4/${v4.files.email}`]: { vendor: "V4", doc_role: "quote_email", attachments: [v4.files.photo, v4.files.certificate] },
    [`V4/${v4.files.photo}`]: { vendor: "V4", doc_role: "quote", kind: "image", attached_to: `V4/${v4.files.email}` },
    [`V4/${v4.files.certificate}`]: { vendor: "V4", doc_role: "certificate", kind: "image", cert_type: "ISO 9001:2015", ...v4.certificate, status_on_as_of_date: "valid" },
    [`V3/${v3.files.certificate}`]: { vendor: "V3", doc_role: "certificate", ...v3.certificate, status_on_as_of_date: "valid" },
    [`V3/${v3.files.testReport}`]: { vendor: "V3", doc_role: "test_report", ...v3.testReport, contradicts: `Q02 claim: ${v3.claimShortfall.evidence}` },
  };
  put(join(data, "docs_manifest.json"), JSON.stringify(manifest, null, 2));

  // Merge with any vendors written by other generators, then replace what this run produced.
  const gtPath = join(data, "ground_truth.json");
  const existing = existsSync(gtPath) ? JSON.parse(readFileSync(gtPath, "utf8")) : {};
  const gt = {
    ...existing,
    set: set.name,
    seed,
    vendors: { ...(existing.vendors ?? {}), ...vendors },
    revisions: { ...(existing.revisions ?? {}), ...revisions },
    replies: { ...(existing.replies ?? {}), ...replies },
    traps: { ...(existing.traps ?? {}), ...traps },
  };
  put(gtPath, JSON.stringify(gt, null, 2));
  return out;
}

async function main(): Promise<void> {
  for (const set of SETS.filter((s) => !ONLY || s.name === ONLY)) {
    for (const [path, hash] of await generateSet(set)) console.log(`${hash}  ${path.replace(ROOT, "")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
