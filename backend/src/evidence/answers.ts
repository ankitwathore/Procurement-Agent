import type { Quote } from "../ingest/quotes.js";
import { normalizePdfText } from "../ingest/parse_pdf.js";
import type { Question } from "../schemas.js";
import { classifyAnswer } from "./certificates.js";
import { checkDeviationClaim, type ClaimContradiction } from "./claims.js";

/**
 * Questionnaire answers from the extraction pass, checked before any gate reads them (spec 10.9, 17.4, X10).
 * The model's answers are untrusted like its prices: an answer counts only when its snippet is in the vendor's own
 * text (not quoted history) and the answer is the vendor's words in that snippet. A question answered two different
 * ways counts as unanswered, so a gate on it is UNKNOWN, never a guess.
 */

export interface ExtractedAnswer {
  q_id: string;
  answer_raw: string;
  snippet: string;
}

export interface AnswerSource {
  /** The parsed document as text (grid, page lines, paragraphs, or the email body). */
  text: string;
  /** For email: offsets at or beyond this are quoted history. */
  authoritativeEnd?: number;
}

export interface AnswersResult {
  /** Verified answers as written, keyed by question id: what the gates read. */
  answers: Record<string, string>;
  snippets: Record<string, string>;
  rejected: { q_id: string; reason: string }[];
}

const norm = (s: string) => normalizePdfText(s).toLowerCase();

export function answersFromExtraction(items: readonly ExtractedAnswer[], questions: readonly Question[], source: AnswerSource): AnswersResult {
  const known = new Set(questions.map((q) => q.q_id));
  const own = norm(source.text.slice(0, source.authoritativeEnd ?? source.text.length));
  const answers: Record<string, string> = {};
  const snippets: Record<string, string> = {};
  const rejected: AnswersResult["rejected"] = [];
  const conflicted = new Set<string>();

  for (const item of items) {
    const answer = item.answer_raw.trim();
    const reason = !known.has(item.q_id)
      ? `unknown question ${item.q_id}`
      : answer === ""
        ? null // the model saw no answer: unanswered, nothing to reject
        : item.snippet.trim() === ""
          ? "no snippet to check the answer against"
          : !own.includes(norm(item.snippet))
            ? "snippet is not in the vendor's own text"
            : !norm(item.snippet).includes(norm(answer))
              ? "answer is not the vendor's words in the snippet"
              : null;
    if (reason) {
      rejected.push({ q_id: item.q_id, reason });
      continue;
    }
    if (answer === "") continue;
    const prior = answers[item.q_id];
    if (prior !== undefined && norm(prior) !== norm(answer)) {
      conflicted.add(item.q_id);
      continue;
    }
    answers[item.q_id] = answer;
    snippets[item.q_id] = item.snippet.trim();
  }
  for (const q of conflicted) {
    rejected.push({ q_id: q, reason: `answered more than one way ("${answers[q]}" and another), so it counts as unanswered` });
    delete answers[q];
    delete snippets[q];
  }
  return { answers, snippets, rejected };
}

export interface QuestionnaireFindings {
  /** Yes/no questions answered with a condition attached, kept verbatim (spec E06). */
  hedged: { q_id: string; answer: string }[];
  /** "No deviations" claims that the vendor's own offer or test report contradicts (spec E02). */
  contradictions: ClaimContradiction[];
  /** Questions with no verified answer. */
  unanswered: string[];
}

export function questionnaireFindings(questions: readonly Question[], answers: Readonly<Record<string, string>>, quotes: readonly Quote[]): QuestionnaireFindings {
  const hedged: QuestionnaireFindings["hedged"] = [];
  const contradictions: ClaimContradiction[] = [];
  for (const q of questions) {
    const a = answers[q.q_id];
    if (a === undefined) continue;
    if ((q.type === "yes_no" || q.type === "yes_no_file") && classifyAnswer(a) === "hedged") hedged.push({ q_id: q.q_id, answer: a });
    if (q.claim_check === "no_spec_deviations") {
      const c = checkDeviationClaim(q.q_id, a, quotes);
      if (c) contradictions.push(c);
    }
  }
  return { hedged, contradictions, unanswered: questions.filter((q) => answers[q.q_id] === undefined).map((q) => q.q_id) };
}
