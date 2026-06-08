import Anthropic from "@anthropic-ai/sdk";
import { FailureClass, RetryDecision, TipFloor } from "../types";

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  failure: FailureClass;
  rawError: string;
  lastTipLamports: number;
  tipFloor: TipFloor;
  minTipLamports: number;
  maxTipLamports: number;
  // recent network signals the agent can reason over
  slotsUntilNextLeader: number | null;
  recentProcessedToConfirmedMs: number | null;
  blockhashAgeSlots: number | null;
}

const SYSTEM_PROMPT = `You are the operational decision agent inside a Solana "smart transaction stack".
A Jito bundle submission just FAILED. You own ONE decision: how to retry.

You must reason about the actual failure and current network signals, then decide:
- shouldRetry: whether retrying can plausibly succeed (false if the failure is not transient or attempts are exhausted)
- refreshBlockhash: whether the blockhash must be refetched before retrying (always true for an expired/invalid blockhash)
- tipLamports: the tip for the retry, chosen from live tip-floor data and conditions, within [minTipLamports, maxTipLamports]
- reasoning: 1-3 sentences explaining WHY, referencing the specific failure and signals

Principles:
- Expired/invalid blockhash => refresh is mandatory; tip is usually not the cause, so don't overspend.
- "fee_too_low"/bundle auction loss => the tip was uncompetitive; raise it toward a higher percentile, but never above maxTipLamports.
- "compute_exceeded" => retrying unchanged won't help; shouldRetry=false unless something can change.
- A rising recentProcessedToConfirmedMs signals a congested/forking network — lean toward a higher tip or holding for a better leader window.
- Balance cost vs landing probability. Do not blindly max the tip.`;

// Structured-output schema: the model is constrained to return exactly this shape,
// so we never have to coax JSON out of prose or repair malformed output.
const DECISION_SCHEMA: { [k: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  properties: {
    shouldRetry: { type: "boolean", description: "Whether retrying can plausibly succeed." },
    refreshBlockhash: { type: "boolean", description: "Refetch the blockhash before retrying." },
    tipLamports: {
      type: "integer",
      description: "Tip for the retry, within [minTipLamports, maxTipLamports].",
    },
    reasoning: { type: "string", description: "1-3 sentences explaining the decision." },
  },
  required: ["shouldRetry", "refreshBlockhash", "tipLamports", "reasoning"],
};

/**
 * Owns the retry decision via Claude (the @anthropic-ai/sdk Messages API).
 *
 * Uses adaptive thinking so the model reasons about the failure before deciding,
 * and structured outputs so the decision comes back as a validated object. The
 * full prompt + response are surfaced via `onTrace` so the reasoning is visible
 * to judges, not a black box. Falls back to a deterministic heuristic only when
 * no API key is configured or the call errors.
 */
export class RetryAgent {
  private client: Anthropic | null;
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; model: string },
    private readonly onTrace?: (t: { prompt: string; response: string }) => void
  ) {
    this.client = cfg.apiKey
      ? new Anthropic({
          apiKey: cfg.apiKey,
          // baseUrl is optional — only override the default (api.anthropic.com)
          // for a gateway/proxy. Empty string means "use the SDK default".
          ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
        })
      : null;
  }

  get enabled(): boolean {
    return this.client != null;
  }

  async decide(ctx: RetryContext): Promise<RetryDecision> {
    if (!this.client) return this.fallback(ctx, "no AI key configured");

    const userMsg = JSON.stringify(ctx, null, 2);
    try {
      const resp = await this.client.messages.create({
        model: this.cfg.model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: DECISION_SCHEMA },
        },
        messages: [{ role: "user", content: userMsg }],
      });
      // Structured output guarantees the text block is schema-valid JSON.
      const content = resp.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      this.onTrace?.({ prompt: userMsg, response: content });
      return this.normalize(extractJson(content), ctx);
    } catch (e) {
      return this.fallback(ctx, `agent call failed: ${(e as Error).message}`);
    }
  }

  /** Clamp/validate the model's decision into a safe RetryDecision. */
  private normalize(p: any, ctx: RetryContext): RetryDecision {
    const tip = Math.max(
      ctx.minTipLamports,
      Math.min(Math.round(Number(p?.tipLamports ?? ctx.lastTipLamports)), ctx.maxTipLamports)
    );
    return {
      shouldRetry: Boolean(p?.shouldRetry) && ctx.attempt < ctx.maxAttempts,
      refreshBlockhash:
        Boolean(p?.refreshBlockhash) || ctx.failure === "expired_blockhash",
      newTipLamports: Number.isFinite(tip) ? tip : ctx.lastTipLamports,
      reasoning: String(p?.reasoning ?? "(no reasoning returned)").slice(0, 500),
      source: "agent",
    };
  }

  /** Deterministic safety net if the model is unavailable. Marked as fallback. */
  private fallback(ctx: RetryContext, why: string): RetryDecision {
    const transient =
      ctx.failure === "expired_blockhash" ||
      ctx.failure === "fee_too_low" ||
      ctx.failure === "bundle_failure";
    const bump = ctx.failure === "fee_too_low" ? ctx.tipFloor.p95 : ctx.lastTipLamports;
    const tip = Math.max(ctx.minTipLamports, Math.min(bump, ctx.maxTipLamports));
    return {
      shouldRetry: transient && ctx.attempt < ctx.maxAttempts,
      refreshBlockhash: ctx.failure === "expired_blockhash",
      newTipLamports: tip,
      reasoning: `[fallback: ${why}] heuristic for ${ctx.failure}`,
      source: "fallback",
    };
  }
}

function extractJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}
