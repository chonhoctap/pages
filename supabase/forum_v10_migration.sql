-- Chốn Học Tập: diễn đàn V10 (âm thanh và video chỉ admin duyệt).
-- Yêu cầu: đã chạy forum_v9_migration.sql.

begin;

-- AI phải đưa ra kết quả trong thời gian hữu hạn. Deadline đặt ở phút thứ 4 để
-- tác vụ chạy mỗi phút luôn chốt nội dung trước hoặc xấp xỉ mốc 5 phút.
alter table public.forum_posts
  add column if not exists moderation_deadline timestamptz;
alter table public.forum_comments
  add column if not exists moderation_deadline timestamptz;

create index if not exists forum_posts_moderation_deadline_v10_idx
  on public.forum_posts(moderation_deadline)
  where moderation_status = 'pending_review';
create index if not exists forum_comments_moderation_deadline_v10_idx
  on public.forum_comments(moderation_deadline)
  where moderation_status = 'pending_review';

create or replace function public.set_forum_post_moderation_deadline_v10()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.moderation_deadline := now() + interval '4 minutes';
  elsif (new.title, coalesce(new.body, ''))
    is distinct from (old.title, coalesce(old.body, '')) then
    new.moderation_deadline := now() + interval '4 minutes';
  end if;
  return new;
end;
$$;

create or replace function public.set_forum_comment_moderation_deadline_v10()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.moderation_deadline := now() + interval '4 minutes';
  elsif new.body is distinct from old.body then
    new.moderation_deadline := now() + interval '4 minutes';
  end if;
  return new;
end;
$$;

revoke execute on function public.set_forum_post_moderation_deadline_v10()
  from public, anon, authenticated;
revoke execute on function public.set_forum_comment_moderation_deadline_v10()
  from public, anon, authenticated;

drop trigger if exists forum_posts_moderation_deadline_v10 on public.forum_posts;
create trigger forum_posts_moderation_deadline_v10
before insert or update of title, body on public.forum_posts
for each row execute procedure public.set_forum_post_moderation_deadline_v10();

drop trigger if exists forum_comments_moderation_deadline_v10 on public.forum_comments;
create trigger forum_comments_moderation_deadline_v10
before insert or update of body on public.forum_comments
for each row execute procedure public.set_forum_comment_moderation_deadline_v10();

create or replace function public.forum_content_requires_admin_review(
  target_post_id uuid default null,
  target_comment_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      target_post_id is not null
      and (
        exists (
          select 1 from public.forum_posts p
          where p.id = target_post_id
            and p.media_type in ('audio', 'video')
        )
        or exists (
          select 1 from public.forum_post_media m
          where m.post_id = target_post_id
            and m.media_type in ('audio', 'video')
        )
      )
    )
    or
    (
      target_comment_id is not null
      and (
        exists (
          select 1 from public.forum_comments c
          where c.id = target_comment_id
            and c.media_type in ('audio', 'video')
        )
        or exists (
          select 1 from public.forum_comment_media m
          where m.comment_id = target_comment_id
            and m.media_type in ('audio', 'video')
        )
      )
    );
$$;

