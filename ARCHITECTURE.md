# Smart Transaction Stack — Architecture

> This document is the bounty's required architecture write-up. It is meant to be
> published to a public URL (Notion / Google Docs) separate from the repo; this
> copy is the source of truth. Diagrams below are ASCII; reproduce as boxes in
> the published version.

## 1. System overview

The stack turns "send a transaction and hope" into a closed feedback loop:
**observe the network → submit intelligently → track the outcome across
commitment stages → classify failures → let an AI agent decide the retry**. It
is built around live streaming (not polling) and real Jito bundle economics
(dynamic tips from live data), with a clean split between the AI decision layer
and the deterministic transaction machinery.

```
            ┌──────────────────────────────────────────────┐
            │            AI Agent (LLM, pluggable)          │
            │  owns ONE decision: autonomous retry          │
            │  in: failure class, raw error, live tip floor,│
            │      slots-until-leader, attempt history      │
            │  out: {shouldRetry, refreshBlockhash, tip,    │
            │        reasoning}                             │
            └───────────────▲───────────────┬──────────────┘
              failure context│               │decision
            ┌────────────────┴───────────────▼─────────────┐
            │                 Retry Engine                  │
            │  executes (only) what the agent returns;      │
            │  loops attempt → outcome → decide → apply     │
            └───▲────────────┬─────────────────┬───────────┘
       lifecycle│            │submit           │ fault inject
            ┌───┴──────┐ ┌───▼─────────┐ ┌─────▼──────────┐
            │ Lifecycle│ │  Submitter  │ │ Blockhash mgr  │
            │ tracker  │ │ +Tip engine │ │ (fresh / stale)│
            │+classifier│ │ +Jito client│ └────────────────┘
            └───▲──────┘ └───┬─────────┘
        slots/tx│            │ bundle
            ┌───┴──────┐ ┌───▼─────────┐
            │Yellowstone│ │ Jito Block  │
            │ gRPC      │ │ Engine      │
            └──────────┘ └─────────────┘
```

## 2. Key components

| Component | File | Responsibility |
| --------- | ---- | -------------- |
| Stream layer | `stream/yellowstone.ts` | Yellowstone (Dragon's Mouth) gRPC: subscribe to slot-status + our-account transactions; **reconnect** (exp. backoff) + **backpressure** (bounded queue pauses the stream when the consumer lags). |
| Tip engine | `core/tip-engine.ts` | Pull live Jito **tip floor** percentiles; compute a tip by percentile×EMA blend, clamped to a ceiling. No hardcoded tips. |
| Jito client | `core/jito.ts` | Unwraps jito-ts `Result`s: tip accounts, **next-scheduled-leader** (leader window), bundle send, bundle-result stream. |
| Submitter | `core/submitter.ts` | Builds a v0 payload tx (self-transfer), assembles a Jito **bundle** with a tip tx, submits. |
| Blockhash mgr | `core/blockhash.ts` | Fetches at **confirmed** (never finalized); detects expiry; produces a genuinely-stale hash for fault injection. |
| Lifecycle tracker | `lifecycle/tracker.ts` | Advances submitted→processed→confirmed→finalized from the **stream** (RPC `getSignatureStatuses` only as backstop); records slots + per-stage timestamps. |
| Classifier | `lifecycle/classifier.ts` | Maps errors / bundle results to {expired_blockhash, fee_too_low, compute_exceeded, bundle_failure}. |
| Logger | `lifecycle/logger.ts` | Appends structured `LifecycleRecord`s (slots, timestamps, latency deltas, tip, failure, agent decision) to `logs/lifecycle.jsonl`. |
| AI agent | `agent/agent.ts` | Owns the retry decision via an OpenAI-compatible model; logs prompt+response; safe heuristic fallback. |
| Retry engine | `retry/engine.ts` | Orchestration; **executes** the agent's decision, never hardcodes the retry path. |

## 3. Data flow

1. **Observe.** The stream feeds slot-status updates and any transaction touching
   our wallet into the tracker (and supplies leader timing via Jito's
   `getNextScheduledLeader`).
2. **Submit.** Tip engine reads the live tip floor → tip. Blockhash mgr returns a
   confirmed-commitment hash. Submitter builds the bundle and sends it; we get a
   bundle UUID + signature.
3. **Track.** Tracker watches the stream for our signature (→ processed + landed
   slot), then advances confirmed/finalized as slot-status updates cross the
   landed slot. RPC polling backstops missed frames.
4. **Classify.** No confirmation within the window, or a thrown/bundle error, is
   classified into one of the four failure classes.
5. **Decide.** On failure, the engine hands the agent the full context; the agent
   returns a reasoned decision.
6. **Apply & loop.** The engine refreshes the blockhash and/or adjusts the tip
   exactly as the agent instructed, then retries — or stops.

## 4. Infrastructure decisions

- **Streaming over polling.** Confirmation is driven by Yellowstone slot/tx
  streams; RPC is a backstop only. Polling alone misses the sub-second timing the
  lifecycle log is meant to capture, and can't observe slot-status transitions.
- **Confirmed, not finalized, for blockhashes.** A finalized blockhash is ~31+
  slots old on arrival, wasting the validity window (see README Q2).
- **Dynamic tips from the live floor.** Tips track real recent landed-tip
  percentiles; a single sample is smoothed with the EMA and clamped to a ceiling.
- **Provider-agnostic AI.** The agent speaks the OpenAI chat API, so Groq (free),
  OpenAI, OpenRouter, or a local model all work via `AI_BASE_URL`/`AI_MODEL`.
- **Clean AI/stack separation.** The agent returns data; the engine performs
  effects. The agent can be swapped or disabled (fallback) without touching the
  transaction machinery.

## 5. Failure handling strategy

- **Detect** via stream-confirmed absence + error/bundle-result inspection.
- **Classify** into the four required classes.
- **Fault injection:** a real expired-blockhash failure is forced by submitting
  with an exhausted blockhash, so the agent's detect→reason→refresh→re-tip→
  resubmit path is exercised on genuine (not simulated) errors.
- **Bounded retries** with agent-chosen backoff levers (blockhash refresh, tip).
- **Stream resilience:** reconnect with exponential backoff + backpressure so a
  slow consumer or a dropped connection never corrupts tracking.

## 6. AI agent responsibilities

The agent owns **one real operational decision: the retry**. Given the failure
class, raw error, live tip floor, slots-until-next-leader, and attempt history,
it decides whether to retry, whether the blockhash must be refreshed, and what
tip to use — with a one-to-three sentence rationale. The reasoning is logged to
`logs/agent-traces.jsonl`. It is *not* sequential automation: the engine contains
no hardcoded retry policy; it only executes the agent's returned decision (a
deterministic heuristic exists solely as a labelled fallback when no model key is
configured).

Example reasoned outcomes:
- *expired_blockhash* → "Blockhash exhausted its validity window; refresh is
  mandatory. Tip wasn't the cause, so hold tip near p50 to avoid overspending."
- *fee_too_low / auction loss* → "Bundle lost the auction; raise tip toward p95
  but stay under the ceiling; blockhash still valid, no refresh."
- *compute_exceeded* → "Deterministic; retrying unchanged can't help — stop."
