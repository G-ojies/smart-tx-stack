# smart-tx-stack

A **smart Solana transaction stack** for the Superteam *Advanced Infrastructure
Challenge — Build a Smart Transaction Stack*. It observes the network in real
time over **Yellowstone gRPC**, submits **Jito bundles** with **dynamically
calculated tips**, tracks each transaction across **commitment lifecycle stages**,
classifies failures, and uses an **AI agent** to own a real operational decision
(autonomous retry with fault injection).

> **Status: work in progress.** Phase 0 (streaming foundation) is in. See
> `SCOPE.md` for the full plan and `logs/` (added in Phase 5) for real lifecycle
> evidence.

## Architecture (layers)

1. **Stream layer** — Yellowstone gRPC: live slots/leader/tx, with reconnect +
   backpressure (`src/stream/yellowstone.ts`).
2. **Core stack** — blockhash mgmt, Jito bundle construction, dynamic tip engine
   (live tip-account data, no hardcoded tips), leader-window detection.
3. **Lifecycle tracker** — submitted → processed → confirmed → finalized, with
   slots, timestamps, and latency deltas; confirmation via stream, not RPC polling.
4. **Failure classifier** — expired blockhash, fee too low, compute exceeded,
   bundle failure.
5. **AI agent** — owns *Autonomous Retry with Fault Injection*: detects a
   blockhash-expiry failure, reasons about the cause, refreshes the blockhash,
   recalculates the tip, and resubmits — reasoning logged, not hardcoded.

## Setup

```bash
npm install
cp .env.example .env   # fill in RPC, Yellowstone, Jito, wallet, AI key
npm run stream         # Phase 0 smoke test: live slot stream
```

Requires (see `.env.example`): a high-performance RPC, a Yellowstone gRPC
endpoint (SolInfra bounty credits / Helius / Triton), a funded mainnet wallet for
tips/fees, and a free OpenAI-compatible AI key (default: Groq).

## Layout

```
src/
  config.ts              # env + wallet loader
  stream/yellowstone.ts  # gRPC stream (reconnect + backpressure)
  cli/hello-stream.ts    # Phase 0 smoke test
SCOPE.md                 # full build plan
```

License: MIT.
