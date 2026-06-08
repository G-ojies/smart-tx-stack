import { Connection } from "@solana/web3.js";
import { BlockhashManager } from "../core/blockhash";
import { Submitter } from "../core/submitter";
import { JitoClient } from "../core/jito";
import { computeTip, fetchTipFloor } from "../core/tip-engine";
import { LifecycleTracker } from "../lifecycle/tracker";
import { classifyError } from "../lifecycle/classifier";
import { LifecycleLogger, buildRecord } from "../lifecycle/logger";
import { RetryAgent, RetryContext } from "../agent/agent";
import { FailureClass, LifecycleRecord, TipFloor } from "../types";

export interface ExecuteOptions {
  label: string;
  maxAttempts: number;
  /** Inject a real blockhash-expiry failure on this 1-based attempt. */
  faultInjectAttempt?: number;
  /** Confirmation timeout per attempt (ms). */
  timeoutMs?: number;
}

export interface ExecuteOutcome {
  landed: boolean;
  attempts: number;
  records: LifecycleRecord[];
}

const MIN_TIP = 1000;

/** Most recent real processed→confirmed latency, fed back to the agent as a
 *  live network-health signal (null until the first bundle confirms). */

/**
 * Orchestrates an attempt → (failure → agent decides → apply → retry) loop.
 * The retry decision is owned by the AI agent, not hardcoded here: this engine
 * only *executes* what the agent returns (whether to retry, refresh blockhash,
 * and what tip to use).
 */
export class RetryEngine {
  constructor(
    private readonly conn: Connection,
    private readonly bh: BlockhashManager,
    private readonly submitter: Submitter,
    private readonly jito: JitoClient,
    private readonly tracker: LifecycleTracker,
    private readonly agent: RetryAgent,
    private readonly logger: LifecycleLogger,
    private readonly maxTipLamports: number
  ) {}

  private lastProcToConfMs: number | null = null;

  async execute(opts: ExecuteOptions): Promise<ExecuteOutcome> {
    const timeoutMs = opts.timeoutMs ?? 45_000;
    const tipAccounts = await this.jito.getTipAccounts();
    const floor = await fetchTipFloor();

    let tip = computeTip(floor, "medium", this.maxTipLamports, MIN_TIP);
    let bhInfo = await this.bh.fresh();
    const records: LifecycleRecord[] = [];

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      const faultInjected = opts.faultInjectAttempt === attempt;
      if (faultInjected) {
        // Genuinely age the blockhash until its window has truly elapsed, so the
        // failure observed below is real (and leaves no on-chain tx to contradict it).
        bhInfo = await this.bh.stale(({ heightToGo }) =>
          process.stdout.write(`\r[fault] waiting for blockhash to expire (${heightToGo} blocks to go)…   `)
        );
        process.stdout.write("\n");
      }

      let failure: FailureClass = "none";
      let bundleId: string | null = null;
      let signature: string | null = null;
      let stages: Awaited<ReturnType<LifecycleTracker["track"]>> | null = null;
      let rawError = "";

      try {
        const res = await this.submitter.submit(bhInfo, tip, tipAccounts, attempt);
        bundleId = res.bundleId;
        signature = res.signature;
        const tracking = this.tracker.track(signature, res.submitSlot, timeoutMs);
        stages = await tracking;

        if (stages.confirmedAt == null && stages.finalizedAt == null) {
          // Never confirmed within the window — derive the real cause from
          // on-chain state. For fault-injected runs the blockhash is genuinely
          // expired by now, so this honestly returns "expired_blockhash"; we
          // never assert a failure the chain didn't actually exhibit.
          failure = await this.diagnose(bhInfo);
        }
      } catch (e) {
        rawError = (e as Error).message;
        // Classify the real thrown error; fall back to on-chain diagnosis when
        // the message alone is inconclusive (e.g. Jito accepted then dropped).
        failure = classifyError(e);
        if (failure === "unknown" || failure === "none") {
          failure = await this.diagnose(bhInfo);
        }
      }

      const landed = failure === "none";
      let decision = null;

      if (!landed) {
        const ctx: RetryContext = {
          attempt,
          maxAttempts: opts.maxAttempts,
          failure,
          rawError,
          lastTipLamports: tip,
          tipFloor: floor as TipFloor,
          minTipLamports: MIN_TIP,
          maxTipLamports: this.maxTipLamports,
          slotsUntilNextLeader: await this.slotsUntilLeader(),
          recentProcessedToConfirmedMs: this.lastProcToConfMs,
          blockhashAgeSlots: null,
        };
        decision = await this.agent.decide(ctx);
      }

      records.push(
        this.record(opts.label, attempt, bundleId, signature, tip, bhInfo.fetchedAtSlot, stages, failure, faultInjected, decision)
      );
      const latest = records[records.length - 1];
      // Remember a real processed→confirmed delta to feed the agent next time.
      if (latest.latencyMs.processedToConfirmed != null) {
        this.lastProcToConfMs = latest.latencyMs.processedToConfirmed;
      }
      this.logger.log(latest);

      if (landed) return { landed: true, attempts: attempt, records };
      if (!decision || !decision.shouldRetry) break;

      // Apply the agent's decision for the next attempt.
      if (decision.refreshBlockhash) bhInfo = await this.bh.fresh();
      tip = decision.newTipLamports;
    }

    return { landed: false, attempts: records.length, records };
  }

  private async slotsUntilLeader(): Promise<number | null> {
    try {
      return (await this.jito.nextLeader()).slotsUntil;
    } catch {
      return null;
    }
  }

  private async diagnose(bhInfo: { lastValidBlockHeight: number; blockhash: string; fetchedAtSlot: number }): Promise<FailureClass> {
    try {
      if (await this.bh.isExpired(bhInfo as any)) return "expired_blockhash";
    } catch {
      /* ignore */
    }
    return "bundle_failure";
  }

  private record(
    label: string,
    attempt: number,
    bundleId: string | null,
    signature: string | null,
    tip: number,
    submitSlot: number,
    stages: Awaited<ReturnType<LifecycleTracker["track"]>> | null,
    failure: FailureClass,
    faultInjected: boolean,
    decision: LifecycleRecord["agentDecision"]
  ): LifecycleRecord {
    return buildRecord({
      label,
      attempt,
      bundleId,
      signature,
      tipLamports: tip,
      submitSlot,
      landedSlot: stages?.landedSlot ?? null,
      submittedAt: stages?.submittedAt ?? Date.now(),
      processedAt: stages?.processedAt ?? null,
      confirmedAt: stages?.confirmedAt ?? null,
      finalizedAt: stages?.finalizedAt ?? null,
      failure,
      faultInjected,
      agentDecision: decision,
    });
  }
}
