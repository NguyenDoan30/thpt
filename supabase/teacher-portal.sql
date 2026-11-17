-- Run after sync.sql in the Supabase SQL Editor as postgres.
-- This adds explicit, read-only teacher access without changing school snapshots.
-- Safe to run again. No password or secret key belongs in browser code.
begin;

create or replace function public.school_teacher_key(p_name text)
returns text language sql immutable set search_path = ''
as $function$
  select pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
$function$;
alter function public.school_teacher_key(text) owner to postgres;
revoke all on function public.school_teacher_key(text) from public, anon, authenticated;

create table if not exists public.school_teacher_access (
  owner_id uuid not null references public.school_workspaces(user_id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  teacher_key text not null check (pg_catalog.length(teacher_key) between 1 and 100),
  teacher_name text not null,
  email text not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (owner_id, teacher_id),
  unique (owner_id, teacher_key)
);
alter table public.school_teacher_access owner to postgres;
alter table public.school_teacher_access enable row level security;
-- Clients have no direct access, including teachers and school owners.
revoke all on table public.school_teacher_access from public, anon, authenticated;
revoke all (owner_id, teacher_id, teacher_key, teacher_name, email, created_at)
  on table public.school_teacher_access from public, anon, authenticated;

create or replace function public.manage_teacher_access(
  p_teacher_name text, p_email text, p_enabled boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_owner uuid := auth.uid();
  v_key text := public.school_teacher_key(p_teacher_name);
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_payload jsonb;
  v_teacher jsonb;
  v_teacher_id uuid;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_enabled is null or pg_catalog.length(v_key) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_teacher_access';
  end if;
  select payload into v_payload from public.school_workspaces where user_id = v_owner;
  if not found then
    raise exception using errcode = '42501', message = 'school_workspace_required';
  end if;
  -- Revocation works even after a profile/email is edited or removed.
  if not p_enabled then
    delete from public.school_teacher_access where owner_id = v_owner and teacher_key = v_key;
    return pg_catalog.jsonb_build_object('teacher_name', pg_catalog.btrim(p_teacher_name), 'email', '', 'enabled', false);
  end if;
  select person into v_teacher from pg_catalog.jsonb_array_elements(v_payload -> 'teachers') person
    where public.school_teacher_key(person ->> 'name') = v_key limit 1;
  if not found then
    raise exception using errcode = '22023', message = 'teacher_profile_not_found';
  end if;
  if coalesce(v_teacher ->> 'status', 'Đang giảng dạy') <> 'Đang giảng dạy' then
    raise exception using errcode = '22023', message = 'teacher_not_active';
  end if;
  if pg_catalog.length(v_email) not between 3 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'invalid_teacher_email';
  end if;
  select id into v_teacher_id from auth.users
    where pg_catalog.lower(email) = v_email and email_confirmed_at is not null
    order by id limit 1;
  if not found then
    raise exception using errcode = '22023', message = 'teacher_account_not_found';
  end if;
  if v_teacher_id = v_owner then
    raise exception using errcode = '22023', message = 'teacher_separate_account_required';
  end if;
  -- A new email replaces the old grant for this profile, atomically. One
  -- account may represent only one teacher at a particular school.
  if exists(select 1 from public.school_teacher_access
      where owner_id = v_owner and teacher_id = v_teacher_id and teacher_key <> v_key) then
    raise exception using errcode = '22023', message = 'account_already_linked';
  end if;
  insert into public.school_teacher_access(owner_id, teacher_id, teacher_key, teacher_name, email)
    values(v_owner, v_teacher_id, v_key, v_teacher ->> 'name', v_email)
    on conflict (owner_id, teacher_key) do update
      set teacher_id = excluded.teacher_id, teacher_name = excluded.teacher_name,
          email = excluded.email, created_at = pg_catalog.clock_timestamp();
  return pg_catalog.jsonb_build_object('teacher_name', v_teacher ->> 'name', 'email', v_email, 'enabled', true);
end;
$function$;

create or replace function public.list_school_teacher_access()
returns jsonb language plpgsql security definer set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  return coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'teacher_name', a.teacher_name, 'email', a.email, 'enabled', true)
      order by a.teacher_name)
    from public.school_teacher_access a where a.owner_id = auth.uid()), '[]'::jsonb);
end;
$function$;

