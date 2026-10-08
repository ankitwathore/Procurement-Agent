import { describe, expect, it } from "vitest";
import { QUESTIONS } from "../src/data/rfx.js";
import { V2_QA, buildV2Certificate } from "../src/generator/v2.js";
import { checkCertificate, classifyAnswer, entityMatches, evaluateIsoGate, type CertificateFields } from "../src/evidence/certificates.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { readCertificate } from "./fixtures/evidence.js";
import { config } from "./fixtures/quotes.js"; // as_of 2026-10-08, award 2026-10-12

const cert = (o: Partial<CertificateFields> = {}): CertificateFields => ({
  cert_type: "ISO 9001:2015",
  number: "X/1",
  issuer: "Some Body",
  entity_name: "Shree Ganesh Corrugators, Chakan, Pune",
  valid_from: "2024-03-15",
  valid_to: "2027-03-14",
  scope: "Manufacture of corrugated boxes and board",
  ...o,
});

describe("entityMatches", () => {
  it("matches the vendor inside a longer entity line, ignoring Pvt Ltd and punctuation", () => {
    expect(entityMatches("Ahmedabad Packwell Industries", "Ahmedabad Packwell Industries, Plot 42, GIDC Vatva")).toBe(true);
    expect(entityMatches("Delhi Carton Works", "M/s. Delhi Carton Works Pvt. Ltd.")).toBe(true);
  });

  it("does not match a different company or a sister plant with a different name (E03)", () => {
    expect(entityMatches("Delhi Carton Works", "Delhi Packaging Works")).toBe(false);
    expect(entityMatches("Southern Flute Packaging", "Northern Flute Packaging")).toBe(false);
  });
});

describe("checkCertificate (spec E01, E03, E07)", () => {
  it("a certificate for another standard fails Q01; an unreadable standard leaves it UNKNOWN", () => {
    const iso14001 = evaluateIsoGate("Yes", { ...cert(), cert_type: "ISO 14001:2015" }, "Shree Ganesh Corrugators", config);
    expect(iso14001).toMatchObject({ result: "FAIL", reason: "The certificate is for ISO 14001:2015, not ISO 9001." });
    expect(evaluateIsoGate("Yes", { ...cert(), cert_type: "" }, "Shree Ganesh Corrugators", config).result).toBe("UNKNOWN");
  });

  it("a current certificate for the right company and scope is valid", () => {
    expect(checkCertificate(cert(), "Shree Ganesh Corrugators", config)).toEqual({
      status: "valid",
      entity_matches: true,
      standard_matches: true,
      scope_covers: true,
      flags: [],
      details: [],
    });
  });

  it("expired before today", () => {
    const c = checkCertificate(cert({ valid_to: "2026-08-31" }), "Shree Ganesh Corrugators", config);
    expect(c.status).toBe("expired");
    expect(c.flags).toEqual(["expired_certificate"]);
    expect(c.details[0]).toBe("Expired on 2026-08-31, before today (2026-10-08).");
  });

  it("valid today but lapsing before the award date", () => {
    expect(checkCertificate(cert({ valid_to: "2026-10-10" }), "Shree Ganesh Corrugators", config).status).toBe("expiring_before_award");
  });

  it("date edges are inclusive: valid until the award date is valid; until yesterday is expired", () => {
    expect(checkCertificate(cert({ valid_to: "2026-10-12" }), "Shree Ganesh Corrugators", config).status).toBe("valid");
    expect(checkCertificate(cert({ valid_to: "2026-10-07" }), "Shree Ganesh Corrugators", config).status).toBe("expired");
  });

  it("not yet valid, and undated", () => {
    expect(checkCertificate(cert({ valid_from: "2026-11-01" }), "Shree Ganesh Corrugators", config).status).toBe("not_yet_valid");
    expect(checkCertificate(cert({ valid_to: null }), "Shree Ganesh Corrugators", config).status).toBe("undated");
    expect(checkCertificate(cert({ valid_to: "14/03/2027" }), "Shree Ganesh Corrugators", config).status).toBe("undated");
  });

  it("flags a wrong holder and a scope outside corrugated packaging", () => {
    const c = checkCertificate(cert({ entity_name: "Ganesh Polymers", scope: "Injection moulded plastic parts" }), "Shree Ganesh Corrugators", config);
    expect(c.flags).toEqual(["entity_mismatch", "scope_mismatch"]);
  });
});

