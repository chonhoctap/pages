-- Chốn Học Tập: diễn đàn V19.
-- Âm thanh được hệ thống tự động kiểm tra như văn bản, ảnh và video.
-- Kết quả chưa rõ hoặc lỗi xử lý được chuyển cho Staff/Admin.

begin;

-- Không còn chuyển thẳng âm thanh cho riêng quản trị viên.
drop trigger if exists forum_posts_manual_media_admin_v10 on public.forum_posts;
drop trigger if exists forum_post_media_manual_media_admin_v10 on public.forum_post_media;
drop trigger if exists forum_comments_manual_media_admin_v10 on public.forum_comments;
drop trigger if exists forum_comment_media_manual_media_admin_v10 on public.forum_comment_media;

-- Giữ hàm để tương thích các RPC/view cũ, nhưng không còn loại media nào
-- bắt buộc chỉ quản trị viên được duyệt.
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
  select false;
$$;

revoke execute on function public.forum_content_requires_admin_review(uuid, uuid)
  from public, anon, authenticated;

-- Giữ nguyên toàn bộ quy tắc thời hạn bài viết; chỉ đổi thông báo công khai
-- từ tên nhà cung cấp sang tên chung "Hệ thống".
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
    new.moderation_reason := 'Hệ thống đang kiểm tra nội dung trước khi công khai.';
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
    new.moderation_reason := 'Hệ thống đang kiểm tra bình luận trước khi công khai.';
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

update public.forum_posts
set moderation_reason = replace(moderation_reason, 'Gemini', 'Hệ thống')
where moderation_status = 'pending_review'
  and moderation_reason like '%Gemini%';

update public.forum_comments
set moderation_reason = replace(moderation_reason, 'Gemini', 'Hệ thống')
where moderation_status = 'pending_review'
  and moderation_reason like '%Gemini%';

comment on function public.forum_content_requires_admin_review(uuid, uuid) is
  'V19: âm thanh do hệ thống kiểm tra; nội dung chưa rõ được Staff/Admin duyệt.';

commit;
