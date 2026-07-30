-- Chốn Học Tập: diễn đàn V3.
-- Yêu cầu: đã chạy schema.sql, permissions_migration.sql,
-- forum_migration.sql và forum_v2_migration.sql.
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

begin;

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Role VIP
-- ---------------------------------------------------------------------------

alter table public.profiles
  drop constraint if exists profiles_role_values;
alter table public.profiles
  add constraint profiles_role_values
  check (role in ('member', 'vip', 'moderator', 'admin'));

alter table public.access_audit_log
  drop constraint if exists access_audit_old_role_values,
  drop constraint if exists access_audit_new_role_values;
alter table public.access_audit_log
  add constraint access_audit_old_role_values
    check (old_role in ('member', 'vip', 'moderator', 'admin')),
  add constraint access_audit_new_role_values
    check (new_role in ('member', 'vip', 'moderator', 'admin'));

create or replace function public.is_vip_or_staff()
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
      and role in ('vip', 'moderator', 'admin')
      and account_status = 'active'
  );
$$;

revoke execute on function public.is_vip_or_staff() from public;
revoke execute on function public.is_vip_or_staff() from anon;
grant execute on function public.is_vip_or_staff() to authenticated;

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

  perform pg_catalog.pg_advisory_xact_lock(8126, 20260730);

  if not public.is_admin() then
    raise exception 'Chỉ quản trị viên đang hoạt động mới được thay đổi quyền';
  end if;

  if target_role not in ('member', 'vip', 'moderator', 'admin') then
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

-- ---------------------------------------------------------------------------
-- 2. Trạng thái kiểm duyệt, ghim, lượt xem và thời hạn
-- ---------------------------------------------------------------------------

alter table public.forum_posts
  add column if not exists moderation_status text not null default 'published',
  add column if not exists moderation_reason text,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists is_pinned boolean not null default false,
  add column if not exists solved_at timestamptz,
  add column if not exists expires_at timestamptz;

alter table public.forum_posts
  drop constraint if exists forum_posts_moderation_status_values;
alter table public.forum_posts
  add constraint forum_posts_moderation_status_values
    check (moderation_status in ('published', 'pending_review', 'rejected'));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'forum_posts_reviewed_by_fkey'
      and conrelid = 'public.forum_posts'::regclass
  ) then
    alter table public.forum_posts
      add constraint forum_posts_reviewed_by_fkey
      foreign key (reviewed_by) references public.profiles(id) on delete set null;
  end if;
end;
$$;

