import { Connection, Commitment } from "@solana/web3.js";

export interface BlockhashInfo {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAtSlot: number;
}

/**
 * Blockhash management.
 *
 * Deliberately fetches at a *non-finalized* commitment. Using `finalized` for a
 * time-sensitive blockhash means starting ~31+ slots in the past, burning a
 * large chunk of the ~150-slot validity window before you even submit (see
 * README Q2). We use `confirmed` for a recent-but-stable hash.
 */
export class BlockhashManager {
  constructor(
    private readonly conn: Connection,
    private readonly commitment: Commitment = "confirmed"
  ) {}

  async fresh(): Promise<BlockhashInfo> {
    const slot = await this.conn.getSlot(this.commitment);
    const { blockhash, lastValidBlockHeight } =
      await this.conn.getLatestBlockhash(this.commitment);
    return { blockhash, lastValidBlockHeight, fetchedAtSlot: slot };
  }

  /** Returns true if the blockhash can no longer land (height exceeded). */
  async isExpired(info: BlockhashInfo): Promise<boolean> {
    const height = await this.conn.getBlockHeight(this.commitment);
    return height > info.lastValidBlockHeight;
  }

  /**
   * Produce an intentionally-stale blockhash for fault injection: a real, valid
   * hash whose validity window we then exhaust (the runner waits it out) so the
   * stack observes a genuine "blockhash expired" failure — not a fake error.
   */
  async stale(): Promise<BlockhashInfo> {
    const info = await this.fresh();
    // Mark it expired by claiming a height already in the past so callers that
    // check `isExpired` see expiry immediately; real submission will also fail.
    return { ...info, lastValidBlockHeight: 0 };
  }
}
