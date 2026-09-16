"""OmniAgent tools. Pure API calls, no LangChain/LlamaIndex.

Four tools, each returns str and never raises:
  - search_web(query) -> top 5 Tavily results (DuckDuckGo fallback)
  - search_documents(query) -> top 2 Supabase pgvector matches
  - query_database(sql_query) -> read-only SELECT via exec_readonly_sql RPC
  - get_stock_quote(ticker) -> latest market quote via Yahoo Finance

Run EXEC_READONLY_SQL_DDL once in Supabase SQL Editor before query_database.
"""

import json
import os
import re
import time
import urllib.request

from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")

EMBED_MODEL = "models/gemini-embedding-001"
EMBED_DIMS = 768
MAX_QUERY_LENGTH = 4000
MAX_SQL_LENGTH = 4000

# Required blocklist + extras for defense in depth. Word boundaries, case-insensitive.
BLOCKED_SQL_RE = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do|execute|merge|replace|prepare|listen|notify|comment|security|handler|into|table)\b",
    re.IGNORECASE,
)
SELECT_ONLY_RE = re.compile(r"^\s*(select|with)\b", re.IGNORECASE | re.DOTALL)
# Queries asking for current information go to the news index (last week).
FRESH_QUERY_RE = re.compile(
    r"\b(right\s+now|today|tonight|current(ly)?|latest|live|this\s+week|breaking|price|prices|stock(s)?|weather|election|score(s)?)\b",
    re.IGNORECASE,
)
SQL_COMMENT_RE = re.compile(r"--|/\*|\*/")
SQL_STRING_LITERAL_RE = re.compile(r"'(?:''|[^'])*'", re.DOTALL)
QUOTED_IDENTIFIER_RE = re.compile(r'"')
SYSTEM_RELATION_RE = re.compile(r"\b(pg_catalog|information_schema|pg_[a-z0-9_]+)\b", re.IGNORECASE)
DANGEROUS_FUNCTION_RE = re.compile(
    r"\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|"
    r"pg_logdir_ls|pg_reload_conf|pg_rotate_logfile|pg_terminate_backend|"
    r"pg_cancel_backend|lo_import|lo_export|dblink|set_config|query_to_xml|"
    r"database_to_xml|table_to_xml|nextval|setval|pg_advisory_lock|"
    r"pg_advisory_xact_lock|dblink_connect|dblink_exec)\s*\(",
    re.IGNORECASE,
)
RELATION_RE = re.compile(r"\b(from|join)\s+([a-z_][a-z0-9_.]*)", re.IGNORECASE)
CTE_RE = re.compile(r"(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(", re.IGNORECASE)
SECOND_RELATION_RE = re.compile(
    r"\b(?:from|join)\s+(?:public\.)?ecommerce_inventory(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s*,",
    re.IGNORECASE,
)

EXEC_READONLY_SQL_DDL = """-- OmniAgent hardened read-only SQL executor (run once in Supabase SQL Editor)
-- The no-login owner has SELECT only on ecommerce_inventory. Even a parser bypass
-- cannot write or drop data because PostgreSQL checks this owner's privileges.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'readonly_agent') then
    create role readonly_agent nologin;
  end if;
end
$$;
-- Supabase SQL Editor runs as `postgres`; it needs membership before it can
-- transfer ownership to the no-login function owner.
grant readonly_agent to postgres;
grant usage on schema public to readonly_agent;
grant select on table public.ecommerce_inventory to readonly_agent;
revoke all on all sequences in schema public from readonly_agent;
grant create on schema public to readonly_agent;

create or replace function public.exec_readonly_sql(sql_query text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '3000ms'
as $$
declare
  result json;
  q text := lower(sql_query);
begin
  if q !~ '^\\s*(select|with)\\M' then
    raise exception 'Only SELECT/WITH queries are allowed';
  end if;
  if q ~ '(--|/\\*|\\*/|;)' then
    raise exception 'Comments and multiple statements are not allowed';
  end if;
  if q ~ '\\m(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do|execute|merge|replace|prepare|listen|notify|comment|security|handler|into|table)\\M' then
    raise exception 'Blocked keyword detected: only read-only SELECT allowed';
  end if;
  execute 'select coalesce(json_agg(t), ''[]''::json) from (' || btrim(sql_query) || ') t' into result;
  return result;
end;
$$;
alter function public.exec_readonly_sql(text) owner to readonly_agent;
revoke create on schema public from readonly_agent;
revoke all on function public.exec_readonly_sql(text) from public;
revoke all on function public.exec_readonly_sql(text) from anon, authenticated;
grant execute on function public.exec_readonly_sql(text) to service_role;
"""

