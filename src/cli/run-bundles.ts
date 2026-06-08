/**
 * Phase 5 runner: perform N real Jito bundle submissions, inject blockhash
 * expiry on a couple of them, let the AI agent own each retry decision, and
 * write a lifecycle log (logs/lifecycle.jsonl) + agent traces (logs/agent-traces.jsonl).
 *
 *   npm run submit            # default 10 bundles, fault-inject #3 and #7
 *   npm run submit -- 12      # 12 bundles
 *
 * Requires a funded mainnet wallet + Yellowstone + (recommended) AI key.
 */
import * as fs from "fs";
import * as path from "path";
import { Connection } from "@solana/web3.js";
import { loadConfig, loadWallet } from "../config";
import { YellowstoneStream } from "../stream/yellowstone";
import { JitoClient } from "../core/jito";
import { Submitter } from "../core/submitter";
import { BlockhashManager } from "../core/blockhash";
import { LifecycleTracker } from "../lifecycle/tracker";
import { LifecycleLogger } from "../lifecycle/logger";
import { RetryAgent } from "../agent/agent";
import { RetryEngine } from "../retry/engine";

async function main() {
  const total = parseInt(process.argv[2] || "10", 10);
  // Inject a genuine blockhash-expiry failure on these runs (forces agent retry).
  const faultRuns = new Set([3, 7]);

  const cfg = loadConfig();
  const wallet = loadWallet(cfg.walletKeypairPath);
  const conn = new Connection(cfg.rpcUrl, "confirmed");

  console.log(`[run-bundles] network=${cfg.network} wallet=${wallet.publicKey.toBase58()}`);
  const bal = await conn.getBalance(wallet.publicKey);
  console.log(`[run-bundles] balance=${(bal / 1e9).toFixed(4)} SOL  AI=${cfg.ai.apiKey ? "on" : "OFF (fallback heuristic)"}`);
  if (bal === 0) throw new Error("wallet has 0 SOL — fund it before submitting bundles");

  const stream = new YellowstoneStream({
    url: cfg.yellowstoneUrl,
    token: cfg.yellowstoneToken,
    trackAccounts: [wallet.publicKey.toBase58()],
  });
  stream.on("connect", () => console.log("[stream] connected"));
  stream.on("error", (e: Error) => console.log(`[stream] ${e.message}`));
  await stream.start();

  const jito = new JitoClient(cfg.jitoBlockEngineUrl);
  const submitter = new Submitter(conn, jito, wallet);
  const bh = new BlockhashManager(conn, "confirmed");
  const tracker = new LifecycleTracker(conn, stream);
  const logger = new LifecycleLogger();

  // Log every agent reasoning trace for the submission writeup / judges.
  const traceFile = path.resolve("logs/agent-traces.jsonl");
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });
  const agent = new RetryAgent(cfg.ai, (t) =>
    fs.appendFileSync(traceFile, JSON.stringify({ ts: Date.now(), ...t }) + "\n")
  );
  console.log(`[run-bundles] AI agent ${agent.enabled ? "ENABLED" : "in fallback mode"}`);

  const engine = new RetryEngine(conn, bh, submitter, jito, tracker, agent, logger, cfg.maxTipLamports);

  let landed = 0;
  let failures = 0;
  for (let i = 1; i <= total; i++) {
    const faultInjectAttempt = faultRuns.has(i) ? 1 : undefined;
    console.log(`\n=== bundle ${i}/${total}${faultInjectAttempt ? " (fault-injected)" : ""} ===`);
    const outcome = await engine.execute({
      label: `run-${i}`,
      maxAttempts: faultInjectAttempt ? 3 : 2,
      faultInjectAttempt,
    });
    if (outcome.landed) landed++;
    if (outcome.records.some((r) => r.failure !== "none")) failures++;
    await sleep(1500); // polite pacing between bundles
  }

  console.log(`\n[run-bundles] done: ${landed}/${total} landed, ${failures} runs had >=1 failure`);
  console.log(`[run-bundles] lifecycle log: ${logger.path}`);
  console.log(`[run-bundles] agent traces: ${traceFile}`);

  tracker.stop();
  await stream.stop();
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
