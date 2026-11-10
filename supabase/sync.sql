-- Run this entire file once in the Supabase Dashboard SQL Editor as postgres.
-- Safe to run again: it does not replace, clear, or migrate existing snapshots.
-- No database password, service_role key, or other secret belongs in the site.

begin;

create table if not exists public.school_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null,
  revision bigint not null default 1 check (revision >= 1),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.school_workspaces owner to postgres;
alter table public.school_workspaces enable row level security;

-- Clients may only read their own snapshot. All writes go through the RPC below.
revoke all privileges on table public.school_workspaces from public, anon, authenticated;
revoke all privileges (user_id, payload, revision, updated_at)
  on table public.school_workspaces from public, anon, authenticated;
grant select on table public.school_workspaces to authenticated;

drop policy if exists school_workspaces_select_own on public.school_workspaces;
create policy school_workspaces_select_own
  on public.school_workspaces
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Also constrain any policies added in a later dashboard change to this account.
drop policy if exists school_workspaces_owner_guard on public.school_workspaces;
create policy school_workspaces_owner_guard
  on public.school_workspaces as restrictive
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.save_school_workspace(
  p_expected_revision bigint,
  p_payload jsonb
)
returns setof public.school_workspaces
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_avatar text;
  v_saved public.school_workspaces%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid_expected_revision';
  end if;

  -- Validate the envelope without discarding any fields inside the workspace.
  -- 8 MiB is measured before database compression, including the avatar.
  if p_payload is null
    or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
    or pg_catalog.octet_length(p_payload::text) > 8388608
    or (p_payload -> 'version') is distinct from '1'::jsonb
    or pg_catalog.jsonb_typeof(p_payload -> 'current') is distinct from 'string'
    or pg_catalog.length(p_payload ->> 'current') not between 1 and 100
    or pg_catalog.jsonb_typeof(p_payload -> 'years') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_payload -> 'teachers') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_payload -> 'school') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_payload #> '{school,name}') is distinct from 'string'
    or pg_catalog.length(p_payload #>> '{school,name}') not between 1 and 100
    or not ((p_payload -> 'school') ? 'avatar')
  then
    raise exception using errcode = '22023', message = 'invalid_workspace_payload';
  end if;

  if (p_payload #> '{school,avatar}') is distinct from 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_payload #> '{school,avatar}') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'invalid_school_avatar';
    end if;
    v_avatar := p_payload #>> '{school,avatar}';
    -- The browser normalizes uploaded images to a PNG data URI (max 1 MiB text).
    -- Restrict alphabet/padding and require the standard PNG signature prefix.
    if pg_catalog.octet_length(v_avatar) > 1048576
      or v_avatar !~ '^data:image/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$'
      or pg_catalog.length(pg_catalog.substr(v_avatar, 23)) % 4 <> 0
    then
      raise exception using errcode = '22023', message = 'invalid_school_avatar';
    end if;
  end if;

  if p_expected_revision = 0 then
    -- A unique key serializes concurrent first saves. Never overwrite a row.
    insert into public.school_workspaces (user_id, payload, revision, updated_at)
      values (v_user_id, p_payload, 1, pg_catalog.clock_timestamp())
      on conflict (user_id) do nothing
      returning * into v_saved;
  else
    -- PostgreSQL rechecks this condition after waiting for a concurrent writer.
    update public.school_workspaces
      set payload = p_payload,
          revision = revision + 1,
          updated_at = pg_catalog.clock_timestamp()
      where user_id = v_user_id and revision = p_expected_revision
      returning * into v_saved;
  end if;

  if not found then
    raise exception using errcode = 'P0001', message = 'sync_conflict';
  end if;

  return next v_saved;
  return;
end;
$function$;

-- The trusted owner is intentional: RLS protects direct reads, while this
-- narrowly scoped function writes only auth.uid() and controls every revision.
alter function public.save_school_workspace(bigint, jsonb) owner to postgres;
revoke all privileges on function public.save_school_workspace(bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_school_workspace(bigint, jsonb) to authenticated;

comment on table public.school_workspaces is
  'One versioned school workspace per Supabase Auth account; own-row reads only.';
comment on function public.save_school_workspace(bigint, jsonb) is
  'Atomic compare-and-save. Expected revision 0 creates only; stale revisions raise sync_conflict.';

notify pgrst, 'reload schema';
commit;