_supabase = None
_genai_configured = False


def _supabase_client():
    global _supabase
    if _supabase is None:
        if not SUPABASE_URL or not SUPABASE_KEY:
            raise RuntimeError("missing SUPABASE_URL / SUPABASE_KEY in backend/.env")
        from supabase import create_client

        _supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _supabase


def _configure_genai():
    global _genai_configured
    if not _genai_configured:
        if not GEMINI_API_KEY:
            raise RuntimeError("missing GEMINI_API_KEY in backend/.env")
        import google.generativeai as genai

        genai.configure(api_key=GEMINI_API_KEY)
        _genai_configured = True


def _format_web_results(query: str, results: list[dict]) -> str:
    """Render provider-neutral web results without exposing provider metadata."""

    if not results:
        return f"No results found for '{query}'."
    lines = []
    for i, result in enumerate(results[:5], 1):
        title = str(result.get("title") or "Untitled").strip()
        url = str(result.get("url") or result.get("href") or "").strip()
        snippet = str(result.get("content") or result.get("body") or "").strip().replace("\n", " ")[:400]
        date = str(result.get("published_date") or result.get("date") or "").strip()[:10]
        entry = f"{i}. {title}\n   URL: {url}"
        if date:
            entry += f"\n   Date: {date}"
        entry += f"\n   Snippet: {snippet}"
        lines.append(entry)
    return "Web results for '{}':\n".format(query) + "\n".join(lines)


