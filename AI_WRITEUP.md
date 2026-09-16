# AI-Assisted Development Write-up — OmniAgent

Author: Vedant Wadehra, BTech Computer Science (AI & ML).

## Tools used

- **Muse Spark** (main session): backend, frontend, deployment, debugging,
  testing, and this write-up's project itself, phases 2 through 6.
- **ChatGPT Codex** (earlier session): phases 1 through 5 and the first
  security hardening pass.
- **Parallel subagents**: five automated reviewers that stress-tested the
  tools, the agent loop, the API contract, the UI, and the database setup.

I approved plans before execution, and nothing was committed without a live
passing test.

## What the AI did well

- Project scaffold, sample dataset (20 products, 3 policy documents),
  streaming chat protocol, and deployment configurations.
- Codex's security design (a database role that can only read, never
  write) and its Tavily web-search integration — both kept after I tested
  them live.
- The subagent audit, which found real flaws (listed below) in one pass.

## What I rejected

- **"Host everything on Azure."** Azure's free tier allows only about an
  hour of compute per day with no always-on option, so it could not meet a
  "free and always live" goal. I shipped Render + Vercel instead.
- **Showing raw database errors to users.** My build exposed the real error
  text for easier debugging; Codex flagged that this leaks internals, so I
  replaced it with a generic message.
- **Fake streaming.** My first version split the finished answer into chunks
  to imitate streaming. I rewrote it to forward the model's real live output.

## What I rewrote

- **Dead AI models (twice).** Both the chat model and the embedding model I
  started with had been retired by their providers. I checked the live model
  lists and switched providers without changing the database.
- **Stale web answers.** The assistant quoted two-month-old prices because
  search results carry no usable dates. I routed time-sensitive queries to a
  news index with dates, then added a dedicated price-quote tool so live
  prices come from market data, not articles.
- **Repetitive behavior.** The assistant sometimes searched four times for
  one question or repeated an identical failed call. I added a one-call-per
  price rule, an automatic single retry for network failures only, and a
  warning that stops exact-repeat loops.
- **A security bypass found by audit.** A crafted database query could read
  tables outside the allowed one. I wrote a scanner that checks every table
  mentioned in a query, not just the first.
- **Small correctness bugs caught live:** prices shown in the wrong currency
  symbol for Hindi answers, unrounded decimals, and a health check that
  failed for monitoring probes.

## How I worked

AI drafted; I directed. My constant rules: reproduce every bug before fixing
it, re-test on the public URLs after every deploy, and never trust a claim
— the model's or mine — without measured evidence. Both real outages met
during the project (an exhausted API quota, a Supabase login outage) were
diagnosed from provider error messages, not guessed at.
