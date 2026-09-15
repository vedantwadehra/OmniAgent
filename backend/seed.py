"""Seed Supabase with structured + RAG data for OmniAgent (Phase 2).

Usage:
    cd backend
    .venv/bin/python seed.py

Env required (.env):
    SUPABASE_URL=https://your-project.supabase.co
    SUPABASE_KEY=your-service-role-key  (service_role needed to insert + create via RPC if available)
    GEMINI_API_KEY=your-gemini-api-key

What it does:
    1. Tries to create schema via RPC `exec_sql` if you created that helper.
       If that RPC does not exist (default), it prints MANUAL_SQL for the
       Supabase Dashboard -> SQL Editor and continues to seeding.
    2. Seeds `ecommerce_inventory` with 20 realistic rows (idempotent).
    3. Generates embeddings via Gemini `models/gemini-embedding-001` (768 dims)
       and seeds `store_documents` with 3 detailed store policies.
    4. Prints the `readonly_agent` least-privilege SQL for manual run.

No heavy frameworks. Pure supabase-py + google-generativeai calls.
"""

import os
import sys

from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

EMBED_MODEL = "models/gemini-embedding-001"
EMBED_DIMS = 768  # truncated from 3072 via output_dimensionality to fit vector(768)

# ---------------------------------------------------------------------------
# Manual DDL — run this in Supabase Dashboard -> SQL Editor BEFORE seed.py
# inserts (seed.py will also print this if auto-DDL is unavailable).
# ---------------------------------------------------------------------------
MANUAL_SQL = """-- OmniAgent Phase 2 schema (run once in Supabase SQL Editor)
create extension if not exists vector;

-- 1) Structured data
create table if not exists public.ecommerce_inventory (
  id bigint generated always as identity primary key,
  product_name text not null,
  category text not null,
  price numeric(10, 2) not null check (price >= 0),
  stock_quantity integer not null check (stock_quantity >= 0)
);
create unique index if not exists ecommerce_inventory_product_name_key
  on public.ecommerce_inventory (product_name);

-- 2) RAG data (768 dims = gemini-embedding-001 truncated to 768)
create table if not exists public.store_documents (
  id bigint generated always as identity primary key,
  title text not null,
  content text not null,
  embedding vector(768)
);
create unique index if not exists store_documents_title_key
  on public.store_documents (title);
create index if not exists store_documents_embedding_idx
  on public.store_documents using ivfflat (embedding vector_cosine_ops) with (lists = 10);

-- 3) Cosine-similarity RPC used by search_documents() in Phase 3
create or replace function public.match_store_documents(query_embedding vector(768), match_count int default 2)
returns table (id bigint, title text, content text, similarity float)
language sql stable
as $$
  with ranked_matches as (
    select id, title, content,
           1 - (store_documents.embedding <=> query_embedding) as similarity
    from public.store_documents
    where store_documents.embedding is not null
  )
  select id, title, content, similarity
  from ranked_matches
  where similarity >= 0.35
  order by similarity desc
  limit match_count;
$$;
"""

READONLY_SQL = """-- OmniAgent read-only role (run once in Supabase SQL Editor)
-- The SQL RPC is owned by this no-login role, so injected SQL cannot modify data.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'readonly_agent') then
    create role readonly_agent nologin;
  end if;
end
$$;
grant readonly_agent to postgres;
grant usage on schema public to readonly_agent;
grant select on table public.ecommerce_inventory to readonly_agent;
revoke all on all sequences in schema public from readonly_agent;
"""

