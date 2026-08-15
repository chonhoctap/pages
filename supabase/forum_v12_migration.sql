-- Chốn Học Tập: diễn đàn V12.2 (tự phục hồi migration V9 chạy dở).
-- Gỡ toàn bộ kiểm tra vi phạm tự động và chuyển mọi bài viết cho Staff/Admin duyệt.
-- Yêu cầu: đã chạy forum_v11_migration.sql.

begin;

-- Một số project đã xóa bảng từ cấm nhưng hàm SQL V9 vẫn phụ thuộc vào bảng.
-- Dựng lại một bảng rỗng đúng cấu trúc trước khi thay hàm để PostgreSQL có thể
-- xử lý an toàn cả database đang ở trạng thái migration chạy dở.
create table if not exists public.forum_banned_terms (
  term text primary key,
  normalized_term text not null default '',
  category text not null default 'profanity',
  match_mode text not null default 'token',
  max_distance smallint not null default 0,
  active boolean not null default true
);

-- Vô hiệu hóa bộ lọc ngay đầu migration. Bảng tạm phía trên được xóa ở cuối.
create or replace function public.forum_text_needs_review(
  post_title text,
  post_body text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select false;
$$;

revoke execute on function public.forum_text_needs_review(text, text)
  from public, anon;

-- Một số bản V13 đã xóa nhầm hàm kiểm tra admin riêng. Tạo lại để policy và
-- RPC luôn phân biệt đúng moderator với admin.
create or replace function public.is_active_forum_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.account_status = 'active'
  );
$$;

revoke execute on function public.is_active_forum_admin()
  from public, anon;
grant execute on function public.is_active_forum_admin()
  to authenticated;

-- Dừng hàng chờ AI cũ nếu pg_cron đang hoạt động.
do $$
declare
  target_job record;
begin
  if pg_catalog.to_regclass('cron.job') is not null then
    for target_job in execute
      'select jobid from cron.job where jobname = ''expire-forum-ai-moderation-v10'''
    loop
      perform cron.unschedule(target_job.jobid);
    end loop;
  end if;
exception when others then
  raise notice 'Không cần hoặc không thể gỡ lịch cũ: %', sqlerrm;
end;
$$;

drop trigger if exists forum_posts_moderation_deadline_v10 on public.forum_posts;
drop trigger if exists forum_comments_moderation_deadline_v10 on public.forum_comments;
drop function if exists public.expire_forum_ai_moderation_v10();
drop function if exists public.set_forum_post_moderation_deadline_v10();
drop function if exists public.set_forum_comment_moderation_deadline_v10();

-- Không tự kiểm tra nội dung. Mọi bài mới hoặc vừa sửa đều chờ Staff/Admin.
create or replace function public.prepare_forum_post()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  has_comments boolean := false;
  content_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    content_changed := true;
  else
    content_changed := (
      new.title, new.body, new.hashtags, new.subject, new.grade, new.category
    ) is distinct from (
      old.title, old.body, old.hashtags, old.subject, old.grade, old.category
    );
  end if;

  if content_changed then
    new.moderation_status := 'pending_review';
    new.moderation_reason := 'Bài viết đang chờ Staff hoặc quản trị viên duyệt.';
    new.reviewed_by := null;
    new.reviewed_at := null;
    if tg_op = 'UPDATE' then new.edited_at := now(); end if;
  end if;

  if new.category = 'question' and new.is_solved = true then
    if tg_op = 'INSERT' then
      new.solved_at := coalesce(new.solved_at, now());
    elsif old.is_solved = false or old.solved_at is null then
      new.solved_at := now();
    else
      new.solved_at := old.solved_at;
    end if;
  else
    new.solved_at := null;
  end if;

  if tg_op = 'UPDATE' and new.category = 'question' and not new.is_solved then
    select exists (
      select 1
      from public.forum_comments c
      where c.post_id = new.id and c.moderation_status = 'published'
    ) into has_comments;
  end if;

  if new.is_pinned then new.expires_at := null;
  elsif new.category = 'entertainment' then
    new.expires_at := new.created_at + interval '14 days';
  elsif new.is_solved then
    new.expires_at := new.solved_at + interval '3 days';
  elsif has_comments then
    new.expires_at := new.created_at + interval '5 days';
  else
    new.expires_at := new.created_at + interval '7 days';
  end if;
  return new;
