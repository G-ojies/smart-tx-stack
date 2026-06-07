# Smart Transaction Stack — build scope

**Bounty:** Advanced Infrastructure Challenge – Build a Smart Transaction Stack
(Superteam Nigeria) · **5,000 USDG** (2,500 / 1,500 / 1,000) · **HUMAN_ONLY** ·
deadline **2026-06-29** (~3 weeks out) · region **Nigeria** (you're eligible).

---

## 1. Verdict

Feasible and a strong fit for your skills, but this is the **biggest** build of
anything we've done — real infrastructure, not a self-contained Anchor program.
The code is very doable in ~1.5–2 weeks of focused work. The schedule risk isn't
the code; it's the **external dependencies and real-network evidence** (Jito,
Geyser stream, a funded mainnet wallet, 10+ real bundle submissions with ≥2
failures that judges will cross-reference on an explorer).

This is judged on *operational understanding*, not just code. The AI agent must
make a **real reasoned decision**, and the README/architecture doc carry heavy
weight. A polished, honest, working stack with genuine logs beats a feature-rich
one that clearly never ran.

---

## 2. Hard external dependencies (what gates the build)

These are blockers I cannot satisfy myself — you must provide access:

| Dependency | Why | How to get it |
| ---------- | --- | ------------- |
| **Yellowstone gRPC endpoint** | Required for live slot/leader/tx streaming. Not free/public. | Apply for the bounty's **SolInfra** credits (offered: RPC + Yellowstone gRPC + support), or Helius/Triton paid plan. |
| **High-performance RPC** | Blockhash, tip accounts, fallback polling. | SolInfra credits, or Helius/Triton/QuickNode. |
| **Jito Block Engine access** | Bundle submission + tip accounts. | Public endpoints exist (mainnet + testnet). No signup, but **mainnet = real SOL tips**. |
| **Funded wallet on the chosen network** | Real bundle submissions need tips + fees. | **If mainnet:** ~0.1–0.3 real SOL. **If Jito testnet:** testnet SOL (free-ish). |
| **Anthropic API key** | The AI agent's reasoning (recommended: Claude). | Your Anthropic console key (separate from Claude Code). |
| **A doc host** | Architecture doc must be a public URL *outside* the repo. | Notion / Google Doc / Figma (you publish; I write the content + diagrams). |

> **Critical reality:** Jito bundles do **not** run on Solana devnet. To produce
> the required real bundle logs you must use **mainnet** (real SOL tips, most
> credible — judges cross-ref mainnet explorer) or **Jito testnet**. I recommend
> mainnet with tiny tips on trivial self-transfer txs; total cost likely < 0.3 SOL.

---

## 3. Proposed architecture

Clean separation (the spec explicitly rewards this) into 4 layers + logging:

```
            ┌─────────────────────────────────────────────┐
            │              AI Agent (Claude)               │
            │   one real decision: Autonomous Retry w/     │
            │   Fault Injection — detect → reason →        │
            │   refresh blockhash → recalc tip → resubmit  │
            └───────────────▲───────────────┬─────────────┘
                            │ events        │ decisions
            ┌───────────────┴───────────────▼─────────────┐
            │            Core Transaction Stack            │
            │  • Submitter: build + sign + Jito bundle     │
            │  • Tip engine: dynamic from live tip accounts│
            │  • Leader-window detector                    │
            │  • Retry/backpressure controller             │
            └───────▲───────────────────────────┬─────────┘
        slots/leader│ tx status                 │ submit
            ┌───────┴───────┐          ┌────────▼─────────┐
            │ Stream layer  │          │  Jito Block      │
            │ Yellowstone   │          │  Engine          │
            │ gRPC (slots,  │          └──────────────────┘
            │ accounts, tx) │
            └───────┬───────┘
                    │ lifecycle events
            ┌───────▼───────────────────────────────────────┐
            │ Lifecycle tracker + classifier + JSONL logger  │
            │ submitted→processed→confirmed→finalized,       │
            │ slots, timestamps, latency deltas, tip, failure│
            └────────────────────────────────────────────────┘
```

### Components
1. **Stream layer** — Yellowstone gRPC client: subscribe to slot updates + leader
   schedule + transaction status. Must handle **reconnect + backpressure** (spec
   calls this out explicitly).
2. **Tip engine** — pull recent Jito tip-account data + current network conditions;
   compute a tip dynamically. **No hardcoded tips.**
3. **Submitter** — fetch blockhash at the *correct commitment* (not finalized),
   construct a Jito bundle, detect the leader window, submit.
