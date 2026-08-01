-- Chốn Học Tập: hoàn thiện diễn đàn V4.
-- Yêu cầu: đã chạy forum_v3_migration.sql.
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

begin;

-- ---------------------------------------------------------------------------
-- 1. Thời hạn bài viết và chống đăng liên tục
-- ---------------------------------------------------------------------------

create or replace function public.prepare_forum_post()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  last_post_at timestamptz;
  has_comments boolean := false;
begin
  if tg_op = 'INSERT' and (select auth.uid()) is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.author_id::text, 4101)
    );

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
    new.moderation_reason =
      'Hệ thống phát hiện từ ngữ hoặc nội dung cần quản trị viên xem xét.';
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

  if tg_op = 'UPDATE' and new.category = 'question' and not new.is_solved then
    select exists (
      select 1
      from public.forum_comments c
      where c.post_id = new.id
    ) into has_comments;
  end if;

  if new.is_pinned then
    new.expires_at = null;
  elsif new.category = 'entertainment' then
    new.expires_at = new.created_at + interval '14 days';
  elsif new.is_solved then
    new.expires_at = new.solved_at + interval '3 days';
  elsif has_comments then
    new.expires_at = new.created_at + interval '5 days';
  else
    new.expires_at = new.created_at + interval '7 days';
  end if;

  return new;
end;
$$;

drop trigger if exists forum_posts_prepare_v3 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v4 on public.forum_posts;
create trigger forum_posts_prepare_v4
before insert or update of
  title,
  body,
  category,
  is_solved,
  is_pinned
on public.forum_posts
for each row execute procedure public.prepare_forum_post();

create or replace function public.refresh_forum_question_expiry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_post_id uuid;
begin
  target_post_id := case when tg_op = 'DELETE' then old.post_id else new.post_id end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_post_id::text, 4102)
  );

  update public.forum_posts p
  set expires_at = p.created_at + case
    when exists (
      select 1
      from public.forum_comments c
      where c.post_id = p.id
    ) then interval '5 days'
    else interval '7 days'
  end
  where p.id = target_post_id
    and p.category = 'question'
    and not p.is_solved
    and not p.is_pinned;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.refresh_forum_question_expiry() from public;
revoke execute on function public.refresh_forum_question_expiry() from anon;
revoke execute on function public.refresh_forum_question_expiry() from authenticated;

drop trigger if exists forum_comments_refresh_question_expiry
  on public.forum_comments;
create trigger forum_comments_refresh_question_expiry
after insert or delete on public.forum_comments
for each row execute procedure public.refresh_forum_question_expiry();

-- Đồng bộ thời hạn cho dữ liệu đã có.
update public.forum_posts p
set
  solved_at = case
    when p.category = 'question' and p.is_solved
      then coalesce(p.solved_at, p.updated_at, p.created_at)
    else null
  end,
  expires_at = case
    when p.is_pinned then null
    when p.category = 'entertainment'
      then p.created_at + interval '14 days'
    when p.is_solved
      then coalesce(p.solved_at, p.updated_at, p.created_at) + interval '3 days'
    when exists (
      select 1 from public.forum_comments c where c.post_id = p.id
    ) then p.created_at + interval '5 days'
    else p.created_at + interval '7 days'
  end;

-- ---------------------------------------------------------------------------
-- 2. Âm thanh cho bài viết và bình luận
-- ---------------------------------------------------------------------------

alter table public.forum_posts
  drop constraint if exists forum_posts_media_type_values;
alter table public.forum_posts
  add constraint forum_posts_media_type_values
  check (media_type is null or media_type in ('image', 'video', 'audio'));

alter table public.forum_comments
  drop constraint if exists forum_comments_media_type_values;
alter table public.forum_comments
  add constraint forum_comments_media_type_values
  check (media_type is null or media_type in ('image', 'video', 'audio'));

alter table public.forum_post_media
  drop constraint if exists forum_post_media_type_values,
  drop constraint if exists forum_post_media_sort_order,
  drop constraint if exists forum_post_media_duration;
