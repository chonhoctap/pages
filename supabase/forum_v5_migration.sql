-- Chốn Học Tập: diễn đàn V5 (đặc quyền, kiểm duyệt, thông báo và hồ sơ).
-- Yêu cầu: đã chạy forum_v4_migration.sql.
-- Chạy toàn bộ file này trong Supabase Dashboard > SQL Editor.

begin;

-- 1. Hồ sơ công khai bổ sung (không liên quan thông tin đăng nhập).
alter table public.profiles
  add column if not exists address text,
  add column if not exists phone text,
  add column if not exists facebook_url text,
  add column if not exists tiktok_url text,
  add column if not exists instagram_url text;

alter table public.profiles
  drop constraint if exists profiles_address_length,
  drop constraint if exists profiles_phone_length,
  drop constraint if exists profiles_social_url_length;
alter table public.profiles
  add constraint profiles_address_length
    check (address is null or char_length(address) <= 180),
  add constraint profiles_phone_length
    check (phone is null or char_length(phone) <= 24),
  add constraint profiles_social_url_length
    check (
      (facebook_url is null or char_length(facebook_url) <= 300)
      and (tiktok_url is null or char_length(tiktok_url) <= 300)
      and (instagram_url is null or char_length(instagram_url) <= 300)
    );

grant update (
  username, display_name, avatar_url, bio, grade,
  address, phone, facebook_url, tiktok_url, instagram_url
) on table public.profiles to authenticated;

-- 2. Trạng thái hiển thị/chỉnh sửa và kiểm duyệt AI.
alter table public.forum_posts
  add column if not exists visibility text not null default 'visible',
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid,
  add column if not exists edited_at timestamptz,
  add column if not exists ai_moderation_status text not null default 'approved',
  add column if not exists ai_moderation_reason text,
  add column if not exists ai_moderation_result jsonb,
  add column if not exists ai_moderated_at timestamptz;

alter table public.forum_posts
  drop constraint if exists forum_posts_visibility_values,
  drop constraint if exists forum_posts_ai_moderation_values;
alter table public.forum_posts
  add constraint forum_posts_visibility_values
    check (visibility in ('visible', 'hidden')),
  add constraint forum_posts_ai_moderation_values
    check (ai_moderation_status in ('pending', 'approved', 'rejected', 'manual_review'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'forum_posts_hidden_by_fkey'
      and conrelid = 'public.forum_posts'::regclass
  ) then
    alter table public.forum_posts
      add constraint forum_posts_hidden_by_fkey
      foreign key (hidden_by) references public.profiles(id) on delete set null;
  end if;
end;
$$;

alter table public.forum_comments
  add column if not exists parent_comment_id uuid,
  add column if not exists moderation_status text not null default 'published',
  add column if not exists moderation_reason text,
  add column if not exists edited_at timestamptz;

alter table public.forum_comments
  drop constraint if exists forum_comments_moderation_values;
alter table public.forum_comments
  add constraint forum_comments_moderation_values
    check (moderation_status in ('published', 'pending_review', 'rejected'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'forum_comments_parent_comment_id_fkey'
      and conrelid = 'public.forum_comments'::regclass
  ) then
    alter table public.forum_comments
      add constraint forum_comments_parent_comment_id_fkey
      foreign key (parent_comment_id) references public.forum_comments(id) on delete set null;
  end if;
end;
$$;

create index if not exists forum_posts_visibility_idx
  on public.forum_posts(visibility, moderation_status, created_at desc);
create index if not exists forum_comments_parent_idx
  on public.forum_comments(parent_comment_id, created_at);

-- Mọi nội dung mới đều chờ kiểm duyệt. Từ cấm rõ ràng bị từ chối ngay ở DB.
create or replace function public.prepare_forum_post()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  last_post_at timestamptz;
  has_comments boolean := false;
begin
  if public.forum_text_needs_review(new.title, new.body) then
    raise exception 'Bài viết chứa từ ngữ không phù hợp và không thể đăng';
  end if;

  if tg_op = 'INSERT' and (select auth.uid()) is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.author_id::text, 4101)
    );
    select max(created_at) into last_post_at
    from public.forum_posts where author_id = new.author_id;
    if last_post_at is not null
      and last_post_at > now() - interval '15 minutes' then
      raise exception 'Bạn chỉ có thể đăng một bài sau mỗi 15 phút';
    end if;

    new.moderation_status = 'pending_review';
    new.moderation_reason = 'AI đang kiểm tra văn bản và hình ảnh trước khi công khai.';
    new.ai_moderation_status = 'pending';
    new.ai_moderation_reason = null;
    new.reviewed_by = null;
    new.reviewed_at = null;
  elsif tg_op = 'UPDATE'
    and (new.title, coalesce(new.body, ''))
      is distinct from (old.title, coalesce(old.body, '')) then
    new.moderation_status = 'pending_review';
    new.moderation_reason = 'AI đang kiểm tra lại bài vừa chỉnh sửa.';
    new.ai_moderation_status = 'pending';
    new.ai_moderation_reason = null;
    new.ai_moderation_result = null;
    new.ai_moderated_at = null;
    new.edited_at = now();
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
      select 1 from public.forum_comments c
      where c.post_id = new.id and c.moderation_status = 'published'
    ) into has_comments;
  end if;

  if new.is_pinned then new.expires_at = null;
  elsif new.category = 'entertainment' then new.expires_at = new.created_at + interval '14 days';
  elsif new.is_solved then new.expires_at = new.solved_at + interval '3 days';
  elsif has_comments then new.expires_at = new.created_at + interval '5 days';
  else new.expires_at = new.created_at + interval '7 days';
  end if;
  return new;