create or replace function public.list_teacher_schools()
returns jsonb language plpgsql security definer set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  return coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner_id', a.owner_id, 'teacher_name', person ->> 'name',
      'school', pg_catalog.jsonb_build_object('name', w.payload #>> '{school,name}', 'avatar', w.payload #> '{school,avatar}'))
      order by w.payload #>> '{school,name}', a.owner_id)
    from public.school_teacher_access a
    join public.school_workspaces w on w.user_id = a.owner_id
    cross join lateral pg_catalog.jsonb_array_elements(w.payload -> 'teachers') person
    where a.teacher_id = auth.uid()
      and public.school_teacher_key(person ->> 'name') = a.teacher_key
      and coalesce(person ->> 'status', 'Đang giảng dạy') = 'Đang giảng dạy'), '[]'::jsonb);
end;
$function$;

create or replace function public.get_teacher_portal(p_owner_id uuid, p_year text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_workspace public.school_workspaces%rowtype;
  v_teacher jsonb;
  v_year text;
  v_record jsonb;
  v_classes jsonb;
  v_assignments jsonb;
  v_schedule jsonb;
  v_profiles jsonb;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select a.teacher_key into v_key from public.school_teacher_access a
    where a.owner_id = p_owner_id and a.teacher_id = v_user;
  if not found then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  select * into v_workspace from public.school_workspaces where user_id = p_owner_id;
  if not found then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  select person into v_teacher from pg_catalog.jsonb_array_elements(v_workspace.payload -> 'teachers') person
    where public.school_teacher_key(person ->> 'name') = v_key limit 1;
  if not found or coalesce(v_teacher ->> 'status', 'Đang giảng dạy') <> 'Đang giảng dạy' then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  v_year := coalesce(p_year, v_workspace.payload ->> 'current');
  if not coalesce((v_workspace.payload -> 'years') ? v_year, false) then
    raise exception using errcode = '22023', message = 'school_year_not_found';
  end if;
  v_record := v_workspace.payload -> 'years' -> v_year;
  -- Class membership is recomputed from the current saved snapshot on every
  -- request. A removed assignment/grant or retired profile loses access next read.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c ->> 'id', 'name', c ->> 'name', 'grade', c ->> 'grade',
      'students', c -> 'students', 'teacher', c ->> 'teacher', 'room', c ->> 'room',
      'status', c ->> 'status', 'admissionYear', c -> 'admissionYear',
      'isHomeroom', public.school_teacher_key(c ->> 'teacher') = v_key)
      order by c ->> 'name'), '[]'::jsonb)
    into v_classes
    from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'classes', '[]'::jsonb)) c
    where coalesce(c ->> 'status', '') <> 'Đã tốt nghiệp'
      and (public.school_teacher_key(c ->> 'teacher') = v_key
        or exists(select 1 from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'assignments', '[]'::jsonb)) a
          where a ->> 'classId' = c ->> 'id' and public.school_teacher_key(a ->> 'name') = v_key));
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', a ->> 'id', 'name', v_teacher ->> 'name', 'classId', a ->> 'classId', 'subject', a ->> 'subject')
      order by a ->> 'classId', a ->> 'subject'), '[]'::jsonb)
    into v_assignments from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'assignments', '[]'::jsonb)) a
    where public.school_teacher_key(a ->> 'name') = v_key
      and exists(select 1 from pg_catalog.jsonb_array_elements(v_classes) c where c ->> 'id' = a ->> 'classId');
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s ->> 'id', 'classId', s ->> 'classId', 'day', s -> 'day', 'period', s -> 'period',
      'subject', s ->> 'subject', 'teacher', v_teacher ->> 'name', 'room', s ->> 'room')
      order by s ->> 'day', s ->> 'period', s ->> 'classId'), '[]'::jsonb)
    into v_schedule from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'schedule', '[]'::jsonb)) s
    where public.school_teacher_key(s ->> 'teacher') = v_key
      and exists(select 1 from pg_catalog.jsonb_array_elements(v_classes) c where c ->> 'id' = s ->> 'classId');
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s ->> 'id', 'classId', s ->> 'classId', 'fullName', s ->> 'fullName',
      'birthDate', s ->> 'birthDate', 'isSample', s -> 'isSample') order by s ->> 'fullName'), '[]'::jsonb)
    into v_profiles from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'studentProfiles', '[]'::jsonb)) s
    where exists(select 1 from pg_catalog.jsonb_array_elements(v_classes) c where c ->> 'id' = s ->> 'classId');
  return pg_catalog.jsonb_build_object(
    'school', pg_catalog.jsonb_build_object('name', v_workspace.payload #>> '{school,name}', 'avatar', v_workspace.payload #> '{school,avatar}'),
    'teacher', pg_catalog.jsonb_build_object('name', v_teacher ->> 'name', 'email', v_teacher ->> 'email',
      'phone', v_teacher ->> 'phone', 'status', v_teacher ->> 'status', 'subjects', v_teacher -> 'subjects'),
    'years', (select pg_catalog.jsonb_agg(key order by key desc) from pg_catalog.jsonb_object_keys(v_workspace.payload -> 'years') key),
    'current', v_year, 'classes', v_classes, 'assignments', v_assignments,
    'schedule', v_schedule, 'studentProfiles', v_profiles,
    'revision', v_workspace.revision, 'updated_at', v_workspace.updated_at);
end;
$function$;

alter function public.manage_teacher_access(text, text, boolean) owner to postgres;
alter function public.list_school_teacher_access() owner to postgres;
alter function public.list_teacher_schools() owner to postgres;
alter function public.get_teacher_portal(uuid, text) owner to postgres;
revoke all on function public.manage_teacher_access(text, text, boolean) from public, anon, authenticated;
revoke all on function public.list_school_teacher_access() from public, anon, authenticated;
revoke all on function public.list_teacher_schools() from public, anon, authenticated;
revoke all on function public.get_teacher_portal(uuid, text) from public, anon, authenticated;
grant execute on function public.manage_teacher_access(text, text, boolean) to authenticated;
grant execute on function public.list_school_teacher_access() to authenticated;
grant execute on function public.list_teacher_schools() to authenticated;
grant execute on function public.get_teacher_portal(uuid, text) to authenticated;

comment on table public.school_teacher_access is 'Explicit school-owner grants to existing verified teacher accounts. No direct client access.';
comment on function public.get_teacher_portal(uuid, text) is 'Read-only, server-filtered teacher data. Never returns the complete school snapshot or student CCCD.';
notify pgrst, 'reload schema';
commit;
\n

-- Teacher gradebooks are stored separately from school snapshots so scores
-- survive edits and transitions between academic years.
begin;
create table if not exists public.school_teacher_gradebooks (
  owner_id uuid not null references public.school_workspaces(user_id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  school_year text not null check (pg_catalog.length(school_year) between 1 and 20),
  class_id text not null check (pg_catalog.length(class_id) between 1 and 120),
  subject text not null check (pg_catalog.length(subject) between 1 and 120),
  assessment_id uuid not null,
  assessment_name text not null check (pg_catalog.length(pg_catalog.btrim(assessment_name)) between 1 and 100),
  scores jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(scores) = 'object'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (owner_id, teacher_id, school_year, class_id, subject, assessment_id)
);
alter table public.school_teacher_gradebooks owner to postgres;
alter table public.school_teacher_gradebooks enable row level security;
revoke all on table public.school_teacher_gradebooks from public, anon, authenticated;
revoke all (owner_id, teacher_id, school_year, class_id, subject, assessment_id, assessment_name, scores, created_at, updated_at)
  on table public.school_teacher_gradebooks from public, anon, authenticated;

create or replace function public.list_teacher_gradebooks(
  p_owner_id uuid, p_year text, p_class_id text, p_subject text
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_payload jsonb;
  v_teacher jsonb;
  v_record jsonb;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select a.teacher_key into v_key from public.school_teacher_access a
    where a.owner_id = p_owner_id and a.teacher_id = v_user;
  if not found then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  select w.payload into v_payload from public.school_workspaces w where w.user_id = p_owner_id;
  if not found or not coalesce((v_payload -> 'years') ? p_year, false) then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  select person into v_teacher from pg_catalog.jsonb_array_elements(coalesce(v_payload -> 'teachers', '[]'::jsonb)) person
    where public.school_teacher_key(person ->> 'name') = v_key limit 1;
  if v_teacher is null or coalesce(v_teacher ->> 'status', 'Đang giảng dạy') <> 'Đang giảng dạy' then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  v_record := v_payload -> 'years' -> p_year;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'classes', '[]'::jsonb)) c
      where c ->> 'id' = p_class_id and coalesce(c ->> 'status', '') <> 'Đã tốt nghiệp')
    or not exists(select 1 from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'assignments', '[]'::jsonb)) a
      where a ->> 'classId' = p_class_id
        and public.school_teacher_key(a ->> 'name') = v_key
        and pg_catalog.btrim(a ->> 'subject') = p_subject) then
    raise exception using errcode = '42501', message = 'teacher_assignment_denied';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', g.assessment_id::text, 'title', g.assessment_name,
      'scores', g.scores, 'updatedAt', g.updated_at
    ) order by g.updated_at desc)
    from public.school_teacher_gradebooks g
    where g.owner_id = p_owner_id and g.teacher_id = v_user and g.school_year = p_year
      and g.class_id = p_class_id and g.subject = p_subject
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.save_teacher_gradebook(
  p_owner_id uuid, p_year text, p_class_id text, p_subject text,
  p_assessment_id uuid, p_title text, p_scores jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_payload jsonb;
  v_teacher jsonb;
  v_record jsonb;
  v_entry record;
  v_score numeric;
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_saved public.school_teacher_gradebooks%rowtype;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_assessment_id is null or pg_catalog.length(v_title) not between 1 and 100
      or p_scores is null or pg_catalog.jsonb_typeof(p_scores) <> 'object'
      or pg_catalog.jsonb_object_length(p_scores) > 1000 then
    raise exception using errcode = '22023', message = 'invalid_gradebook';
  end if;
  select a.teacher_key into v_key from public.school_teacher_access a
    where a.owner_id = p_owner_id and a.teacher_id = v_user;
  if not found then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  select w.payload into v_payload from public.school_workspaces w where w.user_id = p_owner_id;
  if not found or not coalesce((v_payload -> 'years') ? p_year, false) then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  select person into v_teacher from pg_catalog.jsonb_array_elements(coalesce(v_payload -> 'teachers', '[]'::jsonb)) person
    where public.school_teacher_key(person ->> 'name') = v_key limit 1;
  if v_teacher is null or coalesce(v_teacher ->> 'status', 'Đang giảng dạy') <> 'Đang giảng dạy' then
    raise exception using errcode = '42501', message = 'teacher_access_denied';
  end if;
  v_record := v_payload -> 'years' -> p_year;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'classes', '[]'::jsonb)) c
      where c ->> 'id' = p_class_id and coalesce(c ->> 'status', '') <> 'Đã tốt nghiệp')
    or not exists(select 1 from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'assignments', '[]'::jsonb)) a
      where a ->> 'classId' = p_class_id
        and public.school_teacher_key(a ->> 'name') = v_key
        and pg_catalog.btrim(a ->> 'subject') = p_subject) then
    raise exception using errcode = '42501', message = 'teacher_assignment_denied';
  end if;
  for v_entry in select key, value from pg_catalog.jsonb_each(p_scores) loop
    if not exists(select 1 from pg_catalog.jsonb_array_elements(coalesce(v_record -> 'studentProfiles', '[]'::jsonb)) s
        where s ->> 'id' = v_entry.key and s ->> 'classId' = p_class_id) then
      raise exception using errcode = '22023', message = 'student_not_in_assigned_class';
    end if;
    if pg_catalog.jsonb_typeof(v_entry.value) <> 'null' then
      if pg_catalog.jsonb_typeof(v_entry.value) <> 'number' then
        raise exception using errcode = '22023', message = 'invalid_grade_score';
      end if;
      v_score := (v_entry.value #>> '{}')::numeric;
      if v_score < 0 or v_score > 10 or v_score * 10 <> pg_catalog.trunc(v_score * 10) then
        raise exception using errcode = '22023', message = 'invalid_grade_score';
      end if;
    end if;
  end loop;
  insert into public.school_teacher_gradebooks(
    owner_id, teacher_id, school_year, class_id, subject, assessment_id, assessment_name, scores, updated_at
  ) values (
    p_owner_id, v_user, p_year, p_class_id, p_subject, p_assessment_id, v_title, p_scores, pg_catalog.clock_timestamp()
  )
  on conflict (owner_id, teacher_id, school_year, class_id, subject, assessment_id)
  do update set assessment_name = excluded.assessment_name, scores = excluded.scores,
    updated_at = pg_catalog.clock_timestamp()
  returning * into v_saved;
  return pg_catalog.jsonb_build_object(
    'id', v_saved.assessment_id::text, 'title', v_saved.assessment_name,
    'scores', v_saved.scores, 'updatedAt', v_saved.updated_at
  );
end;
$function$;

alter function public.list_teacher_gradebooks(uuid, text, text, text) owner to postgres;
alter function public.save_teacher_gradebook(uuid, text, text, text, uuid, text, jsonb) owner to postgres;
revoke all on function public.list_teacher_gradebooks(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.save_teacher_gradebook(uuid, text, text, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.list_teacher_gradebooks(uuid, text, text, text) to authenticated;
grant execute on function public.save_teacher_gradebook(uuid, text, text, text, uuid, text, jsonb) to authenticated;
comment on table public.school_teacher_gradebooks is 'Teacher-entered scores scoped to the assigned teacher, class, subject and academic year. No direct client access.';
comment on function public.list_teacher_gradebooks(uuid, text, text, text) is 'Lists a teacher account''s gradebooks only for an active class and current subject assignment.';
comment on function public.save_teacher_gradebook(uuid, text, text, text, uuid, text, jsonb) is 'Saves scores only for the caller''s assigned subject and the students currently in that class.';
notify pgrst, 'reload schema';
commit;
