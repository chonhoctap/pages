-- Chốn Học Tập: diễn đàn V13 - kiểm duyệt lai Gemini + con người.
-- Yêu cầu: đã chạy forum_v12_migration.sql và role_permissions_migration.sql.
-- Migration này không tạo bảng bài viết mới và không dùng lại OpenAI/Hive.

begin;

alter table public.forum_posts
  add column if not exists moderation_provider text,
  add column if not exists moderation_model text,
  add column if not exists moderation_result jsonb,
  add column if not exists moderation_started_at timestamptz,
  add column if not exists moderation_completed_at timestamptz,
  add column if not exists moderation_attempts integer not null default 0;

alter table public.forum_comments
  add column if not exists moderation_provider text,
  add column if not exists moderation_model text,
  add column if not exists moderation_result jsonb,
  add column if not exists moderation_started_at timestamptz,
  add column if not exists moderation_completed_at timestamptz,
  add column if not exists moderation_attempts integer not null default 0;

alter table public.forum_posts
  drop constraint if exists forum_posts_moderation_attempts_nonnegative;
alter table public.forum_posts
  add constraint forum_posts_moderation_attempts_nonnegative
  check (moderation_attempts >= 0);

alter table public.forum_comments
  drop constraint if exists forum_comments_moderation_attempts_nonnegative;
alter table public.forum_comments
  add constraint forum_comments_moderation_attempts_nonnegative
  check (moderation_attempts >= 0);

create index if not exists forum_posts_pending_gemini_v13_idx
  on public.forum_posts(created_at)
  where moderation_status = 'pending_review';
create index if not exists forum_comments_pending_gemini_v13_idx
  on public.forum_comments(created_at)
  where moderation_status = 'pending_review';

create table if not exists public.forum_moderation_runs (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('post', 'comment')),
  target_id uuid not null,
  author_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'gemini',
  model text,
  decision text not null check (decision in ('safe', 'violation', 'suspicious', 'manual', 'error')),
  reason text,
  categories text[] not null default '{}',
  result jsonb,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now()
);

create index if not exists forum_moderation_runs_target_v13_idx
  on public.forum_moderation_runs(target_type, target_id, created_at desc);
create index if not exists forum_moderation_runs_author_v13_idx
  on public.forum_moderation_runs(author_id, created_at desc);

alter table public.forum_moderation_runs enable row level security;
drop policy if exists "Authors and reviewers read moderation runs"
  on public.forum_moderation_runs;
create policy "Authors and reviewers read moderation runs"
on public.forum_moderation_runs for select to authenticated
using (
  author_id = (select auth.uid())
  or public.is_moderator_or_admin()
);
revoke all on table public.forum_moderation_runs from anon, authenticated;
grant select on table public.forum_moderation_runs to authenticated;

-- Bài mới/chỉnh sửa luôn quay lại trạng thái Gemini đang kiểm tra.
-- Giữ nguyên toàn bộ quy tắc thời hạn V12.
create or replace function public.prepare_forum_post()
returns trigger
language plpgsql
security definer
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
    new.moderation_reason := 'Gemini đang kiểm tra nội dung trước khi công khai.';
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.ai_moderation_status := 'pending';
    new.ai_moderation_reason := null;
    new.ai_moderation_result := null;
    new.moderation_provider := 'gemini';
    new.moderation_model := 'gemini-3.6-flash';
    new.moderation_result := null;
    new.moderation_started_at := null;
    new.moderation_completed_at := null;
    new.moderation_attempts := 0;
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
      select 1 from public.forum_comments c
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

drop trigger if exists forum_posts_prepare_v12 on public.forum_posts;
drop trigger if exists forum_posts_prepare_v13 on public.forum_posts;
create trigger forum_posts_prepare_v13
before insert or update of
  title, body, hashtags, subject, grade, category, is_solved, is_pinned
on public.forum_posts
for each row execute procedure public.prepare_forum_post();

-- Mọi bình luận văn bản/ảnh/video đều được Gemini kiểm tra.
-- Âm thanh tiếp tục chuyển thẳng cho quản trị viên.
create or replace function public.prepare_forum_comment_v5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  body_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    body_changed := true;
  else
    body_changed := new.body is distinct from old.body;
  end if;

  if body_changed then
    new.moderation_status := 'pending_review';
    new.moderation_reason := 'Gemini đang kiểm tra bình luận trước khi công khai.';
    new.moderation_provider := 'gemini';
    new.moderation_model := 'gemini-3.6-flash';
    new.moderation_result := null;
    new.moderation_started_at := null;
    new.moderation_completed_at := null;
    new.moderation_attempts := 0;
    if tg_op = 'UPDATE' then new.edited_at := now(); end if;
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

drop trigger if exists forum_comments_prepare_v12 on public.forum_comments;
drop trigger if exists forum_comments_prepare_v13 on public.forum_comments;
create trigger forum_comments_prepare_v13
before insert or update of body, parent_comment_id
on public.forum_comments
for each row execute procedure public.prepare_forum_comment_v5();