end;
$$;

drop trigger if exists forum_posts_prepare_v4 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v5 on public.forum_posts;
create trigger forum_posts_prepare_v5
before insert or update of title, body, category, is_solved, is_pinned
on public.forum_posts
for each row execute procedure public.prepare_forum_post();

create or replace function public.prepare_forum_comment_v5()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.forum_text_needs_review('', new.body) then
    raise exception 'Bình luận chứa từ ngữ không phù hợp và không thể đăng';
  end if;
  if tg_op = 'INSERT' then
    new.moderation_status = 'pending_review';
    new.moderation_reason = 'AI đang kiểm tra bình luận trước khi công khai.';
  elsif new.body is distinct from old.body then
    new.moderation_status = 'pending_review';
    new.moderation_reason = 'AI đang kiểm tra lại bình luận vừa sửa.';
    new.edited_at = now();
  end if;
  if new.parent_comment_id is not null and not exists (
    select 1 from public.forum_comments c
    where c.id = new.parent_comment_id and c.post_id = new.post_id
  ) then
    raise exception 'Bình luận được trả lời không thuộc bài viết này';
  end if;
  return new;
end;
$$;

drop trigger if exists forum_comments_prepare_v5 on public.forum_comments;
create trigger forum_comments_prepare_v5
before insert or update of body, parent_comment_id
on public.forum_comments
for each row execute procedure public.prepare_forum_comment_v5();

create or replace function public.refresh_forum_question_expiry()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_post_id uuid;
begin
  target_post_id := case when tg_op = 'DELETE' then old.post_id else new.post_id end;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_post_id::text, 4102)
  );
  update public.forum_posts p
  set expires_at = p.created_at + case when exists (
    select 1 from public.forum_comments c
    where c.post_id = p.id and c.moderation_status = 'published'
  ) then interval '5 days' else interval '7 days' end
  where p.id = target_post_id and p.category = 'question'
    and not p.is_solved and not p.is_pinned;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists forum_comments_refresh_question_expiry on public.forum_comments;
create trigger forum_comments_refresh_question_expiry
after insert or delete or update of moderation_status on public.forum_comments
for each row execute procedure public.refresh_forum_question_expiry();

-- 3. Hạn mức media theo vai trò, áp dụng giống nhau cho bài và bình luận.
alter table public.forum_post_media
  drop constraint if exists forum_post_media_sort_order,
  drop constraint if exists forum_post_media_duration;
alter table public.forum_post_media
  add constraint forum_post_media_sort_order check (sort_order between 0 and 9999),
  add constraint forum_post_media_duration check (duration_seconds is null or duration_seconds >= 1);

alter table public.forum_comment_media
  drop constraint if exists forum_comment_media_sort_order,
  drop constraint if exists forum_comment_media_duration;
alter table public.forum_comment_media
  add constraint forum_comment_media_sort_order check (sort_order between 0 and 9999),
  add constraint forum_comment_media_duration check (duration_seconds is null or duration_seconds >= 1);

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
  image_total bigint;
