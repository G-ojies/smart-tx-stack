import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { searcherClient, SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import type { BundleResult } from "jito-ts/dist/gen/block-engine/bundle";

/**
 * Thin wrapper over jito-ts that unwraps its Result type into plain
 * throws/returns and exposes the pieces our stack needs:
 *   - getTipAccounts (to pick a tip destination)
 *   - getNextScheduledLeader (leader-window detection)
 *   - sendBundle (returns the bundle UUID)
 *   - onBundleResult (landing/failure stream)
 */
export class JitoClient {
  private readonly client: SearcherClient;

  constructor(blockEngineUrl: string) {
    // Public block engine: auth keypair is optional in recent jito-ts.
    this.client = searcherClient(blockEngineUrl, undefined);
  }

  async getTipAccounts(): Promise<PublicKey[]> {
    const r = await this.client.getTipAccounts();
    if (!r.ok) throw new Error(`getTipAccounts: ${r.error.message}`);
    return r.value.map((a) => new PublicKey(a));
  }

  /** Detect how far we are from the next Jito-leader slot. */
  async nextLeader(): Promise<{ currentSlot: number; nextLeaderSlot: number; slotsUntil: number }> {
    const r = await this.client.getNextScheduledLeader();
    if (!r.ok) throw new Error(`getNextScheduledLeader: ${r.error.message}`);
    const { currentSlot, nextLeaderSlot } = r.value;
    return { currentSlot, nextLeaderSlot, slotsUntil: nextLeaderSlot - currentSlot };
  }

  /**
   * Build + send a bundle: the payload transactions plus a tip tx to a random
   * tip account. Returns the bundle UUID.
   */
  async sendBundle(
    payer: Keypair,
    txs: VersionedTransaction[],
    tipLamports: number,
    tipAccount: PublicKey,
    recentBlockhash: string
  ): Promise<string> {
    const bundle = new Bundle(txs, txs.length + 1);
    const withTip = bundle.addTipTx(payer, tipLamports, tipAccount, recentBlockhash);
    if (withTip instanceof Error) throw withTip;

    const r = await this.client.sendBundle(withTip);
    if (!r.ok) throw new Error(`sendBundle: ${r.error.message}`);
    return r.value;
  }

  /** Subscribe to bundle results; returns a cancel function. */
  onBundleResult(
    onResult: (res: BundleResult) => void,
    onError: (e: Error) => void
  ): () => void {
    return this.client.onBundleResult(onResult, onError);
  }

  pickTipAccount(accounts: PublicKey[], seed: number): PublicKey {
    return accounts[seed % accounts.length];
  }
}
