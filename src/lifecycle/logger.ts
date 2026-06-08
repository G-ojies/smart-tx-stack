import * as fs from "fs";
import * as path from "path";
import { LifecycleRecord } from "../types";

/**
 * Appends lifecycle records to a JSONL file (one JSON object per line) and
 * mirrors a human summary to stdout. The JSONL is the deliverable the judges
 * cross-reference against explorers.
 */
export class LifecycleLogger {
  private readonly file: string;

  constructor(dir = "logs", filename = "lifecycle.jsonl") {
    const abs = path.resolve(dir);
    fs.mkdirSync(abs, { recursive: true });
    this.file = path.join(abs, filename);
  }

  log(rec: LifecycleRecord): void {
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    const d = rec.latencyMs;
    const stage = rec.finalizedAt
      ? "finalized"
      : rec.confirmedAt
      ? "confirmed"
      : rec.processedAt
      ? "processed"
      : "submitted";
    const outcome = rec.failure === "none" ? `landed/${stage}` : `FAIL:${rec.failure}`;
    console.log(
      `[lifecycle] ${rec.label} attempt=${rec.attempt} tip=${rec.tipLamports} ` +
        `slot=${rec.landedSlot ?? "-"} ${outcome} ` +
        `Δp→c=${d.processedToConfirmed ?? "-"}ms` +
        (rec.faultInjected ? " (fault-injected)" : "") +
        (rec.agentDecision ? ` agent=${rec.agentDecision.shouldRetry ? "retry" : "stop"}` : "")
    );
  }

  get path(): string {
    return this.file;
  }
}

/** Build a LifecycleRecord from stage timings + metadata. */
export function buildRecord(args: {
  label: string;
  attempt: number;
  bundleId: string | null;
  signature: string | null;
  tipLamports: number;
  submitSlot: number | null;
  landedSlot: number | null;
  submittedAt: number | null;
  processedAt: number | null;
  confirmedAt: number | null;
  finalizedAt: number | null;
  failure: LifecycleRecord["failure"];
  faultInjected: boolean;
  agentDecision: LifecycleRecord["agentDecision"];
  notes?: string;
}): LifecycleRecord {
  const d = (a: number | null, b: number | null) => (a != null && b != null ? b - a : null);
  return {
    ...args,
    latencyMs: {
      submitToProcessed: d(args.submittedAt, args.processedAt),
      processedToConfirmed: d(args.processedAt, args.confirmedAt),
      confirmedToFinalized: d(args.confirmedAt, args.finalizedAt),
    },
  };
}