create or replace function public.forum_text_needs_review(
  post_title text,
  post_body text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select extensions.unaccent(
    lower(coalesce(post_title, '') || ' ' || coalesce(post_body, ''))
  ) ~ (
    '(^|[^a-z0-9])'
    || '(dit|du|deo|lon|cac|fuck|porn|khoe than|anh nong|clip nong)'
    || '([^a-z0-9]|$)'
  );
$$;

revoke execute on function public.forum_text_needs_review(text, text)
  from public;
revoke execute on function public.forum_text_needs_review(text, text)
  from anon;
grant execute on function public.forum_text_needs_review(text, text)
  to authenticated;

create or replace function public.prepare_forum_post()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  last_post_at timestamptz;
begin
  if tg_op = 'INSERT'
    and (select auth.uid()) is not null
    and not public.is_moderator_or_admin() then
    select max(created_at)
    into last_post_at
    from public.forum_posts
    where author_id = new.author_id;

    if last_post_at is not null
      and last_post_at > now() - interval '15 minutes' then
      raise exception 'Bạn chỉ có thể đăng một bài sau mỗi 15 phút';
    end if;
  end if;

  if public.forum_text_needs_review(new.title, new.body) then
    new.moderation_status = 'pending_review';
    new.moderation_reason = 'Hệ thống phát hiện từ ngữ hoặc nội dung cần quản trị viên xem xét.';
    new.reviewed_by = null;
    new.reviewed_at = null;
  elsif tg_op = 'INSERT' then
    new.moderation_status = 'published';
    new.moderation_reason = null;
  end if;

  if new.category = 'question' and new.is_solved = true then
    if tg_op = 'INSERT' then
      new.solved_at = coalesce(new.solved_at, now());
    elsif old.is_solved = false or old.solved_at is null then
      new.solved_at = now();
    else
      new.solved_at = old.solved_at;
    end if;
  else
    new.solved_at = null;
  end if;

  if new.is_pinned then
    new.expires_at = null;
  elsif new.category = 'entertainment' then
    new.expires_at = new.created_at + interval '15 days';
  elsif new.is_solved then
    new.expires_at = new.solved_at + interval '7 days';
  else
    new.expires_at = new.created_at + interval '5 days';
  end if;

  return new;
end;
$$;

drop trigger if exists forum_posts_prepare_v3 on public.forum_posts;
create trigger forum_posts_prepare_v3
before insert or update of
  title,
  body,
  category,
  is_solved,
  is_pinned
on public.forum_posts
for each row execute procedure public.prepare_forum_post();

-- Đồng bộ dữ liệu cũ.
update public.forum_posts
set
  solved_at = case
    when category = 'question' and is_solved
      then coalesce(solved_at, updated_at, created_at)
    else null
  end,
  expires_at = case
    when is_pinned then null
    when category = 'entertainment' then created_at + interval '15 days'
    when is_solved then coalesce(solved_at, updated_at, created_at) + interval '7 days'
    else created_at + interval '5 days'
  end;

create index if not exists forum_posts_expiry_idx
  on public.forum_posts(expires_at)
  where expires_at is not null;
create index if not exists forum_posts_moderation_idx
  on public.forum_posts(moderation_status, created_at desc);

create or replace function public.can_view_forum_post(target_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_view_forum()
    and exists (
      select 1
      from public.forum_posts p
      where p.id = target_post_id
        and (
          p.moderation_status = 'published'
          or p.author_id = (select auth.uid())
          or public.is_moderator_or_admin()
        )
    );
$$;

revoke execute on function public.can_view_forum_post(uuid) from public;
revoke execute on function public.can_view_forum_post(uuid) from anon;
grant execute on function public.can_view_forum_post(uuid) to authenticated;

revoke update (
  moderation_status,
  moderation_reason,
  reviewed_by,
  reviewed_at,
  is_pinned,
  solved_at,
  expires_at
) on table public.forum_posts from authenticated;

-- Bài mới luôn bắt đầu ở trạng thái chưa giải; client không được tự điền các
-- cột kiểm duyệt, thời hạn hoặc trạng thái ghim.
revoke insert on table public.forum_posts from authenticated;
grant insert (
  author_id,
  category,
  title,
  body,
  hashtags,
  subject,
  grade,
  media_url,
  media_path,
  media_type
) on table public.forum_posts to authenticated;

create or replace function public.mark_forum_post_solved(target_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not public.is_account_active() then
    return false;
  end if;

  update public.forum_posts
  set is_solved = true
  where id = target_post_id
    and category = 'question'
    and is_solved = false
    and (
      author_id = (select auth.uid())
      or public.is_moderator_or_admin()
    );

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke execute on function public.mark_forum_post_solved(uuid) from public;
revoke execute on function public.mark_forum_post_solved(uuid) from anon;
grant execute on function public.mark_forum_post_solved(uuid) to authenticated;

create or replace function public.review_forum_post(
  target_post_id uuid,
  review_action text,
  review_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được duyệt bài';
  end if;

  if review_action not in ('approve', 'reject') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_posts
  set
    moderation_status = case
      when review_action = 'approve' then 'published'
      else 'rejected'
    end,
    moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
    reviewed_by = (select auth.uid()),
    reviewed_at = now()
  where id = target_post_id;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke execute on function public.review_forum_post(uuid, text, text)
  from public;
revoke execute on function public.review_forum_post(uuid, text, text)
  from anon;
grant execute on function public.review_forum_post(uuid, text, text)
  to authenticated;

create or replace function public.set_forum_post_pinned(
  target_post_id uuid,
  should_pin boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được ghim bài';
  end if;

  update public.forum_posts
  set is_pinned = should_pin
  where id = target_post_id
    and is_pinned is distinct from should_pin;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke execute on function public.set_forum_post_pinned(uuid, boolean)
  from public;
revoke execute on function public.set_forum_post_pinned(uuid, boolean)
  from anon;
grant execute on function public.set_forum_post_pinned(uuid, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Nhiều ảnh/video cho bài viết và bình luận
-- ---------------------------------------------------------------------------

create table if not exists public.forum_post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null,
  uploader_id uuid not null,
  media_url text not null,
  media_path text not null,
  media_type text not null,
  sort_order smallint not null default 0,
  size_bytes bigint not null,
  width integer,
  height integer,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  constraint forum_post_media_post_id_fkey
    foreign key (post_id) references public.forum_posts(id) on delete cascade,
  constraint forum_post_media_uploader_id_fkey
    foreign key (uploader_id) references public.profiles(id) on delete cascade,
  constraint forum_post_media_type_values
    check (media_type in ('image', 'video')),
  constraint forum_post_media_sort_order
    check (sort_order between 0 and 7),
  constraint forum_post_media_size_positive
    check (size_bytes > 0),
  constraint forum_post_media_dimensions_positive
    check (
      (width is null and height is null)
      or (width > 0 and height > 0)
    ),
  constraint forum_post_media_duration
    check (duration_seconds is null or duration_seconds between 1 and 180),
  unique (post_id, sort_order),
  unique (media_path)
);

create table if not exists public.forum_comment_media (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null,
  uploader_id uuid not null,
  media_url text not null,
  media_path text not null,
  media_type text not null,
  sort_order smallint not null default 0,
  size_bytes bigint not null,
  width integer,
  height integer,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  constraint forum_comment_media_comment_id_fkey
    foreign key (comment_id) references public.forum_comments(id) on delete cascade,
  constraint forum_comment_media_uploader_id_fkey
    foreign key (uploader_id) references public.profiles(id) on delete cascade,
  constraint forum_comment_media_type_values
    check (media_type in ('image', 'video')),
  constraint forum_comment_media_sort_order
    check (sort_order between 0 and 7),
  constraint forum_comment_media_size_positive
    check (size_bytes > 0),
  constraint forum_comment_media_dimensions_positive
    check (
      (width is null and height is null)
      or (width > 0 and height > 0)
    ),
  constraint forum_comment_media_duration
    check (duration_seconds is null or duration_seconds between 1 and 180),
  unique (comment_id, sort_order),
  unique (media_path)
);

create index if not exists forum_post_media_post_idx
  on public.forum_post_media(post_id, sort_order);
create index if not exists forum_comment_media_comment_idx
  on public.forum_comment_media(comment_id, sort_order);

create or replace function public.validate_forum_media_limits()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uploader_role text;
  owner_id uuid;
  image_count integer;
  video_count integer;
  max_images integer;
  max_videos integer;
  max_image_bytes bigint;
  max_video_bytes bigint;
begin
  select role
  into uploader_role
  from public.profiles
  where id = new.uploader_id
    and account_status = 'active';

  if not found then
    raise exception 'Tài khoản không được phép tải media';
  end if;

  if tg_table_name = 'forum_post_media' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.post_id::text, 3101)
    );
    select author_id into owner_id
    from public.forum_posts
    where id = new.post_id;
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.comment_id::text, 3102)
    );
    select author_id into owner_id
    from public.forum_comments
    where id = new.comment_id;
  end if;

  if owner_id is distinct from new.uploader_id
    and uploader_role not in ('moderator', 'admin') then
    raise exception 'Bạn không thể gắn media vào nội dung của người khác';
  end if;

  if uploader_role in ('vip', 'moderator', 'admin') then
    max_images := 6;
    max_videos := 2;
    max_image_bytes := 3145728;
    max_video_bytes := 52428800;
  else
    max_images := 2;
    max_videos := 1;
    max_image_bytes := 1572864;
    max_video_bytes := 26214400;
  end if;

  if new.media_type = 'image' and new.size_bytes > max_image_bytes then
    raise exception 'Ảnh vượt quá giới hạn của tài khoản';
  end if;
  if new.media_type = 'video' and new.size_bytes > max_video_bytes then
    raise exception 'Video vượt quá giới hạn của tài khoản';
  end if;
  if new.width is not null then
    if uploader_role in ('vip', 'moderator', 'admin') then
      if not (
        (new.width <= 1920 and new.height <= 1080)
        or (new.width <= 1080 and new.height <= 1920)
      ) then
        raise exception 'Media VIP phải nằm trong khung 1080p';
      end if;
    elsif not (
      (new.width <= 1280 and new.height <= 720)
      or (new.width <= 720 and new.height <= 1280)
    ) then
      raise exception 'Media thành viên phải nằm trong khung 720p';
    end if;
  end if;

  if tg_table_name = 'forum_post_media' then
    select
      count(*) filter (where media_type = 'image'),
      count(*) filter (where media_type = 'video')
    into image_count, video_count
    from public.forum_post_media
    where post_id = new.post_id
      and id <> new.id;
  else
    select
      count(*) filter (where media_type = 'image'),
      count(*) filter (where media_type = 'video')
    into image_count, video_count
    from public.forum_comment_media
    where comment_id = new.comment_id
      and id <> new.id;
  end if;

  if new.media_type = 'image' then
    image_count := image_count + 1;
  else
    video_count := video_count + 1;
  end if;

  if image_count > max_images or video_count > max_videos then
    raise exception 'Số lượng ảnh hoặc video vượt quá giới hạn của tài khoản';
  end if;

  return new;
end;
$$;

drop trigger if exists forum_post_media_validate_limits
  on public.forum_post_media;
create trigger forum_post_media_validate_limits
before insert or update on public.forum_post_media
for each row execute procedure public.validate_forum_media_limits();

drop trigger if exists forum_comment_media_validate_limits
  on public.forum_comment_media;
create trigger forum_comment_media_validate_limits
before insert or update on public.forum_comment_media
for each row execute procedure public.validate_forum_media_limits();

alter table public.forum_post_media enable row level security;
alter table public.forum_comment_media enable row level security;

drop policy if exists "Members can view visible post media"
  on public.forum_post_media;
create policy "Members can view visible post media"
on public.forum_post_media
for select
to authenticated
using (
  public.can_view_forum_post(post_id)
);

drop policy if exists "Owners can attach post media"
  on public.forum_post_media;
create policy "Owners can attach post media"
on public.forum_post_media
for insert
to authenticated
with check (
  uploader_id = (select auth.uid())
  and public.is_account_active()
);

drop policy if exists "Owners and staff can delete post media"
  on public.forum_post_media;
create policy "Owners and staff can delete post media"
on public.forum_post_media
for delete
to authenticated
using (
  (
    uploader_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
);

drop policy if exists "Members can view visible comment media"
  on public.forum_comment_media;
create policy "Members can view visible comment media"
on public.forum_comment_media
for select
to authenticated
using (
  exists (
    select 1
    from public.forum_comments c
    where c.id = comment_id
      and public.can_view_forum_post(c.post_id)
  )
);

drop policy if exists "Owners can attach comment media"
  on public.forum_comment_media;
create policy "Owners can attach comment media"
on public.forum_comment_media
for insert
to authenticated
with check (
  uploader_id = (select auth.uid())
  and public.is_account_active()
);

drop policy if exists "Owners and staff can delete comment media"
  on public.forum_comment_media;
create policy "Owners and staff can delete comment media"
on public.forum_comment_media
for delete
to authenticated
using (
  (
    uploader_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
);

revoke all on table public.forum_post_media from anon;
revoke all on table public.forum_post_media from authenticated;
grant select on table public.forum_post_media to authenticated;
grant insert (
  post_id,
  uploader_id,
  media_url,
  media_path,
  media_type,
  sort_order,
  size_bytes,
  width,
  height,
  duration_seconds
) on table public.forum_post_media to authenticated;
grant delete on table public.forum_post_media to authenticated;

revoke all on table public.forum_comment_media from anon;
revoke all on table public.forum_comment_media from authenticated;
grant select on table public.forum_comment_media to authenticated;
grant insert (
  comment_id,
  uploader_id,
  media_url,
  media_path,
  media_type,
  sort_order,
  size_bytes,
  width,
  height,
  duration_seconds
) on table public.forum_comment_media to authenticated;
grant delete on table public.forum_comment_media to authenticated;

-- Supabase Free giới hạn file tối đa 50 MB. Giới hạn theo role được kiểm tra khi
-- media được liên kết với bài/bình luận; file mồ côi sẽ được tác vụ dọn xóa.
update storage.buckets
set file_size_limit = 52428800
where id in ('forum-media', 'forum-comment-media');

-- ---------------------------------------------------------------------------
-- 4. Cảm xúc, lượt xem, báo cáo và số liệu xu hướng
-- ---------------------------------------------------------------------------

create table if not exists public.forum_reactions (
  post_id uuid not null,
  user_id uuid not null,
  reaction_type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, user_id),
  constraint forum_reactions_post_id_fkey
    foreign key (post_id) references public.forum_posts(id) on delete cascade,
  constraint forum_reactions_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade,
  constraint forum_reactions_type_values
    check (reaction_type in ('like', 'love', 'haha', 'wow', 'sad', 'angry'))
);

create table if not exists public.forum_post_views (
  post_id uuid not null,
  viewer_id uuid not null,
  viewed_on date not null default current_date,
  created_at timestamptz not null default now(),
  primary key (post_id, viewer_id, viewed_on),
  constraint forum_post_views_post_id_fkey
    foreign key (post_id) references public.forum_posts(id) on delete cascade,
  constraint forum_post_views_viewer_id_fkey
    foreign key (viewer_id) references public.profiles(id) on delete cascade
);

create table if not exists public.forum_reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null,
  reporter_id uuid not null,
  reason text not null,
  details text,
  status text not null default 'open',
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint forum_reports_post_id_fkey
    foreign key (post_id) references public.forum_posts(id) on delete cascade,
  constraint forum_reports_reporter_id_fkey
    foreign key (reporter_id) references public.profiles(id) on delete cascade,
  constraint forum_reports_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null,
  constraint forum_reports_reason_values
    check (reason in ('spam', 'harassment', 'adult', 'off_topic', 'other')),
  constraint forum_reports_status_values
    check (status in ('open', 'resolved', 'dismissed')),
  constraint forum_reports_details_length
    check (details is null or char_length(details) <= 500),
  unique (post_id, reporter_id)
);

insert into public.forum_reactions (post_id, user_id, reaction_type, created_at)
select post_id, user_id, 'like', created_at
from public.forum_likes
on conflict (post_id, user_id) do nothing;

create index if not exists forum_reactions_post_idx
  on public.forum_reactions(post_id, reaction_type);
create index if not exists forum_post_views_post_idx
  on public.forum_post_views(post_id);
create index if not exists forum_reports_status_idx
  on public.forum_reports(status, created_at);

alter table public.forum_reactions enable row level security;
alter table public.forum_post_views enable row level security;
alter table public.forum_reports enable row level security;

drop policy if exists "Members can view reactions"
  on public.forum_reactions;
create policy "Members can view reactions"
on public.forum_reactions
for select
to authenticated
using (
  public.can_view_forum()
  and public.can_view_forum_post(post_id)
);
drop policy if exists "Active members manage own reactions"
  on public.forum_reactions;
create policy "Active members manage own reactions"
on public.forum_reactions
for all
to authenticated
using (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.can_view_forum_post(post_id)
)
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Members can view own reports and staff view all"
  on public.forum_reports;
create policy "Members can view own reports and staff view all"
on public.forum_reports
for select
to authenticated
using (
  reporter_id = (select auth.uid())
  or public.is_moderator_or_admin()
);
drop policy if exists "Active members can report posts"
  on public.forum_reports;
create policy "Active members can report posts"
on public.forum_reports
for insert
to authenticated
with check (
  reporter_id = (select auth.uid())
  and public.is_account_active()
  and public.can_view_forum_post(post_id)
);

revoke all on table public.forum_reactions from anon;
revoke all on table public.forum_reactions from authenticated;
grant select, insert, update, delete on table public.forum_reactions
  to authenticated;

revoke all on table public.forum_post_views from anon;
revoke all on table public.forum_post_views from authenticated;

revoke all on table public.forum_reports from anon;
revoke all on table public.forum_reports from authenticated;
grant select on table public.forum_reports to authenticated;
grant insert (post_id, reporter_id, reason, details)
  on table public.forum_reports to authenticated;

create or replace function public.sync_legacy_forum_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.forum_reactions (
      post_id,
      user_id,
      reaction_type,
      created_at,
      updated_at
    )
    values (
      new.post_id,
      new.user_id,
      'like',
      new.created_at,
      new.created_at
    )
    on conflict (post_id, user_id) do update
    set
      reaction_type = 'like',
      updated_at = now();
    return new;
  end if;

  delete from public.forum_reactions
  where post_id = old.post_id
    and user_id = old.user_id
    and reaction_type = 'like';
  return old;
end;
$$;

drop trigger if exists forum_likes_sync_reaction on public.forum_likes;
create trigger forum_likes_sync_reaction
after insert or delete on public.forum_likes
for each row execute procedure public.sync_legacy_forum_like();

create or replace function public.flag_frequently_reported_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*)
    from public.forum_reports
    where post_id = new.post_id
      and status = 'open'
  ) >= 2 then
    update public.forum_posts
    set
      moderation_status = 'pending_review',
      moderation_reason = 'Bài viết nhận được nhiều báo cáo từ cộng đồng.',
      reviewed_by = null,
      reviewed_at = null
    where id = new.post_id
      and moderation_status = 'published';
  end if;
  return new;