revoke execute on function public.forum_content_requires_admin_review(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.queue_forum_manual_media_for_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_post uuid;
  target_comment uuid;
  content_author uuid;
  media_label text;
begin
  if new.media_type is null or new.media_type not in ('audio', 'video') then
    return new;
  end if;
  media_label := case when new.media_type = 'audio' then 'âm thanh' else 'video' end;

  if tg_table_name = 'forum_posts' then
    target_post := new.id;
  elsif tg_table_name = 'forum_post_media' then
    target_post := new.post_id;
  elsif tg_table_name = 'forum_comments' then
    target_comment := new.id;
    target_post := new.post_id;
  elsif tg_table_name = 'forum_comment_media' then
    target_comment := new.comment_id;
    select c.post_id into target_post
    from public.forum_comments c where c.id = target_comment;
  end if;

  if target_comment is null then
    update public.forum_posts p
    set moderation_status = 'pending_review',
        moderation_reason = 'Nội dung có âm thanh hoặc video: chỉ quản trị viên được xem xét và quyết định duyệt.',
        ai_moderation_status = 'manual_review',
        ai_moderation_reason = 'Âm thanh/video do quản trị viên duyệt.',
        moderation_deadline = null,
        reviewed_by = null,
        reviewed_at = null
    where p.id = target_post
      and p.moderation_status <> 'rejected'
    returning p.author_id into content_author;
  else
    update public.forum_comments c
    set moderation_status = 'pending_review',
        moderation_reason = 'Nội dung có âm thanh hoặc video: chỉ quản trị viên được xem xét và quyết định duyệt.',
        moderation_deadline = null
    where c.id = target_comment
      and c.moderation_status <> 'rejected'
    returning c.author_id into content_author;
  end if;

  if content_author is null then return new; end if;

  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select
    admin.id,
    content_author,
    'moderation',
    target_post,
    target_comment,
    'Nội dung có ' || media_label || ' đang chờ quản trị viên xem xét.'
  from public.profiles admin
  where admin.role = 'admin'
    and admin.account_status = 'active'
    and not exists (
      select 1 from public.forum_notifications n
      where n.recipient_id = admin.id
        and n.type = 'moderation'
        and n.post_id = target_post
        and n.comment_id is not distinct from target_comment
    );
  return new;
end;
$$;

revoke execute on function public.queue_forum_manual_media_for_admin()
  from public, anon, authenticated;

drop trigger if exists forum_posts_audio_admin_v9 on public.forum_posts;
drop trigger if exists forum_post_media_audio_admin_v9 on public.forum_post_media;
drop trigger if exists forum_comments_audio_admin_v9 on public.forum_comments;
drop trigger if exists forum_comment_media_audio_admin_v9 on public.forum_comment_media;

drop trigger if exists forum_posts_manual_media_admin_v10 on public.forum_posts;
create trigger forum_posts_manual_media_admin_v10
after insert or update of media_type on public.forum_posts
for each row execute procedure public.queue_forum_manual_media_for_admin();

drop trigger if exists forum_post_media_manual_media_admin_v10 on public.forum_post_media;
create trigger forum_post_media_manual_media_admin_v10
after insert or update of media_type on public.forum_post_media
for each row execute procedure public.queue_forum_manual_media_for_admin();

drop trigger if exists forum_comments_manual_media_admin_v10 on public.forum_comments;
create trigger forum_comments_manual_media_admin_v10
after insert or update of media_type on public.forum_comments
for each row execute procedure public.queue_forum_manual_media_for_admin();

drop trigger if exists forum_comment_media_manual_media_admin_v10 on public.forum_comment_media;
create trigger forum_comment_media_manual_media_admin_v10
after insert or update of media_type on public.forum_comment_media
for each row execute procedure public.queue_forum_manual_media_for_admin();

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
  changed integer;
  post_author uuid;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được duyệt bài';
  end if;
  if public.forum_content_requires_admin_review(target_post_id, null)
    and not public.is_active_forum_admin() then
    raise exception 'Bài có âm thanh hoặc video chỉ quản trị viên được duyệt';
  end if;
  if review_action not in ('approve', 'reject', 'hide') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_posts
  set moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
      visibility = case when review_action = 'approve' then 'visible' else 'hidden' end,
      moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
      ai_moderation_status = case when review_action = 'approve' then 'approved' else 'rejected' end,
      ai_moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
      hidden_at = case when review_action = 'approve' then null else now() end,
      hidden_by = case when review_action = 'approve' then null else (select auth.uid()) end,
      reviewed_by = (select auth.uid()),
      reviewed_at = now()
  where id = target_post_id
  returning author_id into post_author;
  get diagnostics changed = row_count;

  if changed = 1 and post_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
    values (
      post_author,
      (select auth.uid()),
      'review',
      target_post_id,
      case when review_action = 'approve' then 'Bài viết của bạn đã được duyệt.'
      else 'Bài viết của bạn đã bị ẩn hoặc từ chối.' end
    );
  end if;

  if changed = 1 and review_action = 'approve' then
    insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
    select m.user_id, post_author, 'mention', target_post_id,
      'Bạn được nhắc đến trong một bài viết.'
    from public.forum_post_mentions m
    where m.post_id = target_post_id
      and not exists (
        select 1 from public.forum_notifications n
        where n.recipient_id = m.user_id
          and n.post_id = target_post_id
          and n.type = 'mention'
      );
  end if;
  return changed = 1;
end;
$$;

create or replace function public.review_forum_comment(
  target_comment_id uuid,
  review_action text,
  review_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
  comment_author uuid;
  target_post uuid;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được duyệt bình luận';
  end if;
  if public.forum_content_requires_admin_review(null, target_comment_id)
    and not public.is_active_forum_admin() then
    raise exception 'Bình luận có âm thanh hoặc video chỉ quản trị viên được duyệt';
  end if;
  if review_action not in ('approve', 'reject') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_comments
  set moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
      moderation_reason = nullif(trim(coalesce(review_note, '')), '')
  where id = target_comment_id
  returning author_id, post_id into comment_author, target_post;
  get diagnostics changed = row_count;

  if changed = 1 and comment_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(
      recipient_id, actor_id, type, post_id, comment_id, message
    )
    values (
      comment_author,
      (select auth.uid()),
      'review',
      target_post,
      target_comment_id,
      case when review_action = 'approve' then 'Bình luận của bạn đã được duyệt.'
      else 'Bình luận của bạn không được duyệt.' end
    );
  end if;
  return changed = 1;
end;
$$;

revoke execute on function public.review_forum_post(uuid, text, text)
  from public, anon;
grant execute on function public.review_forum_post(uuid, text, text)
  to authenticated;
revoke execute on function public.review_forum_comment(uuid, text, text)
  from public, anon;
grant execute on function public.review_forum_comment(uuid, text, text)
  to authenticated;

-- Video/âm thanh cũ đang công khai cũng phải quay lại hàng chờ admin.
update public.forum_posts p
set moderation_status = 'pending_review',
    moderation_reason = 'Nội dung có âm thanh hoặc video: chỉ quản trị viên được xem xét và quyết định duyệt.',
    ai_moderation_status = 'manual_review',
    ai_moderation_reason = 'Âm thanh/video do quản trị viên duyệt.',
    moderation_deadline = null,
    reviewed_by = null,
    reviewed_at = null
where p.moderation_status <> 'rejected'
  and public.forum_content_requires_admin_review(p.id, null);

update public.forum_comments c
set moderation_status = 'pending_review',
    moderation_reason = 'Nội dung có âm thanh hoặc video: chỉ quản trị viên được xem xét và quyết định duyệt.',
    moderation_deadline = null
where c.moderation_status <> 'rejected'
  and public.forum_content_requires_admin_review(null, c.id);

insert into public.forum_notifications(
  recipient_id, actor_id, type, post_id, comment_id, message
)
select
  admin.id,
  p.author_id,
  'moderation',
  p.id,
  null,
  'Bài viết có âm thanh hoặc video đang chờ quản trị viên xem xét.'
from public.forum_posts p
cross join public.profiles admin
where admin.role = 'admin'
  and admin.account_status = 'active'
  and public.forum_content_requires_admin_review(p.id, null)
  and not exists (
    select 1 from public.forum_notifications n
    where n.recipient_id = admin.id
      and n.type = 'moderation'
      and n.post_id = p.id
      and n.comment_id is null
  );

insert into public.forum_notifications(
  recipient_id, actor_id, type, post_id, comment_id, message
)
select
  admin.id,
  c.author_id,
  'moderation',
  c.post_id,
  c.id,
  'Bình luận có âm thanh hoặc video đang chờ quản trị viên xem xét.'
from public.forum_comments c
cross join public.profiles admin
where admin.role = 'admin'
  and admin.account_status = 'active'
  and public.forum_content_requires_admin_review(null, c.id)
  and not exists (
    select 1 from public.forum_notifications n
    where n.recipient_id = admin.id
      and n.type = 'moderation'
      and n.post_id = c.post_id
      and n.comment_id = c.id
  );

-- Nội dung AI cũ đang treo cũng có deadline; audio/video do admin xử lý không
-- bị cơ chế này tự từ chối.
update public.forum_posts p
set moderation_deadline = now() + interval '4 minutes'
where p.moderation_status = 'pending_review'
  and p.ai_moderation_status = 'pending'
  and not public.forum_content_requires_admin_review(p.id, null);

update public.forum_comments c
set moderation_deadline = now() + interval '4 minutes'
where c.moderation_status = 'pending_review'
  and not public.forum_content_requires_admin_review(null, c.id);

create or replace function public.expire_forum_ai_moderation_v10()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_posts integer := 0;
  expired_comments integer := 0;
begin
  update public.forum_posts p
  set moderation_status = 'rejected',
      visibility = 'hidden',
      moderation_reason = 'AI không hoàn tất kiểm duyệt trong thời gian cho phép. Vui lòng đăng lại.',
      ai_moderation_status = 'rejected',
      ai_moderation_reason = 'Hết thời gian kiểm duyệt tự động.',
      ai_moderated_at = now(),
      moderation_deadline = null
  where p.moderation_status = 'pending_review'
    and p.ai_moderation_status = 'pending'
    and p.moderation_deadline <= now()
    and not public.forum_content_requires_admin_review(p.id, null);
  get diagnostics expired_posts = row_count;

  update public.forum_comments c
  set moderation_status = 'rejected',
      moderation_reason = 'AI không hoàn tất kiểm duyệt trong thời gian cho phép. Vui lòng gửi lại.',
      moderation_deadline = null
  where c.moderation_status = 'pending_review'
    and c.moderation_deadline <= now()
    and not public.forum_content_requires_admin_review(null, c.id);
  get diagnostics expired_comments = row_count;

  return expired_posts + expired_comments;
end;
$$;

revoke execute on function public.expire_forum_ai_moderation_v10()
  from public, anon;
grant execute on function public.expire_forum_ai_moderation_v10()
  to authenticated;

-- pg_cron là tối ưu nhưng không bắt buộc: nếu project chưa cho phép extension,
-- frontend vẫn gọi hàm hết hạn khi người dùng mở diễn đàn.
do $$
begin
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  if not exists (
    select 1 from cron.job where jobname = 'expire-forum-ai-moderation-v10'
  ) then
    perform cron.schedule(
      'expire-forum-ai-moderation-v10',
      '* * * * *',
      'select public.expire_forum_ai_moderation_v10();'
    );
  end if;
exception when others then
  raise notice 'Không bật được pg_cron; diễn đàn sẽ dùng cơ chế hết hạn phía client.';
end;
$$;

-- Hai hàm V9 đã không còn trigger hay RPC nào sử dụng sau V10.
drop function if exists public.queue_forum_audio_for_admin();
drop function if exists public.forum_content_has_audio(uuid, uuid);

commit;
