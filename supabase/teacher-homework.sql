-- Run after sync.sql and teacher-portal.sql in the Supabase SQL Editor as postgres.
-- Homework is independent of school snapshots and teacher gradebooks.
-- Safe to run again. Homework rows are RPC-only; files use private Storage RLS.
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
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.school_teacher_homework
  add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.school_teacher_homework
  drop constraint if exists school_teacher_homework_attachments_check;
alter table public.school_teacher_homework
  add constraint school_teacher_homework_attachments_check check (
    pg_catalog.jsonb_typeof(attachments) = 'array'
    and pg_catalog.jsonb_array_length(attachments) <= 5
  );
alter table public.school_teacher_homework owner to postgres;
alter table public.school_teacher_homework enable row level security;
revoke all on table public.school_teacher_homework from public, anon, authenticated;
revoke all (homework_id, owner_id, teacher_id, school_year, class_id, subject,
  title, instructions, due_date, resource_url, attachments, created_at, updated_at)
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
      'resourceUrl', h.resource_url, 'attachments', h.attachments,
      'createdAt', h.created_at, 'updatedAt', h.updated_at
    ) order by h.due_date, h.updated_at desc, h.homework_id)
    from public.school_teacher_homework h
    where h.owner_id = p_owner_id and h.teacher_id = v_user and h.school_year = p_year
      and exists(select 1
        from pg_catalog.jsonb_array_elements(v_portal -> 'assignments') a
        where a ->> 'classId' = h.class_id and pg_catalog.btrim(a ->> 'subject') = h.subject)
  ), '[]'::jsonb);
end;
$function$;

