import { Connection } from "@solana/web3.js";
import { YellowstoneStream, SlotUpdate, TxUpdate } from "../stream/yellowstone";

export interface StageTimes {
  signature: string;
  submitSlot: number;
  landedSlot: number | null;
  submittedAt: number;
  processedAt: number | null;
  confirmedAt: number | null;
  finalizedAt: number | null;
}

interface Tracked extends StageTimes {
  resolve: (t: StageTimes) => void;
  done: boolean;
}

/**
 * Tracks transactions across commitment stages.
 *
 * Confirmation comes primarily from the Yellowstone stream (the spec requires
 * more than RPC polling): a tx appearing in the stream marks `processed` and its
 * landed slot; subsequent slot-status updates (CONFIRMED/FINALIZED) for slots
 * >= the landed slot advance the stage. An RPC `getSignatureStatuses` poll runs
 * as a backstop so a missed stream frame doesn't strand a record.
 */
export class LifecycleTracker {
  private tracked = new Map<string, Tracked>();
  private maxFinalizedSlot = 0;
  private maxConfirmedSlot = 0;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly conn: Connection,
    private readonly stream: YellowstoneStream
  ) {
    this.stream.on("transaction", (t: TxUpdate) => this.onTx(t));
    this.stream.on("slot", (s: SlotUpdate) => this.onSlot(s));
    this.startBackstop();
  }

  track(signature: string, submitSlot: number, timeoutMs = 90_000): Promise<StageTimes> {
    const rec: Tracked = {
      signature,
      submitSlot,
      landedSlot: null,
      submittedAt: Date.now(),
      processedAt: null,
      confirmedAt: null,
      finalizedAt: null,
      resolve: () => {},
      done: false,
    };
    const p = new Promise<StageTimes>((resolve) => (rec.resolve = resolve));
    this.tracked.set(signature, rec);
    setTimeout(() => this.finish(signature), timeoutMs);
    return p;
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private onTx(t: TxUpdate): void {
    const rec = this.tracked.get(t.signature);
    if (!rec || rec.done) return;
    if (rec.processedAt == null) {
      rec.processedAt = Date.now();
      rec.landedSlot = t.slot || rec.submitSlot;
    }
  }

  private onSlot(s: SlotUpdate): void {
    const status = s.status.toUpperCase();
    if (status.includes("FINALIZED")) this.maxFinalizedSlot = Math.max(this.maxFinalizedSlot, s.slot);
    if (status.includes("CONFIRMED")) this.maxConfirmedSlot = Math.max(this.maxConfirmedSlot, s.slot);

    for (const rec of this.tracked.values()) {
      if (rec.done || rec.landedSlot == null) continue;
      if (rec.confirmedAt == null && this.maxConfirmedSlot >= rec.landedSlot) {
        rec.confirmedAt = Date.now();
      }
      if (rec.finalizedAt == null && this.maxFinalizedSlot >= rec.landedSlot) {
        rec.finalizedAt = Date.now();
        this.finish(rec.signature);
      }
    }
  }

  /** RPC backstop: fill any stage the stream missed. */
  private startBackstop(): void {
    this.pollTimer = setInterval(async () => {
      const sigs = [...this.tracked.keys()].filter((s) => !this.tracked.get(s)!.done);
      if (!sigs.length) return;
      try {
        const res = await this.conn.getSignatureStatuses(sigs, {
          searchTransactionHistory: false,
        });
        res.value.forEach((st, i) => {
          if (!st) return;
          const rec = this.tracked.get(sigs[i]);
          if (!rec || rec.done) return;
          if (rec.processedAt == null) {
            rec.processedAt = Date.now();
            rec.landedSlot = st.slot;
          }
          const cs = st.confirmationStatus;
          if ((cs === "confirmed" || cs === "finalized") && rec.confirmedAt == null)
            rec.confirmedAt = Date.now();
          if (cs === "finalized" && rec.finalizedAt == null) {
            rec.finalizedAt = Date.now();
            this.finish(sigs[i]);
          }
        });
      } catch {
        /* transient RPC error — stream remains primary */
      }
    }, 2000);
  }

  private finish(signature: string): void {
    const rec = this.tracked.get(signature);
    if (!rec || rec.done) return;
    rec.done = true;
    rec.resolve({ ...rec });
    this.tracked.delete(signature);
  }
}
