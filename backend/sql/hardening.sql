-- Run once in Supabase Dashboard -> SQL Editor after pulling the hardening update.
-- It is safe to re-run and preserves existing inventory and documents.

create unique index if not exists ecommerce_inventory_product_name_key
  on public.ecommerce_inventory (product_name);
create unique index if not exists store_documents_title_key
  on public.store_documents (title);

create or replace function public.match_store_documents(query_embedding vector(768), match_count int default 2)
returns table (id bigint, title text, content text, similarity float)
language sql stable
as $$
  with ranked_matches as (
    select id, title, content,
           1 - (embedding <=> query_embedding) as similarity
    from public.store_documents
    where embedding is not null
  )
  select id, title, content, similarity
  from ranked_matches
  where similarity >= 0.35
  order by similarity desc
  limit match_count;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'readonly_agent') then
    create role readonly_agent nologin;
  end if;
end
$$;
-- Supabase's SQL Editor executes as `postgres`, which is not a superuser.
-- PostgreSQL requires it to be able to SET ROLE before it can transfer ownership.
grant readonly_agent to postgres;
grant usage on schema public to readonly_agent;
grant select on table public.ecommerce_inventory to readonly_agent;
revoke all on all sequences in schema public from readonly_agent;
-- A role must have CREATE on the containing schema during an ownership transfer.
-- Revoke it immediately after, so the function owner remains read-only.
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
  if q !~ '^\s*(select|with)\M' then
    raise exception 'Only SELECT/WITH queries are allowed';
  end if;
  if q ~ '(--|/\*|\*/|;)' then
    raise exception 'Comments and multiple statements are not allowed';
  end if;
  if q ~ '\m(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do|execute|merge|replace|prepare|listen|notify|comment|security|handler|into|table)\M' then
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