begin
  select role into uploader_role from public.profiles
  where id = new.uploader_id and account_status = 'active';
  if not found then raise exception 'Tài khoản không được phép tải media'; end if;

  if tg_table_name = 'forum_post_media' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.post_id::text, 5101));
    select author_id into owner_id from public.forum_posts where id = new.post_id;
    select
      count(*) filter (where media_type = 'image'),
      count(*) filter (where media_type = 'video'),
      count(*) filter (where media_type = 'audio'),
      coalesce(sum(size_bytes) filter (where media_type = 'image'), 0)
    into image_count, video_count, audio_count, image_total
    from public.forum_post_media where post_id = new.post_id and id <> new.id;
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.comment_id::text, 5102));
    select author_id into owner_id from public.forum_comments where id = new.comment_id;
    select
      count(*) filter (where media_type = 'image'),
      count(*) filter (where media_type = 'video'),
      count(*) filter (where media_type = 'audio'),
      coalesce(sum(size_bytes) filter (where media_type = 'image'), 0)
    into image_count, video_count, audio_count, image_total
    from public.forum_comment_media where comment_id = new.comment_id and id <> new.id;
  end if;

  if owner_id is distinct from new.uploader_id
    and uploader_role not in ('moderator', 'admin') then
    raise exception 'Bạn không thể gắn media vào nội dung của người khác';
  end if;

  if new.media_type = 'image' then
    image_count := image_count + 1;
    image_total := image_total + new.size_bytes;
  elsif new.media_type = 'video' then video_count := video_count + 1;
  else audio_count := audio_count + 1;
  end if;

  if new.media_type in ('image', 'video')
    and (new.width is null or new.height is null) then
    raise exception 'Thiếu kích thước ảnh/video';
  end if;
  if new.media_type in ('video', 'audio') and new.duration_seconds is null then
    raise exception 'Thiếu thời lượng video/âm thanh';
  end if;

  if uploader_role = 'admin' then return new; end if;

  if uploader_role = 'member' then
    if image_count > 2 or video_count > 0 or audio_count > 1 then
      raise exception 'Thành viên: tối đa 2 ảnh, không video và 1 âm thanh';
    end if;
    if image_total > 5242880 then raise exception 'Tổng ảnh tối đa 5 MB'; end if;
    if new.media_type = 'audio' and (new.size_bytes > 2097152 or new.duration_seconds > 60) then
      raise exception 'Âm thanh thành viên tối đa 2 MB và 1 phút';
    end if;
  else
    if image_count > 5 or video_count > 1 or audio_count > 1 then
      raise exception 'VIP/điều hành viên: tối đa 5 ảnh, 1 video và 1 âm thanh';
    end if;
    if new.media_type = 'audio' and (new.size_bytes > 5242880 or new.duration_seconds > 120) then
      raise exception 'Âm thanh VIP tối đa 5 MB và 2 phút';
    end if;
    if new.media_type = 'video' and new.duration_seconds > 60 then
      raise exception 'Video VIP tối đa 1 phút';
    end if;
  end if;

  if new.media_type in ('image', 'video')
    and new.width is not null and new.height is not null
    and not (
      (new.width <= 1280 and new.height <= 720)
      or (new.width <= 720 and new.height <= 1280)
    ) then
    raise exception 'Ảnh/video phải nằm trong khung 720p';
  end if;
  return new;
end;
$$;

-- 4. Thông báo và tag thành viên.
create table if not exists public.forum_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null,
  post_id uuid references public.forum_posts(id) on delete cascade,
  comment_id uuid references public.forum_comments(id) on delete cascade,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint forum_notifications_type_values
    check (type in ('mention', 'reply', 'report', 'review', 'moderation')),
  constraint forum_notifications_message_length check (char_length(message) <= 240)
);

