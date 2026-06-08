import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { JitoClient } from "./jito";
import { BlockhashInfo } from "./blockhash";

export interface SubmissionResult {
  bundleId: string;
  signature: string;
  tipLamports: number;
  tipAccount: string;
  blockhash: string;
  submitSlot: number;
}

/**
 * Builds and submits a single Jito bundle.
 *
 * The payload is a trivial self-transfer (1 lamport to self): cheap, always
 * valid, and non-competitive, so landing depends on tip/timing rather than the
 * transaction's own merit — ideal for exercising the stack.
 */
export class Submitter {
  constructor(
    private readonly conn: Connection,
    private readonly jito: JitoClient,
    private readonly payer: Keypair
  ) {}

  private buildPayloadTx(blockhash: string): VersionedTransaction {
    const ix = SystemProgram.transfer({
      fromPubkey: this.payer.publicKey,
      toPubkey: this.payer.publicKey,
      lamports: 1,
    });
    const msg = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.payer]);
    return tx;
  }

  async submit(
    bh: BlockhashInfo,
    tipLamports: number,
    tipAccounts: PublicKey[],
    seed: number
  ): Promise<SubmissionResult> {
    const tx = this.buildPayloadTx(bh.blockhash);
    const tipAccount = this.jito.pickTipAccount(tipAccounts, seed);
    const signature = bs58sig(tx);

    const bundleId = await this.jito.sendBundle(
      this.payer,
      [tx],
      tipLamports,
      tipAccount,
      bh.blockhash
    );

    return {
      bundleId,
      signature,
      tipLamports,
      tipAccount: tipAccount.toBase58(),
      blockhash: bh.blockhash,
      submitSlot: bh.fetchedAtSlot,
    };
  }
}

function bs58sig(tx: VersionedTransaction): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bs58 = require("bs58");
  const enc = bs58.default ?? bs58;
  return enc.encode(Buffer.from(tx.signatures[0]));
}