def _tavily_results(query: str) -> list[dict] | None:
    """Fetch Tavily results; return None on provider failure for fallback handling.

    Time-sensitive queries go to the news index (last week) so answers are
    current; everything else uses the general index. News items carry
    published dates that the model must prefer.
    """

    if not TAVILY_API_KEY:
        return None
    fresh = bool(FRESH_QUERY_RE.search(query))
    payload = {
        "api_key": TAVILY_API_KEY,
        "query": query,
        "max_results": 5,
        "include_answer": False,
    }
    if fresh:
        payload.update({"topic": "news", "time_range": "week", "search_depth": "basic"})
    else:
        payload.update({"search_depth": "advanced"})
    request = urllib.request.Request(
        "https://api.tavily.com/search",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        return None
    return [result for result in results if isinstance(result, dict)]


def search_web(query: str) -> str:
    """Fetch top web results from Tavily, with DuckDuckGo as a fallback."""
    q = (query or "").strip()
    if not q:
        return "No results found: empty web query."
    if len(q) > MAX_QUERY_LENGTH:
        return "Error: web query exceeds the 4000 character limit."

    if TAVILY_API_KEY:
        tavily_results = _tavily_results(q)
        if tavily_results is not None:
            return _format_web_results(q, tavily_results)

    try:
        from duckduckgo_search import DDGS

        # Compat: duckduckgo-search 7.5.0 lists versioned impersonates
        # (chrome_101...) but primp 2.x only accepts generic names.
        DDGS._impersonates = ("chrome", "safari", "firefox", "edge")  # type: ignore[attr-defined]
        DDGS._impersonates_os = ("windows", "macos", "linux")  # type: ignore[attr-defined]
        with DDGS(timeout=15) as ddgs:
            results = ddgs.text(q, max_results=3)
    except Exception:
        return "Error: web search is temporarily unavailable."
    return _format_web_results(q, results)


TICKER_RE = re.compile(r"^[A-Za-z0-9.\-=]{1,12}$")
YAHOO_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")


def get_stock_quote(ticker: str) -> str:
    """Return the latest market quote for a stock/crypto ticker. Never raises."""
    symbol = (ticker or "").strip().upper().replace(" ", "")
    if not symbol:
        return "No results found: empty ticker."
    if not TICKER_RE.match(symbol):
        return f"Error: '{ticker.strip()}' is not a valid ticker symbol."
    errors: list[str] = []
    for host in YAHOO_HOSTS:
        try:
            req = urllib.request.Request(
                f"https://{host}/v8/finance/chart/{symbol}?interval=1d&range=5d",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read().decode("utf-8"))
            err = (data.get("chart") or {}).get("error")
            if err:
                return f"No results found for ticker '{symbol}'."
            result = (data.get("chart") or {}).get("result") or []
            if not result:
                errors.append("empty response")
                continue
            meta = result[0].get("meta") or {}
            price = meta.get("regularMarketPrice")
            currency = meta.get("currency", "")
            exchange = meta.get("exchangeName", "")
            prev_close = meta.get("chartPreviousClose")
            timestamps = result[0].get("timestamp") or []
            closes = ((result[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
            last_date, last_close = "", ""
            for ts, close in zip(timestamps, closes):
                if close:
                    import datetime as _dt

                    last_date = _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).strftime("%Y-%m-%d")
                    last_close = round(close, 2)
            if price is None:
                price = last_close
            if price is None:
                errors.append("no price in response")
                continue
            parts = [f"{symbol}: {price} {currency}".strip()]
            if last_date:
                parts.append(f"last close {last_close} on {last_date}")
            if prev_close:
                parts.append(f"previous close {round(prev_close, 2)}")
            if exchange:
                parts.append(exchange)
            return (
                "Stock quote: " + ", ".join(parts)
                + ". Intraday quotes delayed ~15 minutes. Source: Yahoo Finance."
            )
        except Exception as e:
            errors.append(f"{type(e).__name__}: {str(e)[:120]}")
            continue
    if errors and all("404" in err for err in errors):
        return f"No results found for ticker '{symbol}'."
    return f"Error: stock quote is temporarily unavailable. ({'; '.join(errors)})"


def search_documents(query: str) -> str:
    """Embed query and return top 2 pgvector matches. Never raises."""
    q = (query or "").strip()
    if not q:
        return "No results found: empty document query."
    if len(q) > MAX_QUERY_LENGTH:
        return "Error: document query exceeds the 4000 character limit."
    try:
        _configure_genai()
        import google.generativeai as genai

        emb = genai.embed_content(
            model=EMBED_MODEL,
            content=q,
            task_type="retrieval_query",
            output_dimensionality=EMBED_DIMS,
        )["embedding"]
    except Exception:
        return "Error: document embedding is temporarily unavailable."
    try:
        sb = _supabase_client()
        rows = []
        # Supabase's API data plane can occasionally return an empty match while
        # warming. Retry once before representing it as a true empty result.
        for attempt in range(2):
            resp = sb.rpc("match_store_documents", {"query_embedding": emb, "match_count": 2}).execute()
            rows = resp.data or []
            if rows or attempt:
                break
            time.sleep(0.15)
    except Exception:
        return "Error: document search is temporarily unavailable."
    if not rows:
        return f"No results found for '{q}' in store documents."
    out = []
    for r in rows[:2]:
        title = r.get("title", "Untitled")
        sim = r.get("similarity", 0)
        content = (r.get("content") or "")[:1500]
        out.append(f"- {title} (similarity {sim:.3f})\n  {content}")
    return "Document matches:\n" + "\n".join(out)


def _format_rows_markdown(rows: list) -> str:
    if not rows:
        return "No results found."
    if isinstance(rows, dict):
        rows = [rows]
    cols = list(rows[0].keys())
    header = "| " + " | ".join(cols) + " |"
    sep = "| " + " | ".join("---" for _ in cols) + " |"
    body = []
    for r in rows[:20]:
        body.append("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")
    note = f"\n({len(rows)} row(s))"
    if len(rows) > 20:
        note += " — showing first 20"
    return "\n".join([header, sep, *body]) + note


def query_database(sql_query: str) -> str:
    """Execute read-only SELECT via exec_readonly_sql RPC. Blocks writes via regex. Never raises."""
    sql = (sql_query or "").strip()
    if not sql:
        return "Error: empty SQL query."
    if len(sql) > MAX_SQL_LENGTH:
        return "Error: SQL query exceeds the 4000 character limit."
    if not SELECT_ONLY_RE.match(sql):
        return "Error: only read-only SELECT/WITH queries are allowed (must start with SELECT or WITH)."
    # Ignore ordinary string contents while checking lexical safeguards. A
    # product name may legitimately contain words such as "drop" or "table".
    inspected_sql = SQL_STRING_LITERAL_RE.sub("''", sql)
    if SQL_COMMENT_RE.search(inspected_sql):
        return "Error: SQL comments are not allowed."
    if QUOTED_IDENTIFIER_RE.search(sql):
        return "Error: quoted SQL identifiers are not allowed."
    # Allow single trailing semicolon only; reject stacked statements.
    inner = sql.rstrip()
    if inner.endswith(";"):
        inner = inner[:-1]
    if ";" in SQL_STRING_LITERAL_RE.sub("''", inner):
        return "Error: multiple SQL statements are not allowed."
    m = BLOCKED_SQL_RE.search(inspected_sql)
    if m:
        return f"Error: blocked keyword '{m.group(1).upper()}'. Only read-only SELECT/WITH queries allowed."
    if DANGEROUS_FUNCTION_RE.search(inspected_sql):
        return "Error: privileged PostgreSQL functions are not allowed."
    if SYSTEM_RELATION_RE.search(inspected_sql):
        return "Error: system schemas and PostgreSQL internal relations are not allowed."
    # The RPC is security-definer, so constrain all direct table access to the
    # inventory dataset (plus CTE aliases defined inside this statement).
    cte_names = {match.lower() for match in CTE_RE.findall(inspected_sql)}
    allowed_relations = {"ecommerce_inventory", "public.ecommerce_inventory", *cte_names}
    for _, relation in RELATION_RE.findall(inspected_sql):
        if relation.lower() not in allowed_relations:
            return "Error: queries may only read from ecommerce_inventory."
    if SECOND_RELATION_RE.search(inspected_sql):
        return "Error: comma-separated table access is not allowed. Use explicit JOIN syntax."
    try:
        sb = _supabase_client()
        # The server-side executor rejects any semicolon, so send the already
        # validated statement minus the single permitted trailing one.
        resp = sb.rpc("exec_readonly_sql", {"sql_query": inner}).execute()
        data = resp.data
    except Exception as e:
        msg = str(e)
        if "exec_readonly_sql" in msg and ("PGRST202" in msg or "not found" in msg.lower() or "schema cache" in msg):
            return "Error: exec_readonly_sql RPC not found. Run EXEC_READONLY_SQL_DDL from tools.py in Supabase SQL Editor."
        return "Error: database query is temporarily unavailable."
    # RPC returns a JSON array (json_agg) — supabase-py may unwrap or nest it.
    rows = data
    if rows is None:
        return "No results found."
    if isinstance(rows, dict):
        rows = [rows]
    if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], list):
        rows = rows[0]
    if isinstance(rows, list) and len(rows) == 0:
        return "No results found."
    if not isinstance(rows, list):
        return str(rows)[:4000]
    if rows and not isinstance(rows[0], dict):
        return str(rows)[:4000]
    return _format_rows_markdown(rows)
