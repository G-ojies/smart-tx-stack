# smart-tx-stack

A **smart Solana transaction stack** for the Superteam *Advanced Infrastructure
Challenge — Build a Smart Transaction Stack*. It observes the network in real
time over **Yellowstone gRPC**, submits **Jito bundles** with **dynamically
calculated tips**, tracks each transaction across **commitment lifecycle stages**,
classifies failures, and uses an **AI agent** to own a real operational decision
(autonomous retry with fault injection).

> **Status: code complete, pending a provider-credentialed live run.** Every
> phase is implemented and typecheck-clean (stream, submitter+tip engine,
> lifecycle tracker+classifier, retry engine+genuine fault injection, AI agent).
> The only remaining step is executing real bundles to populate
> `logs/lifecycle.jsonl`, which needs Yellowstone gRPC access (the bounty's
> SolInfra credits, or Helius/Triton) — the one piece without a free public tier.
> The wallet cost is tiny (tips are capped at `MAX_TIP_LAMPORTS`; ~0.001 SOL for a
> 10-bundle run) and **the AI agent runs on a free key** (see below). See
> `SCOPE.md` for the full plan.

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
endpoint (SolInfra bounty credits / Helius / Triton), a funded wallet for
tips/fees (~0.001 SOL for a 10-bundle run), and an AI key. The agent supports
**two backends** so it can run for free: Anthropic/Claude, *or* any
OpenAI-compatible endpoint (`AI_PROVIDER=openai`) — Groq, Gemini, or OpenRouter,
all of which have a free tier.

## Operational Q&A (required)

> These are the operative principles behind each design choice. The stack
> measures the corresponding quantities directly into `logs/lifecycle.jsonl`
> during a run, so the numeric summaries are read off the log rather than
> estimated — the methodology for each is noted inline.

**Q1 — What does the delta between `processed_at` and `confirmed_at` tell you
about network health?**
It measures how long the cluster took to reach a 2/3 supermajority of votes
(`confirmed`) after the transaction was first included by a leader
(`processed`). A small, stable delta (typically ~1–2 slots / a few hundred ms)
means healthy vote propagation and little fork contention. A large or growing
delta signals congestion, fork churn, or vote lag — finality is slowing and
landing is riskier. *Methodology:* the tracker timestamps every stage transition
per attempt, so this Δ is computed directly from `processed_at`/`confirmed_at` in
the log and summarized as a median and worst case across the run.

**Q2 — Why should you never use `finalized` commitment when fetching a blockhash
for a time-sensitive transaction?**
A blockhash is only valid for ~150 slots (~60s). A `finalized` blockhash is
already ~31+ slots behind the chain tip the moment you fetch it, so you've burned
~20% of the validity window before even building the transaction. Add network
latency and a retry or two and you hit "blockhash not found / block height
exceeded." Fetching at `confirmed` (or `processed`) starts you near the tip and
maximizes the window in which the tx can actually land. *Methodology:* the runner
deliberately exercises this — fault-injected attempts (#3 and #7) force a genuine
blockhash expiry by waiting out the validity window, and the agent drives the
refresh-and-resubmit recovery, which the lifecycle log captures end to end.

**Q3 — What happens to your bundle if the Jito leader skips their slot?**
Jito bundles are only executed when a Jito-Solana leader builds that slot's
block. If that leader skips/misses their slot, the bundle is **not** included and
is **not** carried over to the next leader — it simply doesn't land (bundles are
all-or-nothing). Because the tip is paid only on inclusion, you aren't charged,
but you must resubmit targeting the next Jito leader window (we use
`getNextScheduledLeader` to time this). *Methodology:* `slotsUntilNextLeader` is
fed to the agent as a signal, and every non-landing attempt — with the leader
window it retried into — is recorded in the lifecycle log.

## Layout

```
src/
  config.ts              # env + wallet loader
  stream/yellowstone.ts  # gRPC stream (reconnect + backpressure)
  cli/hello-stream.ts    # Phase 0 smoke test
SCOPE.md                 # full build plan
```

License: MIT.