create table if not exists public.forum_post_mentions (
  post_id uuid not null references public.forum_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists forum_notifications_recipient_idx
  on public.forum_notifications(recipient_id, read_at, created_at desc);
alter table public.forum_notifications enable row level security;
alter table public.forum_post_mentions enable row level security;

create policy "Members read own forum notifications"
on public.forum_notifications for select to authenticated
using (recipient_id = (select auth.uid()));
create policy "Members update own forum notifications"
on public.forum_notifications for update to authenticated
using (recipient_id = (select auth.uid()))
with check (recipient_id = (select auth.uid()));
create policy "Members view mentions on visible posts"
on public.forum_post_mentions for select to authenticated
using (public.can_view_forum_post(post_id));

revoke all on table public.forum_notifications from anon, authenticated;
grant select on table public.forum_notifications to authenticated;
grant update (read_at) on table public.forum_notifications to authenticated;
revoke all on table public.forum_post_mentions from anon, authenticated;
grant select on table public.forum_post_mentions to authenticated;

create or replace function public.sync_forum_post_mentions(
  target_post_id uuid,
  usernames text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if not exists (
    select 1 from public.forum_posts p
    where p.id = target_post_id
      and (p.author_id = (select auth.uid()) or public.is_moderator_or_admin())
  ) then raise exception 'Bạn không có quyền cập nhật tag của bài này'; end if;

  delete from public.forum_post_mentions where post_id = target_post_id;
  with inserted as (
    insert into public.forum_post_mentions(post_id, user_id)
    select target_post_id, p.id
    from public.profiles p
    where lower(p.username::text) = any(
      select lower(trim(value)) from unnest(coalesce(usernames, array[]::text[])) value
    ) and p.id <> (select auth.uid())
    on conflict do nothing returning user_id
  )
  insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
  select i.user_id, (select auth.uid()), 'mention', target_post_id,
    'Bạn được nhắc đến trong một bài viết.'
  from inserted i
  join public.forum_posts fp on fp.id = target_post_id
    and fp.moderation_status = 'published' and fp.visibility = 'visible';
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;
revoke execute on function public.sync_forum_post_mentions(uuid, text[]) from public, anon;
grant execute on function public.sync_forum_post_mentions(uuid, text[]) to authenticated;

create or replace function public.notify_forum_reply()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent_author uuid;
begin
  if new.parent_comment_id is not null then
    select author_id into parent_author from public.forum_comments where id = new.parent_comment_id;
    if parent_author is distinct from new.author_id then
      insert into public.forum_notifications(recipient_id, actor_id, type, post_id, comment_id, message)
      values (parent_author, new.author_id, 'reply', new.post_id, new.id,
        'Có người trả lời bình luận của bạn.');
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists forum_comments_notify_reply on public.forum_comments;
create trigger forum_comments_notify_reply
after update of moderation_status on public.forum_comments
for each row
when (new.moderation_status = 'published' and old.moderation_status is distinct from 'published')
execute procedure public.notify_forum_reply();

-- 5. Ẩn/hiện, báo cáo và duyệt bài.
create or replace function public.set_forum_post_visibility(target_post_id uuid, should_hide boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update public.forum_posts
  set visibility = case when should_hide then 'hidden' else 'visible' end,
      hidden_at = case when should_hide then now() else null end,
      hidden_by = case when should_hide then (select auth.uid()) else null end
  where id = target_post_id
    and (author_id = (select auth.uid()) or public.is_moderator_or_admin());
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
revoke execute on function public.set_forum_post_visibility(uuid, boolean) from public, anon;
grant execute on function public.set_forum_post_visibility(uuid, boolean) to authenticated;

create or replace function public.flag_frequently_reported_post()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.forum_posts set
    moderation_status = 'pending_review',
    moderation_reason = 'Bài viết đã bị báo cáo và đang chờ quản trị viên xem xét.',
    visibility = 'hidden', hidden_at = now(), hidden_by = new.reporter_id,
    reviewed_by = null, reviewed_at = null
  where id = new.post_id;

  insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
  select p.id, new.reporter_id, 'report', new.post_id,
    'Có bài viết mới bị báo cáo cần kiểm tra.'
  from public.profiles p
  where p.role in ('moderator', 'admin') and p.account_status = 'active';
  return new;
end;
$$;

create or replace function public.review_forum_post(
  target_post_id uuid, review_action text, review_note text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer; post_author uuid;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được duyệt bài';
  end if;
  if review_action not in ('approve', 'reject', 'hide') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;
  update public.forum_posts set
    moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
    visibility = case when review_action = 'approve' then 'visible' else 'hidden' end,
    moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
    hidden_at = case when review_action = 'approve' then null else now() end,
    hidden_by = case when review_action = 'approve' then null else (select auth.uid()) end,
    reviewed_by = (select auth.uid()), reviewed_at = now()
  where id = target_post_id returning author_id into post_author;
  get diagnostics changed = row_count;
  if changed = 1 and post_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
    values (post_author, (select auth.uid()), 'review', target_post_id,
      case when review_action = 'approve' then 'Bài viết của bạn đã được duyệt.'
      else 'Bài viết của bạn đã bị ẩn hoặc từ chối.' end);
  end if;
  if changed = 1 and review_action = 'approve' then
    insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
    select m.user_id, post_author, 'mention', target_post_id,
      'Bạn được nhắc đến trong một bài viết.'
    from public.forum_post_mentions m
    where m.post_id = target_post_id
      and not exists (
        select 1 from public.forum_notifications n
        where n.recipient_id = m.user_id and n.post_id = target_post_id
          and n.type = 'mention'
      );
  end if;
  return changed = 1;
end;
$$;

create or replace function public.review_forum_comment(
  target_comment_id uuid, review_action text, review_note text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer; comment_author uuid; target_post uuid;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được duyệt bình luận';
  end if;
  if review_action not in ('approve', 'reject') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;
  update public.forum_comments set
    moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
    moderation_reason = nullif(trim(coalesce(review_note, '')), '')
  where id = target_comment_id
  returning author_id, post_id into comment_author, target_post;
  get diagnostics changed = row_count;
  if changed = 1 and comment_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(recipient_id, actor_id, type, post_id, comment_id, message)
    values (comment_author, (select auth.uid()), 'review', target_post, target_comment_id,
      case when review_action = 'approve' then 'Bình luận của bạn đã được duyệt.'
      else 'Bình luận của bạn không được duyệt.' end);
  end if;
  return changed = 1;
end;
$$;
revoke execute on function public.review_forum_comment(uuid, text, text) from public, anon;
grant execute on function public.review_forum_comment(uuid, text, text) to authenticated;

-- Bài ẩn/chờ duyệt: chỉ tác giả và staff thấy. Bình luận chờ duyệt cũng vậy.
create or replace function public.can_view_forum_post(target_post_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.forum_posts p where p.id = target_post_id
      and public.can_view_forum()
      and (
        (p.moderation_status = 'published' and p.visibility = 'visible')
        or p.author_id = (select auth.uid())
        or public.is_moderator_or_admin()
      )
  );
$$;

drop policy if exists "Members can view forum posts" on public.forum_posts;
create policy "Members can view forum posts" on public.forum_posts
for select to authenticated using (
  public.can_view_forum() and (
    (moderation_status = 'published' and visibility = 'visible')
    or author_id = (select auth.uid()) or public.is_moderator_or_admin()
  )
);

drop policy if exists "Members can view forum comments" on public.forum_comments;
create policy "Members can view forum comments" on public.forum_comments
for select to authenticated using (
  public.can_view_forum_post(post_id) and (
    moderation_status = 'published'
    or author_id = (select auth.uid()) or public.is_moderator_or_admin()
  )
);

grant update (title, body, hashtags, subject, grade) on table public.forum_posts to authenticated;
grant insert (post_id, author_id, body, media_url, media_path, media_type, parent_comment_id)
  on table public.forum_comments to authenticated;
grant update (body) on table public.forum_comments to authenticated;

create or replace view public.forum_post_metrics
with (security_invoker = false) as
select
  p.id as post_id,
  (select count(*) from public.forum_post_views v where v.post_id = p.id) as view_count,
  (select count(*) from public.forum_reactions r where r.post_id = p.id) as reaction_count,
  (select count(*) from public.forum_comments c
    where c.post_id = p.id and c.moderation_status = 'published') as comment_count,
  (select count(*) from public.forum_shares s where s.post_id = p.id) as share_count,
  (
    (select count(*) from public.forum_post_views v where v.post_id = p.id) * 0.2
    + (select count(*) from public.forum_reactions r where r.post_id = p.id) * 2
    + (select count(*) from public.forum_comments c
        where c.post_id = p.id and c.moderation_status = 'published') * 3
    + (select count(*) from public.forum_shares s where s.post_id = p.id) * 4
  ) / power(greatest(1, extract(epoch from (now() - p.created_at)) / 3600 + 2), 1.25)
    as trending_score
from public.forum_posts p
where (p.expires_at is null or p.expires_at > now())
  and (
    (p.moderation_status = 'published' and p.visibility = 'visible')
    or p.author_id = (select auth.uid())
    or public.is_moderator_or_admin()
  );
grant select on public.forum_post_metrics to authenticated;

commit;
