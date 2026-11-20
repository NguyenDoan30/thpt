-- Run after sync.sql and teacher-portal.sql in the Supabase SQL Editor as postgres.
-- Homework is independent of school snapshots and teacher gradebooks.
-- Safe to run again. Browser clients receive RPC access only.
begin;

create table if not exists public.school_teacher_homework (
  homework_id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null references public.school_workspaces(user_id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  school_year text not null check (pg_catalog.length(school_year) between 1 and 20),
  class_id text not null check (pg_catalog.length(class_id) between 1 and 120),
  subject text not null check (pg_catalog.length(subject) between 1 and 120),
  title text not null check (pg_catalog.length(pg_catalog.btrim(title)) between 1 and 150),
  instructions text not null check (pg_catalog.length(pg_catalog.btrim(instructions)) between 1 and 10000),
  due_date date not null,
  resource_url text not null default '' check (
    pg_catalog.length(resource_url) <= 2000
    and (resource_url = '' or resource_url ~* '^https?://[^[:space:][:cntrl:]]+$')
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.school_teacher_homework owner to postgres;
alter table public.school_teacher_homework enable row level security;
revoke all on table public.school_teacher_homework from public, anon, authenticated;
revoke all (homework_id, owner_id, teacher_id, school_year, class_id, subject,
  title, instructions, due_date, resource_url, created_at, updated_at)
  on table public.school_teacher_homework from public, anon, authenticated;

create index if not exists school_teacher_homework_teacher_year_idx
  on public.school_teacher_homework(owner_id, teacher_id, school_year, due_date, updated_at desc);

create or replace function public.list_teacher_homework(p_owner_id uuid, p_year text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_portal jsonb;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_year is null or pg_catalog.length(p_year) not between 1 and 20 then
    raise exception using errcode = '22023', message = 'invalid_homework';
  end if;
  -- Use the same authoritative grant/profile/year/class filtering as the portal.
  -- Revoked grants, inactive teachers and removed assignments take effect here.
  v_portal := public.get_teacher_portal(p_owner_id, p_year);
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', h.homework_id::text, 'classId', h.class_id, 'subject', h.subject,
      'title', h.title, 'instructions', h.instructions,
      'dueDate', pg_catalog.to_char(h.due_date, 'YYYY-MM-DD'),
      'resourceUrl', h.resource_url, 'createdAt', h.created_at, 'updatedAt', h.updated_at
    ) order by h.due_date, h.updated_at desc, h.homework_id)
    from public.school_teacher_homework h
    where h.owner_id = p_owner_id and h.teacher_id = v_user and h.school_year = p_year
      and exists(select 1
        from pg_catalog.jsonb_array_elements(v_portal -> 'assignments') a
        where a ->> 'classId' = h.class_id and pg_catalog.btrim(a ->> 'subject') = h.subject)
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.save_teacher_homework(
  p_owner_id uuid, p_year text, p_class_id text, p_subject text,
  p_homework_id uuid, p_title text, p_instructions text, p_due_date text, p_resource_url text
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_portal jsonb;
  v_class_id text := pg_catalog.btrim(coalesce(p_class_id, ''));
  v_subject text := pg_catalog.btrim(coalesce(p_subject, ''));
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_instructions text := pg_catalog.btrim(coalesce(p_instructions, ''));
  v_resource_url text := pg_catalog.btrim(coalesce(p_resource_url, ''));
  v_due_date date;
  v_saved public.school_teacher_homework%rowtype;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_year is null or pg_catalog.length(p_year) not between 1 and 20
      or pg_catalog.length(v_class_id) not between 1 and 120
      or pg_catalog.length(v_subject) not between 1 and 120
      or pg_catalog.length(v_title) not between 1 and 150
      or pg_catalog.length(v_instructions) not between 1 and 10000
      or pg_catalog.length(v_resource_url) > 2000
      or (v_resource_url <> '' and v_resource_url !~* '^https?://[^[:space:][:cntrl:]]+$') then
    raise exception using errcode = '22023', message = 'invalid_homework';
  end if;
  if p_due_date is null or p_due_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode = '22023', message = 'invalid_homework_due_date';
  end if;
  begin
    v_due_date := p_due_date::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'invalid_homework_due_date';
  end;
  if pg_catalog.to_char(v_due_date, 'YYYY-MM-DD') <> p_due_date then
    raise exception using errcode = '22023', message = 'invalid_homework_due_date';
  end if;
  v_portal := public.get_teacher_portal(p_owner_id, p_year);
  if not exists(select 1
      from pg_catalog.jsonb_array_elements(v_portal -> 'assignments') a
      where a ->> 'classId' = v_class_id and pg_catalog.btrim(a ->> 'subject') = v_subject) then
    raise exception using errcode = '42501', message = 'teacher_assignment_denied';
  end if;
  -- A supplied, new UUID supports safe retries. A collision may update only
  -- this teacher's row at the same school/year, while its old assignment is
  -- still active. No request can transfer another teacher's homework.
  insert into public.school_teacher_homework as h (
    homework_id, owner_id, teacher_id, school_year, class_id, subject,
    title, instructions, due_date, resource_url
  ) values (
    coalesce(p_homework_id, pg_catalog.gen_random_uuid()), p_owner_id, v_user, p_year,
    v_class_id, v_subject, v_title, v_instructions, v_due_date, v_resource_url
  )
  on conflict (homework_id) do update set
    class_id = excluded.class_id, subject = excluded.subject,
    title = excluded.title, instructions = excluded.instructions,
    due_date = excluded.due_date, resource_url = excluded.resource_url,
    updated_at = pg_catalog.clock_timestamp()
  where h.owner_id = p_owner_id and h.teacher_id = v_user and h.school_year = p_year
    and exists(select 1
      from pg_catalog.jsonb_array_elements(v_portal -> 'assignments') a
      where a ->> 'classId' = h.class_id and pg_catalog.btrim(a ->> 'subject') = h.subject)
  returning * into v_saved;
  if not found then
    raise exception using errcode = '42501', message = 'teacher_homework_denied';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', v_saved.homework_id::text, 'classId', v_saved.class_id, 'subject', v_saved.subject,
    'title', v_saved.title, 'instructions', v_saved.instructions,
    'dueDate', pg_catalog.to_char(v_saved.due_date, 'YYYY-MM-DD'),
    'resourceUrl', v_saved.resource_url, 'createdAt', v_saved.created_at, 'updatedAt', v_saved.updated_at
  );
end;
$function$;

alter function public.list_teacher_homework(uuid, text) owner to postgres;
alter function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text) owner to postgres;
revoke all on function public.list_teacher_homework(uuid, text) from public, anon, authenticated;
revoke all on function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.list_teacher_homework(uuid, text) to authenticated;
grant execute on function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text) to authenticated;
comment on table public.school_teacher_homework is 'Teacher-created homework scoped to the school, author, academic year and current subject assignment. No direct client access.';
comment on function public.list_teacher_homework(uuid, text) is 'Lists only the authenticated teacher''s homework for currently assigned classes and subjects in the requested school year.';
comment on function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text) is 'Creates or updates the authenticated teacher''s homework after checking the active grant, year and subject assignment. Existing creation time is preserved.';
notify pgrst, 'reload schema';
commit;
