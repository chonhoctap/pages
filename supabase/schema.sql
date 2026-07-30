-- Chốn Học Tập: hồ sơ thành viên, phân quyền và ảnh đại diện.
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

create extension if not exists citext with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username extensions.citext not null unique,
  display_name text not null,
  avatar_url text,
  bio text,
  grade text,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format
    check (username::text ~ '^[a-z0-9_]{3,24}$'),
  constraint profiles_display_name_length
    check (char_length(display_name) between 2 and 60),
  constraint profiles_bio_length
    check (bio is null or char_length(bio) <= 280),
  constraint profiles_grade_values
    check (grade is null or grade in ('10', '11', '12', 'graduate', 'other')),
  constraint profiles_role_values
    check (role in ('member', 'moderator', 'admin'))
);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_created_at_idx on public.profiles(created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  generated_username text;
  requested_display_name text;
begin
  requested_username := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  requested_display_name := trim(coalesce(
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(coalesce(new.email, ''), '@', 1),
    'Thành viên'
  ));

  if requested_username <> '' then
    if requested_username !~ '^[a-z0-9_]{3,24}$' then
      raise exception 'Username không hợp lệ';
    end if;
    generated_username := requested_username;
  else
    generated_username := left(
      regexp_replace(
        lower(coalesce(split_part(new.email, '@', 1), 'user')),
        '[^a-z0-9_]',
        '',
        'g'
      ),
      17
    );
    if char_length(generated_username) < 3 then
      generated_username := 'user';
    end if;
    generated_username := generated_username
      || '_'
      || left(replace(new.id::text, '-', ''), 6);
  end if;

  if char_length(requested_display_name) < 2 then
    requested_display_name := 'Thành viên';
  end if;

  insert into public.profiles (
    id,
    username,
    display_name,
    avatar_url
  )
  values (
    new.id,
    generated_username,
    left(requested_display_name, 60),
    nullif(
      coalesce(
        new.raw_user_meta_data ->> 'avatar_url',
        new.raw_user_meta_data ->> 'picture'
      ),
      ''
    )
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists "Authenticated users can view profiles" on public.profiles;
create policy "Authenticated users can view profiles"
on public.profiles
for select
to authenticated
using (true);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

-- Thu hồi quyền ghi toàn bảng, sau đó chỉ cấp các cột hồ sơ được phép sửa.
-- Cột role không nằm trong danh sách nên không thể tự đổi quyền từ trình duyệt.
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
grant select on table public.profiles to authenticated;
grant update (username, display_name, avatar_url, bio, grade)
  on table public.profiles to authenticated;

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
  );
$$;

revoke execute on function public.is_admin() from public;
revoke execute on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

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
  updated_profile public.profiles;
begin
  if (select auth.uid()) is null then
    raise exception 'Bạn chưa đăng nhập';
  end if;

  if not public.is_admin() then
    raise exception 'Chỉ quản trị viên mới được thay đổi quyền';
  end if;

  if target_role not in ('member', 'moderator', 'admin') then
    raise exception 'Quyền không hợp lệ';
  end if;

  if target_user_id = (select auth.uid()) and target_role <> 'admin' then
    raise exception 'Bạn không thể tự hạ quyền quản trị của chính mình';
  end if;

  update public.profiles
  set role = target_role
  where id = target_user_id
  returning * into updated_profile;

  if updated_profile.id is null then
    raise exception 'Không tìm thấy thành viên';
  end if;

  return updated_profile;
end;
$$;

revoke execute on function public.set_user_role(uuid, text) from public;
revoke execute on function public.set_user_role(uuid, text) from anon;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- Bucket ảnh đại diện công khai; chỉ chủ tài khoản được ghi vào thư mục của mình.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'avatars',
  'avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public avatar access" on storage.objects;
create policy "Public avatar access"
on storage.objects
for select
to public
using (bucket_id = 'avatars');

drop policy if exists "Users upload own avatar" on storage.objects;
create policy "Users upload own avatar"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users update own avatar" on storage.objects;
create policy "Users update own avatar"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users delete own avatar" on storage.objects;
create policy "Users delete own avatar"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