4. **Lifecycle tracker** — confirm landing via **stream subscription** (not RPC
   polling alone); record submitted/processed/confirmed/finalized with slots,
   timestamps, latency deltas.
5. **Failure classifier** — expired blockhash, fee too low, compute exceeded,
   bundle failure.
6. **AI agent** — owns **Autonomous Retry with Fault Injection**: we inject a
   blockhash-expiry failure; the agent detects it, reasons about the cause (via
   Claude), decides to refresh the blockhash and recalc the tip, and resubmits —
   reasoning visible in logs, no hardcoded retry flow.
7. **Logger** — JSONL lifecycle log; a runner script that performs ≥10 real bundle
   submissions including ≥2 forced/real failures.

### Why "Autonomous Retry with Fault Injection" for the AI decision
It's the most *self-contained and demonstrable* of the four options: we can
deterministically inject a blockhash expiry, so the agent's reasoning is
reproducible for judges, and it naturally exercises tip recalculation + retry —
covering more surface than the others. Visible chain-of-reasoning logged per retry.

---

## 4. Deliverables → requirements checklist

- [ ] Open-source repo (`smart-tx-stack`) with clear setup instructions
- [ ] Stream layer w/ reconnect + backpressure (Yellowstone gRPC)
- [ ] Dynamic Jito tip calculation from live tip-account data
- [ ] Leader-window detection + Jito bundle submission
- [ ] Lifecycle tracking via stream (submitted→processed→confirmed→finalized)
- [ ] Failure classifier (4 classes) + automatic retry w/ blockhash refresh
- [ ] **Lifecycle log:** ≥10 real bundles, ≥2 failures, slots/timestamps/tips/class
- [ ] **AI agent** making a real, reasoned retry decision (logged reasoning)
- [ ] **Architecture doc** (separate public URL) w/ diagrams
- [ ] **README** answering the 3 required questions from real observations
- [ ] Working prototype on mainnet (or Jito testnet)

### The 3 README questions (we answer from real run data)
1. processed_at → confirmed_at delta as a network-health signal.
2. Why never use `finalized` commitment for a time-sensitive blockhash.
3. What happens to a bundle if the Jito leader skips their slot.
*(We draft accurate answers and back them with numbers from our own logs.)*

---

## 5. Recommended stack & phased plan

**Language: TypeScript** (recommended) — mature `@triton-one/yellowstone-grpc`,
Jito `jito-ts`, and `@anthropic-ai/sdk` for the agent; fastest path to a *running*
system within the deadline. (Rust scores marginally higher on "depth of
integration" but risks not finishing the real-network evidence in time. Open to
Rust if you prefer.)

| Phase | Work | Est. |
| ----- | ---- | ---- |
| 0 | Provider access + funded wallet + key wiring; "hello slot stream" | 1–2 days |
| 1 | Submitter + Jito bundle + dynamic tip + leader window | 2–3 days |
| 2 | Lifecycle tracker via stream + failure classifier | 2–3 days |
| 3 | Retry engine + fault injection harness | 1–2 days |
| 4 | AI agent (Claude) owning the retry decision, reasoning logged | 2 days |
| 5 | Run ≥10 bundles incl. failures; collect lifecycle log | 1 day |
| 6 | Architecture doc + README answers from real data | 1–2 days |

Realistic total: **~1.5–2.5 weeks**, deadline gives ~3 — workable if providers
are sorted early. Phase 0 is the critical path.

---

## 6. Risks & mitigations

- **Jito ≠ devnet.** → Use mainnet (tiny tips) or Jito testnet; confirm choice up front.
- **Real SOL for mainnet tips/fees.** → Keep txs trivial (self-transfer/memo), small tips; budget ~0.3 SOL.
- **Provider onboarding lag (SolInfra credits).** → Apply day 1; have Helius free-tier Yellowstone as fallback.
- **Bundle landing under competition.** → Submit non-competitive txs; agent tunes tip; some failures are *fine* (spec wants ≥2).
- **"AI wrapper" disqualifier.** → Agent must show real reasoning; we log the prompt+decision+rationale per retry, not sequential calls.
- **Stream reliability.** → Implement reconnect/backpressure from the start (also a scored requirement).

---

## 7. Decisions needed from you before Phase 0

1. **Network:** mainnet (most credible, needs real SOL) vs Jito testnet (free-ish)?
2. **Providers:** apply for SolInfra credits, or use Helius/Triton (which account)?
3. **Anthropic API key** for the agent — can you provide one?
4. **Language:** TypeScript (recommended) or Rust?
5. **Doc host:** Notion / Google Doc / Figma — which will you publish to?