describe("classifyAnswer (spec E06)", () => {
  it.each([
    ["Yes - certificate attached (valid to 14-03-2027)", "yes"],
    ["Yes, ISO 9001 certificate attached", "yes"],
    ["No", "no"],
    ["None", "no"],
    ["", "unanswered"],
    [null, "unanswered"],
    ["Yes, subject to 2 percent monthly interest beyond 30 days.", "hedged"], // V2 Q07, trap 13
    ["No: 100 percent advance for imported items, net 30 for others.", "hedged"], // V3 Q07, trap 19
    ["Yes, with exceptions for printed cartons", "hedged"],
    ["We will try our best", "hedged"],
  ])("%j -> %s", (raw, kind) => {
    expect(classifyAnswer(raw)).toBe(kind);
  });

  it("on V2's yes/no questions, finds Q07 hedged and Q04 ('On request') conditional; the gates Q01 and Q03 read yes", () => {
    const yesNo = new Set(QUESTIONS.filter((q) => q.type === "yes_no" || q.type === "yes_no_file").map((q) => q.q_id));
    const kinds = Object.fromEntries(V2_QA.filter(([q]) => yesNo.has(q)).map(([q, , a]) => [q, classifyAnswer(a)]));
    expect(kinds).toEqual({ Q01: "yes", Q02: "yes", Q03: "yes", Q04: "hedged", Q07: "hedged", Q08: "yes" });
  });
});

describe("evaluateIsoGate: Q01 (spec 17.4)", () => {
  const gate = (answer: string | null, c: CertificateFields | null, vendor = "Shree Ganesh Corrugators") =>
    evaluateIsoGate(answer, c, vendor, config);

  it("V1: yes, current certificate, right company: PASS", () => {
    expect(gate("Yes - certificate attached (valid to 14-03-2027)", cert()).result).toBe("PASS");
  });

  it("trap 09, V2: yes, but the attached certificate expired: FAIL, read from the real certificate PDF", async () => {
    const pdf = await parsePdf(await buildV2Certificate());
    const fields = readCertificate(pdf.text);
    expect(fields).toMatchObject({ valid_to: "2026-08-31", number: "QCB/9001/2023/4471" });
    const d = gate("Yes, ISO 9001 certificate attached", fields, "Ahmedabad Packwell Industries");
    expect(d.result).toBe("FAIL");
    expect(d.reason).toBe("Expired on 2026-08-31, before today (2026-10-08).");
    expect(d.certificate!.entity_matches).toBe(true);
  });

  it("yes with no file is a claim without evidence: FAIL (E04)", () => {
    expect(gate("Yes, attached", null)).toEqual({
      result: "FAIL",
      reason: "Answered yes, but no certificate was attached (claim without evidence).",
      certificate: null,
    });
  });

  it("a hedged or missing answer is UNKNOWN, never a pass or a silent fail (E06, E09)", () => {
    expect(gate("Yes, except for the Pune plant", cert()).result).toBe("UNKNOWN");
    expect(gate(null, null).result).toBe("UNKNOWN");
  });

  it("expiring before the award, or issued to someone else: FAIL", () => {
    expect(gate("Yes", cert({ valid_to: "2026-10-10" })).result).toBe("FAIL");
    expect(gate("Yes", cert({ entity_name: "Ganesh Polymers" })).result).toBe("FAIL");
  });

  it("an unreadable holder is UNKNOWN; a scope outside corrugated is reported but does not fail", () => {
    expect(gate("Yes", cert({ entity_name: null })).result).toBe("UNKNOWN");
    const d = gate("Yes", cert({ scope: "Plastic moulding" }));
    expect(d.result).toBe("PASS");
    expect(d.certificate!.flags).toEqual(["scope_mismatch"]);
  });

  it("answered no: FAIL", () => {
    expect(gate("No", null).result).toBe("FAIL");
  });
});
