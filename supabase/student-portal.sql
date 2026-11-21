-- Run after sync.sql, teacher-portal.sql, and teacher-homework.sql as postgres.
-- Student sessions can read only their own class/year data. No public signup or
-- direct client access to workspace, gradebook, or homework tables is granted.
begin;

create or replace function public.list_student_schools()
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_result jsonb;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select pg_catalog.lower(pg_catalog.btrim(u.email)) into v_email
    from auth.users u
    where u.id = v_user and u.email_confirmed_at is not null;
  if v_email is null then
    raise exception using errcode = '42501', message = 'confirmed_student_account_required';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner_id', w.user_id::text,
      'school', pg_catalog.jsonb_build_object(
        'name', w.payload #>> '{school,name}',
        'avatar', w.payload #> '{school,avatar}'
      ),
      'years', matched.years,
      'current', matched.current_year
    ) order by w.payload #>> '{school,name}', w.user_id), '[]'::jsonb)
    into v_result
    from public.school_workspaces w
    cross join lateral (
      select
        coalesce(pg_catalog.jsonb_agg(y.school_year order by y.school_year desc), '[]'::jsonb) as years,
        case
          when pg_catalog.bool_or(y.school_year = w.payload ->> 'current')
            then w.payload ->> 'current'
          else pg_catalog.max(y.school_year)
        end as current_year
      from (
        select yr.key as school_year
        from pg_catalog.jsonb_each(coalesce(w.payload -> 'years', '{}'::jsonb)) yr
        where exists (
          select 1
          from pg_catalog.jsonb_array_elements(coalesce(yr.value -> 'studentProfiles', '[]'::jsonb)) profile
          where pg_catalog.lower(pg_catalog.btrim(coalesce(profile ->> 'email', ''))) = v_email
            and coalesce(profile ->> 'isSample', 'false') <> 'true'
            and coalesce(profile ->> 'id', '') not like 'sample-%'
        )
      ) y
    ) matched
    where pg_catalog.jsonb_array_length(matched.years) > 0;
  return v_result;
end;
$function$;

