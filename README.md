# OmniAgent — multi-tool AI assistant

Live app: **https://frontend-woad-three-phz8n9dolh.vercel.app** (no login needed)
Backend: **https://omniagent-backend-xbg6.onrender.com** (`/health`, `POST /api/chat`)

A stripped-down ChatGPT/Claude: the model decides which tool to call for questions
it can't answer alone — web search, policy documents (RAG), inventory SQL, and
live stock quotes — in a real request → execute → return → repeat loop with
streamed Server-Sent Events and visible tool calls.

## Contents

- `backend/` — FastAPI agent (`main.py`, `agent.py`, `tools.py`, `seed.py`, `sql/hardening.sql`)
- `frontend/` — Vite + React + Tailwind chat UI (`src/App.jsx`)

## Run locally

Prereqs: Python 3.11, Node 24, a free Supabase project, and free keys from
Groq, Google AI Studio (Gemini), and Tavily (optional — DuckDuckGo fallback).

```bash
# backend (http://localhost:8000, docs at /docs)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # fill SUPABASE_URL, SUPABASE_KEY (service_role),
                       # GEMINI_API_KEY, GROQ_API_KEY, TAVILY_API_KEY
.venv/bin/python seed.py   # after running the MANUAL_SQL it prints, once,
                           # in Supabase Dashboard → SQL Editor

# frontend (http://localhost:5173)
cd frontend
npm install
echo 'VITE_API_URL=http://localhost:8000' > .env
npm run dev
```

Quick check: `curl -N -X POST localhost:8000/api/chat \
 -H 'Content-Type: application/json' \
 -d '{"messages":[{"role":"user","content":"Which products are low on stock?"}]}'`

## Deploy (current production setup, all free tier)

- **Backend → Render** (Python, Singapore, free plan): Root Directory `backend`,
  Build `pip install -r requirements.txt`,
  Start `uvicorn main:app --host 0.0.0.0 --port $PORT`, Health Check Path
  `/health`, env vars = same six as local `.env` plus `PYTHON_VERSION=3.11.9`.
  Note: env vars set at service-creation time were silently dropped by the
  Render API — set them as a separate step, then redeploy.
- **Frontend → Vercel**: connect the repo, Root Directory `frontend`
  (without this, builds fail with `vite: command not found`), env
  `VITE_API_URL=https://omniagent-backend-xbg6.onrender.com` for
  Production + Preview (baked at build time).
- **Keep-warm → UptimeRobot**: HTTP(s) monitor (not Ping) on
  `…/health`, 5-minute interval. Probes use `HEAD`, so `/health` serves
  `GET` + `HEAD` (a `405` outage taught us that).

## How the agent loop works

```
browser ──POST /api/chat {messages}──▶ FastAPI ──SSE──▶ browser
                                              │
  loop (max 5 rounds):                        │
    1. Groq chat completion (tools attached, streamed)
    2. model emits function_call(s) ──▶ tool_start event
    3. agent.py executes via tools.py ──▶ tool_end event (output + status)
    4. output appended as role=tool message → back to 1.
  final text ──▶ token events (true streaming) ──▶ done (exactly once)
```

- History: the browser sends bounded history (≤16 msgs / 24 kB, tool evidence
  compacted); the backend maps it to Groq roles. Validation rejects empty,
  oversized, or assistant-last payloads with `422`.
- Reliability inside the loop: transient tool errors are retried once in the
  same round; identical repeat calls get a "broaden, don't repeat" nudge kept
  out of the UI; empty outputs feed back so the model tries another angle.
- The UI renders a pill per call (running 🛠️ → done ✅ / failed 🔴,
  click to expand raw output) and streams tokens live.

## Stack choices and why

| Choice | Why |
|---|---|
| Groq `openai/gpt-oss-20b` (was Gemini 2.5-flash — Google retired it for new keys) | Free, fast, OpenAI-compatible function calling with true streaming |
| Gemini `gemini-embedding-001` → 768 dims | pgvector `vector(768)`; `text-embedding-004` was already retired |
| Supabase Postgres + pgvector | One managed free service for structured data and RAG; `match_store_documents` RPC does cosine search |
| Tavily (primary) + DuckDuckGo (fallback) | Tavily returns dated results and works where DDG rate-limits this IP; time-sensitive queries hit Tavily's news index (last 7 days) |
| Yahoo Finance chart API | Free, keyless, exact closes for live-price questions (news can never give "right now") |
| No LangChain/LlamaIndex | Raw SDK calls keep the loop transparent and debuggable |
| Vercel + Render + UptimeRobot | Free tiers that together stay up; the wake-up banner covers cold starts |

## Data generation

`backend/seed.py` (idempotent: clears, then inserts) creates everything:

- `ecommerce_inventory(id, product_name, category, price, stock_quantity)` —
  20 realistic rows across Audio/Wearables/Computing/Accessories/Home/Outdoors,
  including edge stock (0, 4, 6) for interesting queries.
- `store_documents(id, title, content, embedding)` — 3 detailed policies
  (Returns & Refunds, Shipping & Delivery, Warranty & Support), embedded with
  Gemini at seed time; similarity RPC with a 0.35 floor.
- Security: least-privilege `readonly_agent` (NOLOGIN, SELECT-only) owns the
  `exec_readonly_sql(sql)` RPC, which itself only accepts single `SELECT/WITH`
  statements with no comments, stacked statements, writes, privileged
  functions, or system relations. `tools.py` additionally allow-lists
  `ecommerce_inventory` (CTE/derived aliases included, comma-joins scanned)
  and strips string literals before keyword checks so product names like
  `'Drop Shoulder Bag'` stay queryable. Cloudflare in front of Render adds an
  accidental third layer (it 403s raw SQL keywords in request bodies).

## Incomplete / broken / known limits

- **Groq free tier: 200k tokens/day.** Heavy use exhausts it; the API then
  returns `model_request_failed` until reset (~00:00 UTC). No 429 retry by
  design (retries would burn quota faster).
- **Doc-similarity floor (0.35) doesn't separate gibberish** — random text
  still scores ~0.6, so nonsense queries return "matches". Needs an embedding
  study before retuning; left as-is deliberately.
- **Quotes are ~15-min delayed; after hours = last close.** No free source
  gives true tick-level realtime.
- **`javascript:` links**: neutered via `urlTransform`, but model-generated
  links should still be treated as untrusted.
- Render free sleeps after ~15 min idle (UptimeRobot mitigates) and the
  account shares 750 hrs/month across services.
- Conversation history persists in browser `localStorage` (per-browser,
  per-device — not across devices); only the recent window (≤16 messages /
  24 kB) is sent to the model, older turns drop off.
- Minor cosmetics: nested code-in-pre styling, per-message spinner scope,
  stale-online badge if the backend flaps after first connect.
