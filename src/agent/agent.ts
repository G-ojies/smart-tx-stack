import OpenAI from "openai";
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
- Balance cost vs landing probability. Do not blindly max the tip.

Respond with ONLY a JSON object: {"shouldRetry": bool, "refreshBlockhash": bool, "tipLamports": int, "reasoning": string}.`;

export class RetryAgent {
  private client: OpenAI | null;
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; model: string },
    private readonly onTrace?: (t: { prompt: string; response: string }) => void
  ) {
    this.client = cfg.apiKey
      ? new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey })
      : null;
  }

  get enabled(): boolean {
    return this.client != null;
  }

  async decide(ctx: RetryContext): Promise<RetryDecision> {
    if (!this.client) return this.fallback(ctx, "no AI key configured");

    const userMsg = JSON.stringify(ctx, null, 2);
    try {
      const resp = await this.client.chat.completions.create({
        model: this.cfg.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      });
      const content = resp.choices[0]?.message?.content ?? "";
      this.onTrace?.({ prompt: userMsg, response: content });
      const parsed = extractJson(content);
      return this.normalize(parsed, ctx);
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