create or replace function public.get_student_portal(p_owner_id uuid, p_year text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_workspace public.school_workspaces%rowtype;
  v_year text := nullif(pg_catalog.btrim(coalesce(p_year, '')), '');
  v_year_record jsonb;
  v_matches jsonb;
  v_student jsonb;
  v_student_id text;
  v_class_id text;
  v_class jsonb;
  v_years jsonb;
  v_schedule jsonb;
  v_homework jsonb;
  v_grades jsonb;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select pg_catalog.lower(pg_catalog.btrim(u.email)) into v_email
    from auth.users u
    where u.id = v_user and u.email_confirmed_at is not null;
  if v_email is null then
    raise exception using errcode = '42501', message = 'confirmed_student_account_required';
  end if;
  select * into v_workspace from public.school_workspaces w where w.user_id = p_owner_id;
  if not found then
    raise exception using errcode = '42501', message = 'student_access_denied';
  end if;

  select coalesce(pg_catalog.jsonb_agg(yr.key order by yr.key desc), '[]'::jsonb)
    into v_years
    from pg_catalog.jsonb_each(coalesce(v_workspace.payload -> 'years', '{}'::jsonb)) yr
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(yr.value -> 'studentProfiles', '[]'::jsonb)) profile
      where pg_catalog.lower(pg_catalog.btrim(coalesce(profile ->> 'email', ''))) = v_email
        and coalesce(profile ->> 'isSample', 'false') <> 'true'
        and coalesce(profile ->> 'id', '') not like 'sample-%'
    );
  if pg_catalog.jsonb_array_length(v_years) = 0 then
    raise exception using errcode = '42501', message = 'student_access_denied';
  end if;

  if v_year is null then
    v_year := v_workspace.payload ->> 'current';
    if not coalesce(v_years ? v_year, false) then
      v_year := v_years ->> 0;
    end if;
  end if;
  if not coalesce(v_years ? v_year, false) then
    raise exception using errcode = '42501', message = 'student_year_access_denied';
  end if;

  v_year_record := v_workspace.payload -> 'years' -> v_year;
  select coalesce(pg_catalog.jsonb_agg(profile), '[]'::jsonb)
    into v_matches
    from pg_catalog.jsonb_array_elements(coalesce(v_year_record -> 'studentProfiles', '[]'::jsonb)) profile
    where pg_catalog.lower(pg_catalog.btrim(coalesce(profile ->> 'email', ''))) = v_email
      and coalesce(profile ->> 'isSample', 'false') <> 'true'
      and coalesce(profile ->> 'id', '') not like 'sample-%';
  if pg_catalog.jsonb_array_length(v_matches) <> 1 then
    raise exception using errcode = '42501', message = 'student_profile_missing_or_ambiguous';
  end if;
  v_student := v_matches -> 0;
  v_student_id := v_student ->> 'id';
  v_class_id := v_student ->> 'classId';

  select c into v_class
    from pg_catalog.jsonb_array_elements(coalesce(v_year_record -> 'classes', '[]'::jsonb)) c
    where c ->> 'id' = v_class_id
    limit 1;
  if v_class is null then
    raise exception using errcode = '42501', message = 'student_class_not_found';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', item ->> 'id',
      'classId', item ->> 'classId',
      'day', item -> 'day',
      'period', item -> 'period',
      'subject', item ->> 'subject',
      'teacher', item ->> 'teacher',
      'room', item ->> 'room'
    ) order by (item ->> 'day')::integer, (item ->> 'period')::integer), '[]'::jsonb)
    into v_schedule
    from pg_catalog.jsonb_array_elements(coalesce(v_year_record -> 'schedule', '[]'::jsonb)) item
    where item ->> 'classId' = v_class_id;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', h.homework_id::text,
      'classId', h.class_id,
      'subject', h.subject,
      'type', h.homework_type,
      'title', h.title,
      'instructions', h.instructions,
      'dueDate', pg_catalog.to_char(h.due_date, 'YYYY-MM-DD'),
      'resourceUrl', h.resource_url,
      'attachments', h.attachments,
      'createdAt', h.created_at,
      'updatedAt', h.updated_at
    ) order by h.due_date, h.updated_at desc), '[]'::jsonb)
    into v_homework
    from public.school_teacher_homework h
    where h.owner_id = p_owner_id
      and h.school_year = v_year
      and h.class_id = v_class_id;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', g.assessment_id::text,
      'subject', g.subject,
      'title', g.assessment_name,
      'score', g.scores -> v_student_id,
      'updatedAt', g.updated_at
    ) order by g.subject, g.updated_at desc, g.assessment_name), '[]'::jsonb)
    into v_grades
    from public.school_teacher_gradebooks g
    where g.owner_id = p_owner_id
      and g.school_year = v_year
      and g.class_id = v_class_id
      and g.scores ? v_student_id;

  return pg_catalog.jsonb_build_object(
    'school', pg_catalog.jsonb_build_object(
      'name', v_workspace.payload #>> '{school,name}',
      'avatar', v_workspace.payload #> '{school,avatar}'
    ),
    'student', pg_catalog.jsonb_build_object(
      'id', v_student_id,
      'fullName', v_student ->> 'fullName'
    ),
    'class', pg_catalog.jsonb_build_object(
      'id', v_class_id,
      'name', v_class ->> 'name',
      'grade', v_class ->> 'grade',
      'status', v_class ->> 'status',
      'teacher', v_class ->> 'teacher'
    ),
    'years', v_years,
    'current', v_year,
    'schedule', v_schedule,
    'homework', v_homework,
    'grades', v_grades
  );
end;
$function$;

alter function public.list_student_schools() owner to postgres;
alter function public.get_student_portal(uuid, text) owner to postgres;
revoke all on function public.list_student_schools() from public, anon, authenticated;
revoke all on function public.get_student_portal(uuid, text) from public, anon, authenticated;
grant execute on function public.list_student_schools() to authenticated;
grant execute on function public.get_student_portal(uuid, text) to authenticated;
comment on function public.list_student_schools() is 'Returns only the schools and academic years linked to the authenticated, confirmed student email.';
comment on function public.get_student_portal(uuid, text) is 'Returns the authenticated student''s own class, timetable, homework, online tests, and scores. Never returns CCCD, another student, or the full workspace.';