end;
$$;

drop trigger if exists forum_reports_flag_post on public.forum_reports;
create trigger forum_reports_flag_post
after insert on public.forum_reports
for each row execute procedure public.flag_frequently_reported_post();

create or replace function public.review_forum_report(
  target_report_id uuid,
  review_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được xử lý báo cáo';
  end if;
  if review_status not in ('resolved', 'dismissed') then
    raise exception 'Trạng thái báo cáo không hợp lệ';
  end if;

  update public.forum_reports
  set
    status = review_status,
    reviewed_by = (select auth.uid()),
    reviewed_at = now()
  where id = target_report_id
    and status = 'open';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke execute on function public.review_forum_report(uuid, text)
  from public;
revoke execute on function public.review_forum_report(uuid, text)
  from anon;
grant execute on function public.review_forum_report(uuid, text)
  to authenticated;

create or replace function public.register_forum_post_view(target_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if not public.can_view_forum() then
    return false;
  end if;

  insert into public.forum_post_views (post_id, viewer_id)
  select target_post_id, (select auth.uid())
  from public.forum_posts
  where id = target_post_id
    and moderation_status = 'published'
  on conflict do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;

revoke execute on function public.register_forum_post_view(uuid) from public;
revoke execute on function public.register_forum_post_view(uuid) from anon;
grant execute on function public.register_forum_post_view(uuid) to authenticated;

create or replace view public.forum_post_metrics
with (security_invoker = false)
as
select
  p.id as post_id,
  (select count(*) from public.forum_post_views v where v.post_id = p.id)
    as view_count,
  (select count(*) from public.forum_reactions r where r.post_id = p.id)
    as reaction_count,
  (select count(*) from public.forum_comments c where c.post_id = p.id)
    as comment_count,
  (select count(*) from public.forum_shares s where s.post_id = p.id)
    as share_count,
  (
    (select count(*) from public.forum_post_views v where v.post_id = p.id) * 0.2
    + (select count(*) from public.forum_reactions r where r.post_id = p.id) * 2
    + (select count(*) from public.forum_comments c where c.post_id = p.id) * 3
    + (select count(*) from public.forum_shares s where s.post_id = p.id) * 4
  ) / power(greatest(1, extract(epoch from (now() - p.created_at)) / 3600 + 2), 1.25)
    as trending_score
from public.forum_posts p
where p.moderation_status = 'published'
  or p.author_id = (select auth.uid())
  or public.is_moderator_or_admin();

grant select on public.forum_post_metrics to authenticated;

-- Bài chờ duyệt chỉ tác giả và staff được xem.
drop policy if exists "Members can view forum posts" on public.forum_posts;
create policy "Members can view forum posts"
on public.forum_posts
for select
to authenticated
using (
  public.can_view_forum()
  and (
    moderation_status = 'published'
    or author_id = (select auth.uid())
    or public.is_moderator_or_admin()
  )
);

drop policy if exists "Members can view forum comments"
  on public.forum_comments;
create policy "Members can view forum comments"
on public.forum_comments
for select
to authenticated
using (
  public.can_view_forum()
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Active members can create forum comments"
  on public.forum_comments;
create policy "Active members can create forum comments"
on public.forum_comments
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and public.is_account_active()
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Members can view forum likes"
  on public.forum_likes;
create policy "Members can view forum likes"
on public.forum_likes
for select
to authenticated
using (
  public.can_view_forum()
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Active members can like forum posts"
  on public.forum_likes;
create policy "Active members can like forum posts"
on public.forum_likes
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Members can view forum shares"
  on public.forum_shares;
create policy "Members can view forum shares"
on public.forum_shares
for select
to authenticated
using (
  public.can_view_forum()
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Active members can register forum shares"
  on public.forum_shares;
create policy "Active members can register forum shares"
on public.forum_shares
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.can_view_forum_post(post_id)
);

-- Lưu ý: bộ lọc SQL chỉ phát hiện một phần nội dung văn bản đáng ngờ.
-- Ảnh/video nhạy cảm và hành vi nói xấu vẫn cần hàng đợi báo cáo/kiểm duyệt.

commit;
