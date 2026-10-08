import Anthropic from "@anthropic-ai/sdk";
import { costUsd, type Usage } from "./pricing.js";

/**
 * The one place the app talks to the Claude API. Everything else depends on `LlmClient`, so tests use a stub and
 * never reach the network. Requests return JSON through structured outputs: Sonnet 5.5 and Opus 5.5 reject a forced
 * tool choice, and `output_config.format` is the supported way to get schema-valid JSON back.
 */

export interface JsonRequest {
  model: string;
  /** Stable context reused across calls and across passes (the RFx). First in the prompt, cached. */
  context: string;
  /** The pass's instructions, after the shared context. Cached too. */
  instructions: string;
  /** The per-call input (the vendor document). Never cached. */
  user: string;
  /** Images sent before the text, e.g. a photographed rate card. Base64, never cached. */
  images?: { media_type: "image/jpeg" | "image/png"; data: string }[];
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
  max_tokens: number;
}

export interface JsonResponse {
  /** The model's JSON text, or null when it produced none. */
  text: string | null;
  stop_reason: string | null;
  /** The model that actually answered; differs from the request when a refusal fallback ran. */
  model: string;
  fallback_used: boolean;
  usage: Usage;
  cost_usd: number | null;
  ms: number;
}

export interface LlmClient {
  json(req: JsonRequest): Promise<JsonResponse>;
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(opts: { timeoutMs: number; maxRetries: number }) {
    // Credentials come from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile); never from code.
    this.client = new Anthropic({ timeout: opts.timeoutMs, maxRetries: opts.maxRetries });
  }

  /**
   * The SDK retries a failed request, but not a stream whose connection drops part way ("terminated"). Those are
   * retried here, a couple of times; any other error is thrown as is.
   */
  async json(req: JsonRequest): Promise<JsonResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        const dropped = /terminated|ECONNRESET|socket hang up|other side closed|premature close/i.test(String((err as Error)?.message ?? err));
        if (!dropped || attempt >= 2) throw err;
      }
    }
  }

  private async once(req: JsonRequest): Promise<JsonResponse> {
    const started = Date.now();
    const stream = this.client.beta.messages.stream({
      model: req.model,
      max_tokens: req.max_tokens,
      // Refusal fallback, on by default for Sonnet 5.5 and Opus 5.5 code.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // RFx first, so pass A and pass B share one cached prefix; then each pass's own instructions.
      system: [
        { type: "text", text: req.context, cache_control: { type: "ephemeral" } },
        { type: "text", text: req.instructions, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: req.images?.length
            ? [...req.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media_type, data: i.data } })), { type: "text" as const, text: req.user }]
            : req.user,
        },
      ],
      output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
    });
    const msg = await stream.finalMessage();

    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const usage: Usage = {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
    const iterations = (msg.usage as { iterations?: { type: string }[] | null }).iterations ?? [];
    return {
      text: text === "" ? null : text,
      stop_reason: msg.stop_reason,
      model: msg.model,
      fallback_used: iterations.some((i) => i.type === "fallback_message"),
      usage,
      cost_usd: costUsd(msg.model, usage),
      ms: Date.now() - started,
    };
  }
}