end;
$$;

drop trigger if exists forum_posts_prepare_v3 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v4 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v5 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v6 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v7 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v8 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v9 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v10 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v11 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v12 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v13 on public.forum_posts;
create trigger forum_posts_prepare_v12
before insert or update of
  title, body, hashtags, subject, grade, category, is_solved, is_pinned
on public.forum_posts
for each row execute procedure public.prepare_forum_post();

-- Bình luận không qua bộ phát hiện vi phạm. Văn bản/ảnh công khai ngay;
-- bình luận có âm thanh/video vẫn chờ admin theo quy trình media thủ công.
create or replace function public.prepare_forum_comment_v5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  needs_admin boolean := false;
  body_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    body_changed := true;
    needs_admin := coalesce(new.media_type in ('audio', 'video'), false);
  else
    body_changed := new.body is distinct from old.body;
    if body_changed then
      needs_admin := coalesce(new.media_type in ('audio', 'video'), false)
        or public.forum_content_requires_admin_review(null, new.id);
    end if;
  end if;

  if body_changed then
    if needs_admin then
      new.moderation_status := 'pending_review';
      new.moderation_reason :=
        'Bình luận có âm thanh hoặc video đang chờ quản trị viên duyệt.';
    else
      new.moderation_status := 'published';
      new.moderation_reason := null;
    end if;
    if tg_op = 'UPDATE' then new.edited_at := now(); end if;
  end if;

  if new.parent_comment_id is not null and not exists (
    select 1
    from public.forum_comments c
    where c.id = new.parent_comment_id and c.post_id = new.post_id
  ) then
    raise exception 'Bình luận được trả lời không thuộc bài viết này';
  end if;
  return new;
end;
$$;

drop trigger if exists forum_comments_prepare_v5 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v6 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v7 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v8 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v9 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v10 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v11 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v12 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v13 on public.forum_comments;
create trigger forum_comments_prepare_v12
before insert or update of body, parent_comment_id
on public.forum_comments
for each row execute procedure public.prepare_forum_comment_v5();

-- Trigger media chỉ giữ âm thanh/video của bình luận trong hàng chờ. Bài viết
-- vốn đã luôn chờ Staff/Admin nên hàm này chỉ bổ sung thông báo, không kiểm tra media.
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
begin
  if new.media_type is null or new.media_type not in ('audio', 'video') then
    return new;
  end if;

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
        moderation_reason = 'Bài viết đang chờ Staff hoặc quản trị viên duyệt.',
        reviewed_by = null,
        reviewed_at = null
    where p.id = target_post
      and p.moderation_status <> 'rejected'
    returning p.author_id into content_author;
  else
    update public.forum_comments c
    set moderation_status = 'pending_review',
        moderation_reason =
          'Bình luận có âm thanh hoặc video đang chờ quản trị viên duyệt.'
    where c.id = target_comment
      and c.moderation_status <> 'rejected'
    returning c.author_id into content_author;
  end if;

  if content_author is null then return new; end if;

  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select
    reviewer.id,
    content_author,
    'moderation',
    target_post,
    target_comment,
    case when target_comment is null
      then 'Có bài viết mới đang chờ bạn duyệt.'
      else 'Có bình luận chứa âm thanh hoặc video đang chờ bạn duyệt.'
    end
  from public.profiles reviewer
  where reviewer.account_status = 'active'
    and (
      (target_comment is null and reviewer.role in ('moderator', 'admin'))
      or (target_comment is not null and reviewer.role = 'admin')
    )
    and not exists (
      select 1
      from public.forum_notifications n
      where n.recipient_id = reviewer.id
        and n.type = 'moderation'
        and n.post_id = target_post
        and n.comment_id is not distinct from target_comment
        and n.read_at is null
    );
  return new;
end;
$$;

revoke execute on function public.queue_forum_manual_media_for_admin()
  from public, anon, authenticated;

