-- Chốn Học Tập: nâng cấp phân quyền và trạng thái tài khoản.
-- Dành cho project đã chạy schema.sql trước ngày 30/07/2026.
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

begin;

alter table public.profiles
  add column if not exists account_status text not null default 'active';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_account_status_values'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_account_status_values
      check (account_status in ('active', 'suspended', 'banned'));
  end if;
end;
$$;

create index if not exists profiles_account_status_idx
  on public.profiles(account_status);

-- Các hàm kiểm tra quyền chạy ở server để RLS không tin dữ liệu từ frontend.
create or replace function public.is_account_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and account_status = 'active'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
      and account_status = 'active'
  );
$$;

create or replace function public.is_moderator_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role in ('moderator', 'admin')
      and account_status = 'active'
  );
$$;

revoke execute on function public.is_account_active() from public;
revoke execute on function public.is_account_active() from anon;
grant execute on function public.is_account_active() to authenticated;

revoke execute on function public.is_admin() from public;
revoke execute on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

revoke execute on function public.is_moderator_or_admin() from public;
revoke execute on function public.is_moderator_or_admin() from anon;
grant execute on function public.is_moderator_or_admin() to authenticated;

-- Tài khoản bị khóa vẫn có thể đăng nhập để nhận thông báo, nhưng không được
-- chỉnh hồ sơ hoặc tải/xóa ảnh. Các tính năng diễn đàn sẽ dùng cùng hàm này.
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (
  (select auth.uid()) = id
  and public.is_account_active()
)
with check (
  (select auth.uid()) = id
  and public.is_account_active()
);

revoke update (role, account_status) on table public.profiles from authenticated;

drop policy if exists "Users upload own avatar" on storage.objects;
create policy "Users upload own avatar"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
);

drop policy if exists "Users update own avatar" on storage.objects;
create policy "Users update own avatar"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
);

drop policy if exists "Users delete own avatar" on storage.objects;
create policy "Users delete own avatar"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
);

-- Nhật ký chỉ đọc được bởi quản trị viên đang hoạt động.
create table if not exists public.access_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  target_user_id uuid references public.profiles(id) on delete set null,
  old_role text not null,
  new_role text not null,
  old_status text not null,
  new_status text not null,
  created_at timestamptz not null default now(),
  constraint access_audit_old_role_values
    check (old_role in ('member', 'moderator', 'admin')),
  constraint access_audit_new_role_values
    check (new_role in ('member', 'moderator', 'admin')),
  constraint access_audit_old_status_values
    check (old_status in ('active', 'suspended', 'banned')),
  constraint access_audit_new_status_values
    check (new_status in ('active', 'suspended', 'banned'))
);

create index if not exists access_audit_target_idx
  on public.access_audit_log(target_user_id, created_at desc);
create index if not exists access_audit_actor_idx
  on public.access_audit_log(actor_id, created_at desc);

alter table public.access_audit_log enable row level security;

drop policy if exists "Admins can view access audit log"
  on public.access_audit_log;
create policy "Admins can view access audit log"
on public.access_audit_log
for select
to authenticated
using (public.is_admin());

revoke all on table public.access_audit_log from anon;
revoke all on table public.access_audit_log from authenticated;
grant select on table public.access_audit_log to authenticated;

-- Một RPC duy nhất cập nhật cả role lẫn trạng thái và luôn ghi nhật ký.
create or replace function public.admin_update_user_access(
  target_user_id uuid,
  target_role text,
  target_status text
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_profile public.profiles;
  updated_profile public.profiles;
  active_admin_count integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Bạn chưa đăng nhập';
  end if;

  -- Tuần tự hóa các lần đổi quyền trước khi kiểm tra admin để hai admin
  -- không thể đồng thời loại bỏ lẫn nhau.
  perform pg_catalog.pg_advisory_xact_lock(8126, 20260730);

  if not public.is_admin() then
    raise exception 'Chỉ quản trị viên đang hoạt động mới được thay đổi quyền';
  end if;

  if target_role not in ('member', 'moderator', 'admin') then
    raise exception 'Quyền không hợp lệ';
  end if;

  if target_status not in ('active', 'suspended', 'banned') then
    raise exception 'Trạng thái tài khoản không hợp lệ';
  end if;

  select *
  into current_profile
  from public.profiles
  where id = target_user_id
  for update;

  if not found then
    raise exception 'Không tìm thấy thành viên';
  end if;

  if target_user_id = (select auth.uid())
    and (target_role <> 'admin' or target_status <> 'active') then
    raise exception 'Bạn không thể tự hạ quyền hoặc khóa tài khoản quản trị của chính mình';
  end if;

  if current_profile.role = 'admin'
    and current_profile.account_status = 'active'
    and (target_role <> 'admin' or target_status <> 'active') then
    select count(*)
    into active_admin_count
    from public.profiles
    where role = 'admin'
      and account_status = 'active';

    if active_admin_count <= 1 then
      raise exception 'Hệ thống phải còn ít nhất một quản trị viên đang hoạt động';
    end if;
  end if;

  if current_profile.role = target_role
    and current_profile.account_status = target_status then
    return current_profile;
  end if;

  update public.profiles
  set
    role = target_role,
    account_status = target_status
  where id = target_user_id
  returning * into updated_profile;

  insert into public.access_audit_log (
    actor_id,
    target_user_id,
    old_role,
    new_role,
    old_status,
    new_status
  )
  values (
    (select auth.uid()),
    target_user_id,
    current_profile.role,
    updated_profile.role,
    current_profile.account_status,
    updated_profile.account_status
  );

  return updated_profile;
end;
$$;

revoke execute on function public.admin_update_user_access(uuid, text, text)
  from public;
revoke execute on function public.admin_update_user_access(uuid, text, text)
  from anon;
grant execute on function public.admin_update_user_access(uuid, text, text)
  to authenticated;

-- Giữ hàm cũ để các phiên bản frontend trước không bị lỗi trong lúc cập nhật.
create or replace function public.set_user_role(
  target_user_id uuid,
  target_role text
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_status text;
  updated_profile public.profiles;
begin
  if (select auth.uid()) is null or not public.is_admin() then
    raise exception 'Chỉ quản trị viên đang hoạt động mới được thay đổi quyền';
  end if;

  select account_status
  into current_status
  from public.profiles
  where id = target_user_id;

  if not found then
    raise exception 'Không tìm thấy thành viên';
  end if;

  select *
  into updated_profile
  from public.admin_update_user_access(
    target_user_id,
    target_role,
    current_status
  );

  return updated_profile;
end;
$$;

revoke execute on function public.set_user_role(uuid, text) from public;
revoke execute on function public.set_user_role(uuid, text) from anon;
grant execute on function public.set_user_role(uuid, text) to authenticated;

commit;