INVENTORY_ROWS = [
    {"product_name": "Aurora Wireless Headphones", "category": "Audio", "price": 129.99, "stock_quantity": 42},
    {"product_name": "Pulse True-Wireless Earbuds", "category": "Audio", "price": 79.50, "stock_quantity": 120},
    {"product_name": "BoomBox Portable Speaker", "category": "Audio", "price": 59.99, "stock_quantity": 8},
    {"product_name": "Studio Monitor Headset Pro", "category": "Audio", "price": 249.00, "stock_quantity": 15},
    {"product_name": "Orbit Smartwatch S2", "category": "Wearables", "price": 199.99, "stock_quantity": 35},
    {"product_name": "Pulse Fitness Band", "category": "Wearables", "price": 49.99, "stock_quantity": 200},
    {"product_name": "Halo Smart Ring", "category": "Wearables", "price": 149.00, "stock_quantity": 0},
    {"product_name": "Nimbus Laptop 14 Air", "category": "Computing", "price": 899.00, "stock_quantity": 12},
    {"product_name": "Vertex Mechanical Keyboard", "category": "Computing", "price": 89.99, "stock_quantity": 67},
    {"product_name": "Glide Wireless Mouse", "category": "Computing", "price": 34.99, "stock_quantity": 150},
    {"product_name": "Lumen 27in 4K Monitor", "category": "Computing", "price": 329.99, "stock_quantity": 9},
    {"product_name": "Volt 65W GaN Charger", "category": "Accessories", "price": 29.99, "stock_quantity": 300},
    {"product_name": "Braided USB-C Cable 2m", "category": "Accessories", "price": 14.99, "stock_quantity": 500},
    {"product_name": "Atlas Laptop Backpack", "category": "Accessories", "price": 69.00, "stock_quantity": 55},
    {"product_name": "Terra Ceramic Pour-Over Set", "category": "Home", "price": 45.50, "stock_quantity": 28},
    {"product_name": "Ember Smart Mug", "category": "Home", "price": 99.95, "stock_quantity": 4},
    {"product_name": "Drift Aroma Diffuser", "category": "Home", "price": 39.99, "stock_quantity": 73},
    {"product_name": "Solstice LED Desk Lamp", "category": "Home", "price": 54.00, "stock_quantity": 19},
    {"product_name": "Trailhead Insulated Bottle 1L", "category": "Outdoors", "price": 27.95, "stock_quantity": 180},
    {"product_name": "Summit 2-Person Tent", "category": "Outdoors", "price": 189.99, "stock_quantity": 6},
]

DOCUMENTS = [
    {
        "title": "Returns & Refunds Policy",
        "content": """Returns & Refunds Policy — OmniMart (effective Jan 2026).

1. 30-day window: Unopened or lightly used items in original packaging can be returned within 30 days of delivery for a full refund to the original payment method. Final-sale and personalized items are excluded.
2. Condition: Items must include all accessories, manuals, and tags. Audio and wearables must be factory-reset before return. If an item arrives damaged or defective, contact support within 7 days with photos for a prepaid label and priority replacement.
3. Process: Start a return from Account > Orders > Request Return, print the prepaid label (US orders over $35), and drop off within 7 days. Refunds post 3-5 business days after warehouse inspection. Shipping fees are non-refundable except for our error.
4. Exchanges: Exchanges for size/color/variant ship free once inspection passes. Out-of-stock exchanges are auto-refunded.
5. Non-returnable: Gift cards, opened software licenses, clearance items marked Final Sale, and Trailhead bottles with engraving cannot be returned for hygiene or licensing reasons.
Contact: support@omnimart.example, Mon-Fri 9am-6pm ET, average response under 4 hours.""",
    },
    {
        "title": "Shipping & Delivery Policy",
        "content": """Shipping & Delivery Policy — OmniMart (effective Jan 2026).

1. Options and rates (US contiguous): Standard (4-6 business days) $4.95, free over $35; Express (2 business days) $12.95; Overnight (next business day if ordered by 2pm ET) $24.95. Alaska, Hawaii, and international calculated at checkout.
2. Processing: Orders placed before 2pm ET ship same business day from our Columbus, OH warehouse; otherwise next business day. Backordered items (e.g., Halo Smart Ring when stock is 0) ship when restocked and you are emailed tracking.
3. Tracking and delays: Every order includes live tracking via Account > Orders. Carriers may add 1-2 days during holidays. If a package shows delivered but is missing, wait 48 hours, check with neighbors, then contact us within 7 days for a carrier investigation and reshipment or refund.
4. Address changes: Addresses can be edited within 2 hours of checkout. After label creation a $6 reroute fee applies.
5. International: Duties and taxes are calculated at checkout for 40+ countries; delivery takes 7-14 days. We do not ship lithium-battery-only parcels to PO boxes.
Lost or late Express orders are auto-credited with the shipping fee on request.""",
    },
    {
        "title": "Warranty & Support Policy",
        "content": """Warranty & Support Policy — OmniMart (effective Jan 2026).

1. Standard warranty: All electronics (Audio, Wearables, Computing) include a 1-year limited warranty covering manufacturing defects, battery failure under normal use, and dead-on-arrival units. Accessories and Home goods include 90 days. Outdoors gear includes 2 years for seams and zippers.
2. What is covered vs not: Covered: faulty drivers, unresponsive sensors, dead pixels (3+), charging faults. Not covered: accidental drops, water damage beyond IP rating, unauthorized repair, normal wear, or consumables like ear tips and cables.
3. Claim process: File at support@omnimart.example with order number, serial, and a short video of the fault. We reply within 1 business day with troubleshooting. If unresolved, we issue an RMA and prepaid label. Replacements ship within 3 business days of receiving the defective unit; refunds offered if replacement stock is unavailable.
4. Extended plan: OmniCare+ ($29/year) extends electronics to 2 years and adds one accidental-damage claim with a $19 service fee.
5. Data privacy: Factory-reset devices before sending. We wipe returned units per NIST 800-88 and never access personal data.
Keep your invoice — warranty starts on delivery date, not order date.""",
    },
]