-- One signature with a default accepts old nine-argument callers without an
-- ambiguous overload. Omitted/null attachments preserve the existing list.
drop function if exists public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text);
create or replace function public.save_teacher_homework(
  p_owner_id uuid, p_year text, p_class_id text, p_subject text,
  p_homework_id uuid, p_title text, p_instructions text, p_due_date text, p_resource_url text,
  p_attachments jsonb default null
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
  v_homework_id uuid := coalesce(p_homework_id, pg_catalog.gen_random_uuid());
  v_attachments jsonb;
  v_validated_attachments jsonb := '[]'::jsonb;
  v_attachment jsonb;
  v_attachment_ids text[] := array[]::text[];
  v_attachment_id text;
  v_type text;
  v_extension text;
  v_path text;
  v_size bigint;
  v_storage_metadata jsonb;
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
  v_attachments := p_attachments;
  if v_attachments is null then
    select h.attachments into v_attachments
      from public.school_teacher_homework h
      where h.homework_id = v_homework_id and h.owner_id = p_owner_id
        and h.teacher_id = v_user and h.school_year = p_year;
    v_attachments := coalesce(v_attachments, '[]'::jsonb);
  end if;
  if pg_catalog.jsonb_typeof(v_attachments) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_homework_attachments';
  end if;
  if pg_catalog.jsonb_array_length(v_attachments) > 5 then
    raise exception using errcode = '22023', message = 'invalid_homework_attachments';
  end if;
  for v_attachment in select item from pg_catalog.jsonb_array_elements(v_attachments) item loop
    if pg_catalog.jsonb_typeof(v_attachment) is distinct from 'object'
        or pg_catalog.jsonb_typeof(v_attachment -> 'id') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_attachment -> 'name') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_attachment -> 'type') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_attachment -> 'size') is distinct from 'number'
        or pg_catalog.jsonb_typeof(v_attachment -> 'path') is distinct from 'string'
        or (v_attachment ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or pg_catalog.length(pg_catalog.btrim(v_attachment ->> 'name')) not between 1 and 255
        or (v_attachment ->> 'name') ~ '[[:cntrl:]/\\]'
        or (v_attachment ->> 'size') !~ '^[0-9]{1,7}$' then
      raise exception using errcode = '22023', message = 'invalid_homework_attachments';
    end if;
    v_attachment_id := v_attachment ->> 'id';
    v_type := v_attachment ->> 'type';
    v_size := (v_attachment ->> 'size')::bigint;
    v_path := v_attachment ->> 'path';
    v_extension := pg_catalog.lower(pg_catalog.substring(v_path, '\.([a-zA-Z0-9]+)$'));
    if v_size not between 1 and 5242880 or v_attachment_id = any(v_attachment_ids)
        or v_path <> v_user::text || '/' || p_owner_id::text || '/' || v_homework_id::text || '/' || v_attachment_id || '.' || coalesce(v_extension, '')
        or not coalesce(case v_type
          when 'image/png' then v_extension = 'png'
          when 'image/jpeg' then v_extension in ('jpg', 'jpeg')
          when 'image/webp' then v_extension = 'webp'
          when 'image/gif' then v_extension = 'gif'
          when 'application/pdf' then v_extension = 'pdf'
          when 'application/msword' then v_extension = 'doc'
          when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then v_extension = 'docx'
          when 'application/vnd.ms-excel' then v_extension = 'xls'
          when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then v_extension = 'xlsx'
          when 'application/vnd.ms-powerpoint' then v_extension = 'ppt'
          when 'application/vnd.openxmlformats-officedocument.presentationml.presentation' then v_extension = 'pptx'
          when 'text/plain' then v_extension = 'txt'
          else false end, false) then
      raise exception using errcode = '22023', message = 'invalid_homework_attachments';
    end if;
    -- Never accept a public URL, another teacher's object, or client-reported
    -- size/type without checking the object uploaded through Storage first.
    select o.metadata into v_storage_metadata from storage.objects o
      where o.bucket_id = 'teacher-homework-files' and o.name = v_path
        and o.owner_id = v_user::text;
    if not found or (v_storage_metadata ->> 'size')::numeric is distinct from v_size::numeric
        or (v_storage_metadata ->> 'mimetype') is distinct from v_type then
      raise exception using errcode = '22023', message = 'homework_attachment_not_uploaded';
    end if;
    v_attachment_ids := pg_catalog.array_append(v_attachment_ids, v_attachment_id);
    v_validated_attachments := v_validated_attachments || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', v_attachment_id, 'name', v_attachment ->> 'name',
      'type', v_type, 'size', v_size, 'path', v_path
    ));
  end loop;
  v_attachments := v_validated_attachments;
  -- A supplied, new UUID supports safe retries. A collision may update only
  -- this teacher's row at the same school/year, while its old assignment is
  -- still active. No request can transfer another teacher's homework.
  insert into public.school_teacher_homework as h (
    homework_id, owner_id, teacher_id, school_year, class_id, subject,
    title, instructions, due_date, resource_url, attachments
  ) values (
    v_homework_id, p_owner_id, v_user, p_year,
    v_class_id, v_subject, v_title, v_instructions, v_due_date, v_resource_url, v_attachments
  )
  on conflict (homework_id) do update set
    class_id = excluded.class_id, subject = excluded.subject,
    title = excluded.title, instructions = excluded.instructions,
    due_date = excluded.due_date, resource_url = excluded.resource_url,
    attachments = excluded.attachments,
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
    'resourceUrl', v_saved.resource_url, 'attachments', v_saved.attachments,
    'createdAt', v_saved.created_at, 'updatedAt', v_saved.updated_at
  );
end;
$function$;

-- Keep attachments private. Only the author's authenticated session can upload
-- or remove its own objects. Reading a saved attachment also checks its current
-- class/subject assignment; unreferenced draft objects remain accessible to the
-- author so failed saves and removed attachments can be cleaned up.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('teacher-homework-files', 'teacher-homework-files', false, 5242880, array[
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain'
])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_access_teacher_homework_file(p_name text, p_write boolean default false)
returns boolean language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_parts text[] := pg_catalog.string_to_array(p_name, '/');
  v_owner uuid;
  v_homework_id uuid;
  v_homework public.school_teacher_homework%rowtype;
  v_portal jsonb;
begin
  if v_user is null or pg_catalog.array_length(v_parts, 1) is distinct from 4
      or v_parts[1] is distinct from v_user::text
      or v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp|gif|pdf|doc|docx|xls|xlsx|ppt|pptx|txt)$' then
    return false;
  end if;
  v_owner := v_parts[2]::uuid;
  v_homework_id := v_parts[3]::uuid;
  -- Grant/profile checks do not depend on the currently selected school year,
  -- allowing uploads for an assigned previous year before its homework exists.
  if not exists (
    select 1 from public.school_teacher_access a
      join public.school_workspaces w on w.user_id = a.owner_id
      cross join lateral pg_catalog.jsonb_array_elements(w.payload -> 'teachers') person
      where a.owner_id = v_owner and a.teacher_id = v_user
        and public.school_teacher_key(person ->> 'name') = a.teacher_key
        and coalesce(person ->> 'status', 'Đang giảng dạy') = 'Đang giảng dạy'
  ) then
    return false;
  end if;
  if p_write then return true; end if;
  select h.* into v_homework from public.school_teacher_homework h
    where h.homework_id = v_homework_id and h.owner_id = v_owner and h.teacher_id = v_user
      and exists(select 1 from pg_catalog.jsonb_array_elements(h.attachments) item
        where item ->> 'path' = p_name);
  if not found then return true; end if;
  begin
    v_portal := public.get_teacher_portal(v_owner, v_homework.school_year);
  exception when others then
    return false;
  end;
  return exists(select 1 from pg_catalog.jsonb_array_elements(v_portal -> 'assignments') a
    where a ->> 'classId' = v_homework.class_id
      and pg_catalog.btrim(a ->> 'subject') = v_homework.subject);
