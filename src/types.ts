export type LifecycleStage = "submitted" | "processed" | "confirmed" | "finalized";

export type FailureClass =
  | "none"
  | "expired_blockhash"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_failure"
  | "unknown";

export interface TipFloor {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  ema: number;
  /** lamports; source timestamp (ms) */
  fetchedAt: number;
}

export interface RetryDecision {
  shouldRetry: boolean;
  reasoning: string;
  newTipLamports: number;
  refreshBlockhash: boolean;
  /** which component produced it: "agent" or "fallback" */
  source: "agent" | "fallback";
}

export interface LifecycleRecord {
  label: string;
  attempt: number;
  bundleId: string | null;
  signature: string | null;
  tipLamports: number;
  submitSlot: number | null;
  landedSlot: number | null;
  // epoch ms per stage
  submittedAt: number | null;
  processedAt: number | null;
  confirmedAt: number | null;
  finalizedAt: number | null;
  latencyMs: {
    submitToProcessed: number | null;
    processedToConfirmed: number | null;
    confirmedToFinalized: number | null;
  };
  failure: FailureClass;
  faultInjected: boolean;
  agentDecision: RetryDecision | null;
  notes?: string;
}