-- A saved teacher attachment can be read by the authenticated student assigned
-- to that homework's class. Uploading and deleting remain teacher-only.
create or replace function public.can_access_teacher_homework_file(p_name text, p_write boolean default false)
returns boolean language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_parts text[] := pg_catalog.string_to_array(p_name, '/');
  v_author uuid;
  v_owner uuid;
  v_homework_id uuid;
  v_homework public.school_teacher_homework%rowtype;
  v_portal jsonb;
begin
  if v_user is null or pg_catalog.array_length(v_parts, 1) is distinct from 4
      or v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\.[a-z0-9]{1,12})?$' then
    return false;
  end if;
  v_author := v_parts[1]::uuid;
  v_owner := v_parts[2]::uuid;
  v_homework_id := v_parts[3]::uuid;

  if p_write then
    if v_user <> v_author then return false; end if;
    return exists (
      select 1 from public.school_teacher_access a
        join public.school_workspaces w on w.user_id = a.owner_id
        cross join lateral pg_catalog.jsonb_array_elements(coalesce(w.payload -> 'teachers', '[]'::jsonb)) person
        where a.owner_id = v_owner and a.teacher_id = v_author
          and public.school_teacher_key(person ->> 'name') = a.teacher_key
          and coalesce(person ->> 'status', 'Đang giảng dạy') = 'Đang giảng dạy'
    );
  end if;

  select h.* into v_homework
    from public.school_teacher_homework h
    where h.homework_id = v_homework_id
      and h.owner_id = v_owner
      and h.teacher_id = v_author
      and exists(select 1 from pg_catalog.jsonb_array_elements(h.attachments) item
        where item ->> 'path' = p_name);
  if not found then
    -- Teachers can inspect their own drafts while their profile is active.
    return v_user = v_author and exists (
      select 1 from public.school_teacher_access a
        join public.school_workspaces w on w.user_id = a.owner_id
        cross join lateral pg_catalog.jsonb_array_elements(coalesce(w.payload -> 'teachers', '[]'::jsonb)) person
        where a.owner_id = v_owner and a.teacher_id = v_author
          and public.school_teacher_key(person ->> 'name') = a.teacher_key
          and coalesce(person ->> 'status', 'Đang giảng dạy') = 'Đang giảng dạy'
    );
  end if;

  if v_user = v_author then
    if not exists (
      select 1 from public.school_teacher_access a
        join public.school_workspaces w on w.user_id = a.owner_id
        cross join lateral pg_catalog.jsonb_array_elements(coalesce(w.payload -> 'teachers', '[]'::jsonb)) person
        where a.owner_id = v_owner and a.teacher_id = v_author
          and public.school_teacher_key(person ->> 'name') = a.teacher_key
          and coalesce(person ->> 'status', 'Đang giảng dạy') = 'Đang giảng dạy'
    ) then return false; end if;
    begin
      v_portal := public.get_teacher_portal(v_owner, v_homework.school_year);
    exception when others then
      return false;
    end;
    return exists(select 1 from pg_catalog.jsonb_array_elements(v_portal -> 'assignments') a
      where a ->> 'classId' = v_homework.class_id
        and pg_catalog.btrim(a ->> 'subject') = v_homework.subject);
  end if;

  begin
    v_portal := public.get_student_portal(v_owner, v_homework.school_year);
  exception when others then
    return false;
  end;
  return v_portal #>> '{class,id}' = v_homework.class_id;
end;
$function$;
alter function public.can_access_teacher_homework_file(text, boolean) owner to postgres;
revoke all on function public.can_access_teacher_homework_file(text, boolean) from public, anon, authenticated;
grant execute on function public.can_access_teacher_homework_file(text, boolean) to authenticated;

drop policy if exists teacher_homework_files_select on storage.objects;
create policy teacher_homework_files_select on storage.objects for select to authenticated
  using (bucket_id = 'teacher-homework-files'
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

drop policy if exists teacher_homework_files_select_guard on storage.objects;
create policy teacher_homework_files_select_guard on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'teacher-homework-files' or (
    auth.uid() is not null and public.can_access_teacher_homework_file(name, false)));
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

notify pgrst, 'reload schema';
commit;