-- Chỉ âm thanh bắt buộc quản trị viên duyệt. Video được Gemini kiểm tra.
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
      target_post_id is not null and (
        exists (select 1 from public.forum_posts p
          where p.id = target_post_id and p.media_type = 'audio')
        or exists (select 1 from public.forum_post_media m
          where m.post_id = target_post_id and m.media_type = 'audio')
      )
    )
    or
    (
      target_comment_id is not null and (
        exists (select 1 from public.forum_comments c
          where c.id = target_comment_id and c.media_type = 'audio')
        or exists (select 1 from public.forum_comment_media m
          where m.comment_id = target_comment_id and m.media_type = 'audio')
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
begin
  if new.media_type is null or new.media_type <> 'audio' then return new; end if;

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
        moderation_reason = 'Nội dung có âm thanh đang chờ quản trị viên duyệt.',
        ai_moderation_status = 'manual_review',
        ai_moderation_reason = 'Âm thanh do quản trị viên duyệt.',
        moderation_provider = 'manual',
        moderation_model = null,
        moderation_completed_at = now(),
        reviewed_by = null,
        reviewed_at = null
    where p.id = target_post and p.moderation_status <> 'rejected'
    returning p.author_id into content_author;
  else
    update public.forum_comments c
    set moderation_status = 'pending_review',
        moderation_reason = 'Bình luận có âm thanh đang chờ quản trị viên duyệt.',
        moderation_provider = 'manual',
        moderation_model = null,
        moderation_completed_at = now()
    where c.id = target_comment and c.moderation_status <> 'rejected'
    returning c.author_id into content_author;
  end if;

  if content_author is null then return new; end if;
  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select reviewer.id, content_author, 'moderation', target_post, target_comment,
    case when target_comment is null
      then 'Có bài viết chứa âm thanh đang chờ bạn duyệt.'
      else 'Có bình luận chứa âm thanh đang chờ bạn duyệt.' end
  from public.profiles reviewer
  where reviewer.role = 'admin'
    and reviewer.account_status = 'active'
    and not exists (
      select 1 from public.forum_notifications n
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

-- V12 thông báo tất cả bài ngay khi vừa insert. V13 chỉ thông báo con người
-- khi Gemini trả về "nghi ngờ"; Edge Function chịu trách nhiệm tạo thông báo.
drop trigger if exists forum_posts_notify_admin_v12 on public.forum_posts;

-- Frontend gọi RPC này chỉ khi không thể kết nối Edge Function. Nhờ vậy nội
-- dung không bao giờ mắc kẹt mà Staff/Admin không biết.
create or replace function public.queue_forum_human_review_v13(
  target_type text,
  target_id uuid,
  review_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_post uuid;
  target_comment uuid;
  content_author uuid;
  admin_only boolean := false;
begin
  if target_type = 'post' then
    select p.id, p.author_id,
      public.forum_content_requires_admin_review(p.id, null)
    into target_post, content_author, admin_only
    from public.forum_posts p where p.id = target_id;
  elsif target_type = 'comment' then
    select c.post_id, c.id, c.author_id,
      public.forum_content_requires_admin_review(null, c.id)
    into target_post, target_comment, content_author, admin_only
    from public.forum_comments c where c.id = target_id;
  else
    raise exception 'Loại nội dung không hợp lệ';
  end if;

  if content_author is null then return false; end if;
  if content_author <> (select auth.uid()) and not public.is_moderator_or_admin() then
    raise exception 'Bạn không có quyền chuyển nội dung này cho kiểm duyệt viên';
  end if;

  if target_comment is null then
    update public.forum_posts
    set moderation_status = 'pending_review',
        visibility = 'hidden',
        moderation_reason = coalesce(nullif(btrim(review_reason), ''),
          'Không thể hoàn tất kiểm tra tự động; cần Staff hoặc quản trị viên xem xét.'),
        ai_moderation_status = 'manual_review'
    where id = target_post;
  else
    update public.forum_comments
    set moderation_status = 'pending_review',
        moderation_reason = coalesce(nullif(btrim(review_reason), ''),
          'Không thể hoàn tất kiểm tra tự động; cần Staff hoặc quản trị viên xem xét.')
    where id = target_comment;
  end if;

  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select reviewer.id, content_author, 'moderation', target_post, target_comment,
    'Kiểm tra tự động chưa hoàn tất; có nội dung cần bạn xem xét.'
  from public.profiles reviewer
  where reviewer.account_status = 'active'
    and (
      (admin_only and reviewer.role = 'admin')
      or (not admin_only and reviewer.role in ('moderator', 'admin'))
    )
    and not exists (
      select 1 from public.forum_notifications n
      where n.recipient_id = reviewer.id
        and n.type = 'moderation'
        and n.post_id = target_post
        and n.comment_id is not distinct from target_comment
        and n.read_at is null
    );
  return true;
end;
$$;

revoke execute on function public.queue_forum_human_review_v13(text, uuid, text)
  from public, anon;
grant execute on function public.queue_forum_human_review_v13(text, uuid, text)
  to authenticated;

-- Dọn dữ liệu trạng thái cũ nhưng không tự động công khai nội dung đang chờ.
update public.forum_posts
set moderation_provider = case
      when ai_moderation_status = 'manual_review' then 'manual'
      else coalesce(moderation_provider, 'gemini') end,
    moderation_model = case
      when ai_moderation_status = 'manual_review' then null
      else coalesce(moderation_model, 'gemini-3.6-flash') end
where moderation_status = 'pending_review';

update public.forum_comments
set moderation_provider = case
      when public.forum_content_requires_admin_review(null, id) then 'manual'
      else coalesce(moderation_provider, 'gemini') end,
    moderation_model = case
      when public.forum_content_requires_admin_review(null, id) then null
      else coalesce(moderation_model, 'gemini-3.6-flash') end
where moderation_status = 'pending_review';

commit;
