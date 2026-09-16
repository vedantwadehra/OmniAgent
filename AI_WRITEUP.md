# AI-Assisted Development Write-up — OmniAgent

Author: Vedant Wadehra. Assistants used: **Muse Spark** (this session, via
opencode) for phases 2-6, deployment, debugging, and audits; **ChatGPT Codex**
(an earlier parallel session) for phases 1-5 and hardening; five parallel
subagents for the final security/contract audit. Every AI change was executed
only after I approved the plan, and every claim was verified live before commit.

## Where AI output was accepted

- Monorepo scaffold, seed data design (20 inventory rows, 3 policy documents),
  the `readonly_agent` least-privilege design, the SSE event contract
  (`tool_start` / `tool_end` / `token` / `done`), and bounded-history design.
- Codex's Tavily-primary/DuckDuckGo-fallback integration and the Supabase
  `hardening.sql` ownership-transfer fix — both verified live before I kept them.
- The five-agent audit format itself: identical briefs returned comparable
  finding lists, which made triage fast.

## Where I rejected AI output

- **Codex: "deploy both parts on Azure."** Rejected after checking Azure's free
  tier (60 compute-minutes/day, no Always-On): it cannot meet a "free and
  always live" goal. Shipped Render + Vercel + UptimeRobot instead.
- **Codex: detailed database errors to the client.** My build surfaced the real
  exception cause; Codex flagged the leak risk. I reverted to a generic
  message — observability lost, attack surface reduced. Correct tradeoff.
- **Groq `llama-3.3-70b-versatile` default.** Both sessions discovered via the
  account's `/models` list that it was decommissioned; moved to
  `openai/gpt-oss-20b`.
- **My own chunked "streaming" (Phase 4).** Simulated SSE chunks are not
  streaming. Rewrote on Groq's true streamed deltas after Codex's migration.
- **My news-index routing (first version).** Undated general results kept
  winning with stale snapshots, so "prefer newest" was unenforceable. Added
  `topic: news` + surfaced `published_date` instead of trusting the model.

## Where I rewrote AI output

- **Retired models (twice):** `text-embedding-004` and `gemini-2.5-flash`
  were both dead for new keys. I probed `list_models`, switched embeddings to
  `gemini-embedding-001` (truncated to 768 dims, schema untouched) and chat to
  Groq — keeping Gemini embeddings so vectors never needed reseeding.
- **`primp`/`duckduckgo-search` incompatibility:** versioned impersonation
  names crashed the client; I patched the class attributes to generic names
  rather than churning dependencies.
- **Duplicate-call detection:** my single-key version missed parallel repeats
  and case variants; rewrote as a normalized seen-set (audit-confirmed).
- **Comma-join SQL exfiltration** (`FROM inv, store_documents` bypassed the
  allowlist — found by a subagent): I wrote a paren-depth-aware relation
  scanner instead of extending the regex blocklist.
- **Finance behavior:** the model refused a price it had just retrieved, then
  looped 4 searches chasing "today." Fixed structurally, not with more
  prompting alone: a `get_stock_quote` tool (Yahoo Finance) plus an
  anti-repeat rule. Result: one call, one exact quote.
- **Prompt contradictions the model exposed:** "call exactly once" broke
  multi-ticker questions (the model rightly disobeyed) — reworded to once
  per ticker; Hindi answers rendered `$` as rupee-symbol — added a
  USD-symbol rule after catching it live.

## Verification discipline

Nothing was committed on assertion: every fix shipped with a repro test
(blocklists, SSE contracts, quota paths), most re-verified against the
production URLs post-deploy. The two genuine outages met during the project
(Groq 200k/day quota exhaustion, a Supabase dashboard 503) were diagnosed
from provider error payloads, not guessed at — and the quota episode is why
the agent fails fast with an `error` event instead of retrying blindly.

Net: AI did the bulk of drafting, scaffolding, and auditing; I did routing
decisions, every production credential handoff, all live verification, and
every case where "the model said so" conflicted with measured behavior.