alter table public.forum_post_media
  add constraint forum_post_media_type_values
    check (media_type in ('image', 'video', 'audio')),
  add constraint forum_post_media_sort_order
    check (sort_order between 0 and 9),
  add constraint forum_post_media_duration
    check (
      duration_seconds is null
      or (media_type = 'video' and duration_seconds between 1 and 180)
      or (media_type = 'audio' and duration_seconds between 1 and 600)
    );

alter table public.forum_comment_media
  drop constraint if exists forum_comment_media_type_values,
  drop constraint if exists forum_comment_media_sort_order,
  drop constraint if exists forum_comment_media_duration;
alter table public.forum_comment_media
  add constraint forum_comment_media_type_values
    check (media_type in ('image', 'video', 'audio')),
  add constraint forum_comment_media_sort_order
    check (sort_order between 0 and 9),
  add constraint forum_comment_media_duration
    check (
      duration_seconds is null
      or (media_type = 'video' and duration_seconds between 1 and 180)
      or (media_type = 'audio' and duration_seconds between 1 and 600)
    );

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
  audio_count integer;
  max_images integer;
  max_videos integer;
  max_audios integer;
  max_image_bytes bigint;
  max_video_bytes bigint;
  max_audio_bytes bigint;
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
    max_audios := 2;
    max_image_bytes := 3145728;
    max_video_bytes := 52428800;
    max_audio_bytes := 20971520;
  else
    max_images := 2;
    max_videos := 1;
    max_audios := 1;
    max_image_bytes := 1572864;
    max_video_bytes := 26214400;
    max_audio_bytes := 10485760;
  end if;

  if new.media_type = 'image' and new.size_bytes > max_image_bytes then
    raise exception 'Ảnh vượt quá giới hạn của tài khoản';
  elsif new.media_type = 'video' and new.size_bytes > max_video_bytes then
    raise exception 'Video vượt quá giới hạn của tài khoản';
  elsif new.media_type = 'audio' and new.size_bytes > max_audio_bytes then
    raise exception 'Âm thanh vượt quá giới hạn của tài khoản';
  end if;

  if new.media_type in ('image', 'video') and new.width is not null then
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
      count(*) filter (where media_type = 'video'),
      count(*) filter (where media_type = 'audio')
    into image_count, video_count, audio_count
    from public.forum_post_media
    where post_id = new.post_id
      and id <> new.id;
  else
    select
      count(*) filter (where media_type = 'image'),
      count(*) filter (where media_type = 'video'),
      count(*) filter (where media_type = 'audio')
    into image_count, video_count, audio_count
    from public.forum_comment_media
    where comment_id = new.comment_id
      and id <> new.id;
  end if;

  if new.media_type = 'image' then
    image_count := image_count + 1;
  elsif new.media_type = 'video' then
    video_count := video_count + 1;
  else
    audio_count := audio_count + 1;
  end if;

  if image_count > max_images
    or video_count > max_videos
    or audio_count > max_audios then
    raise exception 'Số lượng ảnh, video hoặc âm thanh vượt quá giới hạn của tài khoản';
  end if;

  return new;
end;
$$;

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav'
]
where id in ('forum-media', 'forum-comment-media');

-- ---------------------------------------------------------------------------
-- 3. Ẩn bài ngay khi hết hạn, trước khi tác vụ dọn dữ liệu chạy
-- ---------------------------------------------------------------------------

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
        and (p.expires_at is null or p.expires_at > now())
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

drop policy if exists "Members can view forum posts" on public.forum_posts;
create policy "Members can view forum posts"
on public.forum_posts
for select
to authenticated
using (
  public.can_view_forum()
  and (expires_at is null or expires_at > now())
  and (
    moderation_status = 'published'
    or author_id = (select auth.uid())
    or public.is_moderator_or_admin()
  )
);

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
    and (expires_at is null or expires_at > now())
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
  ) / power(
    greatest(1, extract(epoch from (now() - p.created_at)) / 3600 + 2),
    1.25
  ) as trending_score
from public.forum_posts p
where (p.expires_at is null or p.expires_at > now())
  and (
    p.moderation_status = 'published'
    or p.author_id = (select auth.uid())
    or public.is_moderator_or_admin()
  );

grant select on public.forum_post_metrics to authenticated;

commit;