def require_env() -> None:
    missing = [k for k, v in
               (("SUPABASE_URL", SUPABASE_URL), ("SUPABASE_KEY", SUPABASE_KEY), ("GEMINI_API_KEY", GEMINI_API_KEY))
               if not v]
    if missing:
        print(f"Error: missing env vars: {', '.join(missing)}. Copy .env.example to .env and fill values.")
        sys.exit(1)


def try_auto_ddl(supabase) -> bool:
    """Try to run DDL via an `exec_sql` RPC helper if the user created one.

    Returns True if auto-DDL succeeded, False if manual SQL run is needed.
    Supabase has no raw-SQL endpoint in postgrest, so manual run is expected
    on a fresh project.
    """
    try:
        supabase.rpc("exec_sql", {"sql": MANUAL_SQL}).execute()
        print("Auto-DDL via exec_sql RPC succeeded.")
        return True
    except Exception as e:
        print(f"Auto-DDL skipped ({type(e).__name__}: {str(e)[:200]}).")
        print("Run MANUAL_SQL in Supabase Dashboard > SQL Editor, then re-run seed.py for inserts.")
        return False


def seed_inventory(supabase) -> None:
    try:
        supabase.table("ecommerce_inventory").upsert(
            INVENTORY_ROWS, on_conflict="product_name"
        ).execute()
        print(f"Upserted ecommerce_inventory with {len(INVENTORY_ROWS)} rows.")
    except Exception as e:
        print(f"Error seeding ecommerce_inventory: {e}")
        sys.exit(1)


def embed_text(text: str) -> list[float]:
    import google.generativeai as genai

    genai.configure(api_key=GEMINI_API_KEY)
    result = genai.embed_content(
        model=EMBED_MODEL,
        content=text,
        task_type="retrieval_document",
        output_dimensionality=EMBED_DIMS,
    )
    return result["embedding"]


def seed_documents(supabase) -> None:
    rows = []
    for doc in DOCUMENTS:
        try:
            embedding = embed_text(f"{doc['title']}\n\n{doc['content']}")
            if len(embedding) != EMBED_DIMS:
                print(f"Warning: {doc['title']} embedding dims={len(embedding)}, expected {EMBED_DIMS}.")
        except Exception as e:
            print(f"Error generating embedding for '{doc['title']}': {e}")
            sys.exit(1)
        rows.append({"title": doc["title"], "content": doc["content"], "embedding": embedding})
    try:
        supabase.table("store_documents").upsert(rows, on_conflict="title").execute()
        print(f"Upserted store_documents with {len(rows)} policies (embeddings via {EMBED_MODEL}).")
    except Exception as e:
        print(f"Error seeding store_documents: {e}")
        sys.exit(1)


def main() -> None:
    require_env()
    from supabase import create_client

    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    auto_ok = try_auto_ddl(supabase)
    if not auto_ok:
        print("\n===== MANUAL_SQL (run in Supabase SQL Editor) =====\n" + MANUAL_SQL)

    seed_inventory(supabase)
    seed_documents(supabase)

    print("\n===== READONLY_SQL (run in Supabase SQL Editor) =====\n" + READONLY_SQL)
    print("\nPhase 2 seed complete.")


if __name__ == "__main__":
    main()