-- Mỗi bài mới hoặc vừa chỉnh sửa đều tạo thông báo cho Staff/Admin đang hoạt động.
create or replace function public.notify_admins_for_pending_forum_post_v12()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.moderation_status <> 'pending_review' then return new; end if;

  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select
    reviewer.id,
    new.author_id,
    'moderation',
    new.id,
    null,
    case when tg_op = 'INSERT'
      then 'Có bài viết mới đang chờ bạn duyệt.'
      else 'Có bài viết vừa chỉnh sửa đang chờ bạn duyệt lại.'
    end
  from public.profiles reviewer
  where reviewer.role in ('moderator', 'admin')
    and reviewer.account_status = 'active'
    and not exists (
      select 1
      from public.forum_notifications n
      where n.recipient_id = reviewer.id
        and n.type = 'moderation'
        and n.post_id = new.id
        and n.comment_id is null
        and n.read_at is null
    );
  return new;
end;
$$;

revoke execute on function public.notify_admins_for_pending_forum_post_v12()
  from public, anon, authenticated;

drop trigger if exists forum_posts_notify_admin_v12 on public.forum_posts;
create trigger forum_posts_notify_admin_v12
after insert or update of title, body, hashtags, subject, grade, category
on public.forum_posts
for each row execute procedure public.notify_admins_for_pending_forum_post_v12();

-- Staff và admin đều được duyệt hoặc ẩn/từ chối bài viết.
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
    raise exception 'Chỉ Staff hoặc quản trị viên được duyệt bài';
  end if;
  if review_action not in ('approve', 'reject', 'hide') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_posts
  set moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
      visibility = case when review_action = 'approve' then 'visible' else 'hidden' end,
      moderation_reason = nullif(btrim(coalesce(review_note, '')), ''),
      hidden_at = case when review_action = 'approve' then null else now() end,
      hidden_by = case when review_action = 'approve' then null else (select auth.uid()) end,
      reviewed_by = (select auth.uid()),
      reviewed_at = now()
  where id = target_post_id
  returning author_id into post_author;
  get diagnostics changed = row_count;

  update public.forum_notifications
  set read_at = coalesce(read_at, now())
  where type = 'moderation'
    and post_id = target_post_id
    and comment_id is null;

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
        select 1
        from public.forum_notifications n
        where n.recipient_id = m.user_id
          and n.post_id = target_post_id
          and n.type = 'mention'
      );
  end if;
  return changed = 1;
end;
$$;

revoke execute on function public.review_forum_post(uuid, text, text)
  from public, anon;
grant execute on function public.review_forum_post(uuid, text, text)
  to authenticated;

