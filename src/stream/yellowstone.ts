import { EventEmitter } from "events";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";

export interface SlotUpdate {
  slot: number;
  parent?: number;
  status: string; // PROCESSED | CONFIRMED | FINALIZED
}

export interface TxUpdate {
  signature: string;
  slot: number;
  isFailed: boolean;
  raw: any;
}

export interface YellowstoneOptions {
  url: string;
  token?: string;
  /** Track transactions that touch any of these account pubkeys (base58). */
  trackAccounts?: string[];
  /** Backpressure high-water mark: pause the stream above this many queued items. */
  highWaterMark?: number;
}

/**
 * Yellowstone (Dragon's Mouth) gRPC client with:
 *  - automatic reconnect with exponential backoff (re-sends the subscription),
 *  - backpressure: a bounded async queue that pauses the gRPC stream when the
 *    consumer falls behind and resumes once drained.
 *
 * Emits: "slot" (SlotUpdate), "transaction" (TxUpdate), "connect", "disconnect",
 * "error".
 */
export class YellowstoneStream extends EventEmitter {
  private client?: Client;
  private stream?: any;
  private closed = false;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 30_000;
  private readonly hwm: number;

  // Backpressure queue
  private queue: Array<() => Promise<void>> = [];
  private draining = false;
  private paused = false;

  constructor(private readonly opts: YellowstoneOptions) {
    super();
    this.hwm = opts.highWaterMark ?? 1000;
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.closed = true;
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
  }

  private buildRequest(): SubscribeRequest {
    const transactions: SubscribeRequest["transactions"] = {};
    if (this.opts.trackAccounts && this.opts.trackAccounts.length) {
      transactions["tracked"] = {
        vote: false,
        failed: true, // we WANT failures for the lifecycle/classifier
        accountInclude: this.opts.trackAccounts,
        accountExclude: [],
        accountRequired: [],
      };
    }
    return {
      accounts: {},
      slots: { allSlots: { filterByCommitment: false } as any },
      transactions,
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
      ping: undefined,
    };
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    try {
      this.client = new Client(this.opts.url, this.opts.token, undefined);
      this.stream = await this.client.subscribe();

      this.stream.on("data", (data: any) => this.onData(data));
      this.stream.on("error", (err: Error) => this.onDisconnect(err));
      this.stream.on("end", () => this.onDisconnect(new Error("stream ended")));
      this.stream.on("close", () => this.onDisconnect(new Error("stream closed")));

      await new Promise<void>((resolve, reject) => {
        this.stream.write(this.buildRequest(), (err: any) =>
          err ? reject(err) : resolve()
        );
      });

      this.backoffMs = 1000; // reset after a clean connect
      this.emit("connect");
    } catch (err) {
      this.onDisconnect(err as Error);
    }
  }

  private onDisconnect(err: Error): void {
    this.emit("disconnect", err);
    try {
      this.stream?.removeAllListeners();
    } catch {
      /* ignore */
    }
    this.stream = undefined;
    if (this.closed) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.emit("error", new Error(`reconnecting in ${wait}ms: ${err.message}`));
    setTimeout(() => this.connect(), wait);
  }

  private onData(data: any): void {
    // Map raw gRPC payloads into our typed events, enqueued for backpressure.
    if (data?.slot) {
      const s = data.slot;
      this.enqueue(async () => {
        this.emit("slot", {
          slot: Number(s.slot),
          parent: s.parent != null ? Number(s.parent) : undefined,
          status: String(s.status ?? "PROCESSED"),
        } as SlotUpdate);
      });
    }
    if (data?.transaction) {
      const t = data.transaction;
      const txn = t.transaction;
      const sigBytes: Uint8Array | undefined = txn?.signature;
      const signature = sigBytes ? bs58encode(sigBytes) : "";
      this.enqueue(async () => {
        this.emit("transaction", {
          signature,
          slot: Number(t.slot ?? 0),
          isFailed: Boolean(txn?.meta?.err),
          raw: t,
        } as TxUpdate);
      });
    }
  }

  /** Bounded queue: pause the gRPC stream when the consumer is behind. */
  private enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    if (this.queue.length > this.hwm && !this.paused) {
      this.paused = true;
      try {
        this.stream?.pause?.();
      } catch {
        /* ignore */
      }
      this.emit("error", new Error(`backpressure: paused (queue=${this.queue.length})`));
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        try {
          await task();
        } catch (e) {
          this.emit("error", e as Error);
        }
        if (this.paused && this.queue.length < this.hwm / 2) {
          this.paused = false;
          try {
            this.stream?.resume?.();
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

// Minimal base58 (avoids a hard dep cycle); falls back to bs58 if available.
function bs58encode(bytes: Uint8Array): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bs58 = require("bs58");
    return (bs58.default ?? bs58).encode(Buffer.from(bytes));
  } catch {
    return Buffer.from(bytes).toString("hex");
  }
}
