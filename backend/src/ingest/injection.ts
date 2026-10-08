/**
 * Injection screen, deterministic half (spec 10.3, 10.7, X07). Finds text in a vendor document that reads as an
 * instruction to an AI or an evaluator, records it verbatim, and strips its line from what extraction sees.
 * The light-model half of the screen (paraphrases this list cannot catch) needs the API and is not built yet.
 * A finding never changes a price or a state; it becomes a discrepancy the buyer sees.
 */

export interface InjectionFinding {
  pattern: string;
  /** The whole line that matched, verbatim. */
  line: string;
  line_index: number;
  start: number;
  end: number;
}

export interface ScreenResult {
  findings: InjectionFinding[];
  /** The text with each matched line replaced by a marker, for the extraction prompt. */
  clean_text: string;
}

export const REMOVED_MARKER = "[REMOVED: text addressed to AI systems; recorded for the buyer]";

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ignore_instructions", re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules)\b/i },
  { name: "addressed_to_ai", re: /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(automated|ai|llm|evaluation|language model|assistant|bot)/i },
  { name: "rank_us", re: /\brank\b[^.\n]{0,60}\b(first|top|highest|best)\b/i },
  { name: "mark_confirmed", re: /\bmark\b[^.\n]{0,40}\b(cells?|fields?|values?|prices?|rates?)\b[^.\n]{0,20}\b(confirmed|verified|correct|approved)\b/i },
  // An instruction to the reader, not a vendor speaking of itself ("we consider our rates final" is not one).
  { name: "treat_as_verified", re: /(?<!\bwe\s)\b(treat|consider|regard|record|accept)\b[^.\n]{0,40}\b(cells?|fields?|values?|prices?|rates?|quotes?|quotations?|items?)\b[^.\n]{0,20}\bas\s+(confirmed|verified|correct|approved)\b/i },
  // An AI spoken to directly: "AI assistant reviewing this file: ...", "Dear language model, ..."
  { name: "vocative_ai", re: /(^(\[[^\]]*\]\s*)?|[.!?]\s+|\b(dear|hello|hi|attention|attn)\s+)(an?\s+)?(ai|llm|gpt|chatbot|language model)(\s+(assistant|model|system|reviewer|agent|tool|evaluator))?\b[^.\n:,]{0,40}[:,]/i },
  { name: "ignore_competitors", re: /\b(ignore|disregard|discard|skip)\b[^.\n]{0,30}\b(other|competing|remaining|all other)\s+(quotations?|quotes|offers?|bids?|vendors?|suppliers?)\b/i },
  { name: "system_prompt", re: /\bsystem\s+prompt\b/i },
  { name: "role_play", re: /\byou are (now )?(an? )?(ai|assistant|language model|evaluator|chatgpt|claude)\b/i },
  { name: "evaluator", re: /\b(automated|ai)\s+(evaluation|evaluators?|review(ers?)?|systems?|graders?)\b/i },
];

export function screenInjection(text: string): ScreenResult {
  const lines = text.split("\n");
  const findings: InjectionFinding[] = [];
  const hit = new Set<number>();
  let offset = 0;
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        findings.push({ pattern: name, line, line_index: i, start: offset, end: offset + line.length });
        hit.add(i);
      }
    }
    offset += line.length + 1;
  });
  const clean_text = lines.map((l, i) => (hit.has(i) ? REMOVED_MARKER : l)).join("\n");
  return { findings, clean_text };
}