-- Staff chỉ có quyền kiểm duyệt/ẩn bài qua các RPC ở trên. Không cho Staff
-- sửa hoặc xóa nội dung của người khác bằng truy vấn trực tiếp tới bảng.
drop policy if exists "Authors and staff can update forum posts" on public.forum_posts;
drop policy if exists "Authors and admins can update forum posts" on public.forum_posts;
create policy "Authors and admins can update forum posts"
on public.forum_posts
for update
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
)
with check (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Authors and staff can delete forum posts" on public.forum_posts;
drop policy if exists "Authors and admins can delete forum posts" on public.forum_posts;
create policy "Authors and admins can delete forum posts"
on public.forum_posts
for delete
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Authors and staff can update forum comments" on public.forum_comments;
drop policy if exists "Authors and admins can update forum comments" on public.forum_comments;
create policy "Authors and admins can update forum comments"
on public.forum_comments
for update
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
)
with check (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Authors and staff can delete forum comments" on public.forum_comments;
drop policy if exists "Authors and admins can delete forum comments" on public.forum_comments;
create policy "Authors and admins can delete forum comments"
on public.forum_comments
for delete
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Owners and staff can delete post media"
  on public.forum_post_media;
drop policy if exists "Owners and admins can delete post media"
  on public.forum_post_media;
create policy "Owners and admins can delete post media"
on public.forum_post_media
for delete
to authenticated
using (
  (
    uploader_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Owners and staff can delete comment media"
  on public.forum_comment_media;
drop policy if exists "Owners and admins can delete comment media"
  on public.forum_comment_media;
create policy "Owners and admins can delete comment media"
on public.forum_comment_media
for delete
to authenticated
using (
  (
    uploader_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Owners and staff delete forum media" on storage.objects;
drop policy if exists "Owners and admins delete forum media" on storage.objects;
create policy "Owners and admins delete forum media"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'forum-media'
  and (
    (
      (storage.foldername(name))[1] = (select auth.uid())::text
      and public.is_account_active()
    )
    or public.is_active_forum_admin()
  )
);

drop policy if exists "Owners post authors and staff delete comment media"
  on storage.objects;
drop policy if exists "Owners and admins delete forum comment media"
  on storage.objects;
create policy "Owners and admins delete forum comment media"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'forum-comment-media'
  and (
    (
      (storage.foldername(name))[1] = (select auth.uid())::text
      and public.is_account_active()
    )
    or public.is_active_forum_admin()
  )
);

-- Đánh dấu đã giải là quyền của chủ bài hoặc admin, không phải quyền Staff.
create or replace function public.mark_forum_post_solved(target_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not public.is_account_active() then return false; end if;

  update public.forum_posts
  set is_solved = true
  where id = target_post_id
    and category = 'question'
    and is_solved = false
    and (
      author_id = (select auth.uid())
      or public.is_active_forum_admin()
    );

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke execute on function public.mark_forum_post_solved(uuid)
  from public, anon;
grant execute on function public.mark_forum_post_solved(uuid)
  to authenticated;

-- Nếu lần chạy V12 cũ từng tạo một phần đối tượng, gỡ toàn bộ tại đây.
drop trigger if exists forum_post_media_blocked_hash_v12 on public.forum_post_media;
drop trigger if exists forum_comment_media_blocked_hash_v12 on public.forum_comment_media;
drop function if exists public.block_forum_media_hash(text, text, text);
drop function if exists public.reject_known_forum_media_hash();
drop function if exists public.check_forum_content_policy(text, text, text);
drop function if exists public.register_forum_content_fingerprint(uuid, text, text);
drop function if exists public.forum_post_media_review_level(uuid, text);
drop function if exists public.prepare_forum_comment_v8();
drop table if exists public.forum_blocked_media_hashes;
drop table if exists public.forum_content_fingerprints;
drop table if exists public.forum_blocked_domains;
drop table if exists public.forum_content_policies;

alter table public.forum_post_media
  drop constraint if exists forum_post_media_content_hash_format;
alter table public.forum_comment_media
  drop constraint if exists forum_comment_media_content_hash_format;
alter table public.forum_post_media drop column if exists content_hash;
alter table public.forum_comment_media drop column if exists content_hash;

-- Gỡ cả bộ từ cấm và chuẩn hóa chữ của V9.
drop function if exists public.forum_text_needs_review(text, text);
drop table if exists public.forum_banned_terms;
drop function if exists public.normalize_forum_moderation_text(text);

-- Nội dung đang chờ AI cũ được chuyển thành hàng chờ Staff/Admin.
update public.forum_posts
set moderation_reason = 'Bài viết đang chờ Staff hoặc quản trị viên duyệt.'
where moderation_status = 'pending_review';

-- Bình luận văn bản/ảnh cũ đang chờ được công khai; audio/video vẫn chờ admin.
update public.forum_comments c
set moderation_status = 'published',
    moderation_reason = null
where c.moderation_status = 'pending_review'
  and not public.forum_content_requires_admin_review(null, c.id);

-- Bảo đảm tất cả bài đang chờ đều xuất hiện trong hộp thư Staff/Admin.
insert into public.forum_notifications(
  recipient_id, actor_id, type, post_id, comment_id, message
)
select
  reviewer.id,
  p.author_id,
  'moderation',
  p.id,
  null,
  'Có bài viết đang chờ bạn duyệt.'
from public.forum_posts p
cross join public.profiles reviewer
where p.moderation_status = 'pending_review'
  and reviewer.role in ('moderator', 'admin')
  and reviewer.account_status = 'active'
  and not exists (
    select 1
    from public.forum_notifications n
    where n.recipient_id = reviewer.id
      and n.type = 'moderation'
      and n.post_id = p.id
      and n.comment_id is null
      and n.read_at is null
  );

drop index if exists public.forum_posts_moderation_deadline_v10_idx;
drop index if exists public.forum_comments_moderation_deadline_v10_idx;
alter table public.forum_posts drop column if exists moderation_deadline;
alter table public.forum_comments drop column if exists moderation_deadline;

commit;
