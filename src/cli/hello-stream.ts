/**
 * Phase 0 smoke test: connect to Yellowstone gRPC and print live slot updates.
 * Proves streaming + reconnect/backpressure wiring before we build submission.
 *
 *   npm run stream
 */
import { loadConfig } from "../config";
import { YellowstoneStream, SlotUpdate } from "../stream/yellowstone";

async function main() {
  const cfg = loadConfig();
  console.log(`[hello-stream] network=${cfg.network} endpoint=${cfg.yellowstoneUrl}`);

  const stream = new YellowstoneStream({
    url: cfg.yellowstoneUrl,
    token: cfg.yellowstoneToken,
  });

  let count = 0;
  let lastSlot = 0;
  stream.on("connect", () => console.log("[hello-stream] ✅ connected, streaming slots…"));
  stream.on("disconnect", (e: Error) => console.log(`[hello-stream] ⚠️  disconnected: ${e.message}`));
  stream.on("error", (e: Error) => console.log(`[hello-stream] · ${e.message}`));
  stream.on("slot", (s: SlotUpdate) => {
    count++;
    const gap = lastSlot ? s.slot - lastSlot : 0;
    lastSlot = s.slot;
    if (count % 10 === 0 || gap > 1) {
      console.log(`[slot] ${s.slot} status=${s.status}${gap > 1 ? `  (gap ${gap})` : ""}`);
    }
  });

  await stream.start();

  // Run until Ctrl-C.
  process.on("SIGINT", async () => {
    console.log(`\n[hello-stream] received ${count} slot updates; stopping.`);
    await stream.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