end;
$function$;
alter function public.can_access_teacher_homework_file(text, boolean) owner to postgres;
revoke all on function public.can_access_teacher_homework_file(text, boolean) from public, anon, authenticated;
grant execute on function public.can_access_teacher_homework_file(text, boolean) to authenticated;

drop policy if exists teacher_homework_files_select on storage.objects;
create policy teacher_homework_files_select on storage.objects for select to authenticated
  using (bucket_id = 'teacher-homework-files'
    and owner_id = (select auth.uid())::text
    and public.can_access_teacher_homework_file(name, false));
drop policy if exists teacher_homework_files_insert on storage.objects;
create policy teacher_homework_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'teacher-homework-files'
    and owner_id = (select auth.uid())::text
    and public.can_access_teacher_homework_file(name, true));
drop policy if exists teacher_homework_files_delete on storage.objects;
create policy teacher_homework_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'teacher-homework-files'
    and owner_id = (select auth.uid())::text
    and public.can_access_teacher_homework_file(name, false));
-- Deliberately no UPDATE policy: upload to a fresh UUID with upsert:false.
-- Restrictive guards keep unrelated, broader Storage policies from bypassing
-- this bucket's author checks. They have no effect on any other bucket.
drop policy if exists teacher_homework_files_select_guard on storage.objects;
create policy teacher_homework_files_select_guard on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'teacher-homework-files' or (
    auth.uid() is not null and owner_id = (select auth.uid())::text
    and public.can_access_teacher_homework_file(name, false)));
drop policy if exists teacher_homework_files_insert_guard on storage.objects;
create policy teacher_homework_files_insert_guard on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'teacher-homework-files' or (
    auth.uid() is not null and owner_id = (select auth.uid())::text
    and public.can_access_teacher_homework_file(name, true)));
drop policy if exists teacher_homework_files_delete_guard on storage.objects;
create policy teacher_homework_files_delete_guard on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'teacher-homework-files' or (
    auth.uid() is not null and owner_id = (select auth.uid())::text
    and public.can_access_teacher_homework_file(name, false)));
drop policy if exists teacher_homework_files_update_guard on storage.objects;
create policy teacher_homework_files_update_guard on storage.objects as restrictive for update to public
  using (bucket_id <> 'teacher-homework-files')
  with check (bucket_id <> 'teacher-homework-files');
drop policy if exists teacher_homework_files_anon_guard on storage.objects;
create policy teacher_homework_files_anon_guard on storage.objects as restrictive for all to anon
  using (bucket_id <> 'teacher-homework-files')
  with check (bucket_id <> 'teacher-homework-files');

alter function public.list_teacher_homework(uuid, text) owner to postgres;
alter function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text, jsonb) owner to postgres;
revoke all on function public.list_teacher_homework(uuid, text) from public, anon, authenticated;
revoke all on function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.list_teacher_homework(uuid, text) to authenticated;
grant execute on function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text, jsonb) to authenticated;
comment on table public.school_teacher_homework is 'Teacher-created homework scoped to the school, author, academic year and current subject assignment. No direct client access.';
comment on function public.list_teacher_homework(uuid, text) is 'Lists only the authenticated teacher''s homework for currently assigned classes and subjects in the requested school year.';
comment on function public.save_teacher_homework(uuid, text, text, text, uuid, text, text, text, text, jsonb) is 'Creates or updates the authenticated teacher''s homework after checking the current assignment and private uploaded attachments. Null attachments preserve the existing list; an empty array removes all attachments.';
notify pgrst, 'reload schema';
commit;
