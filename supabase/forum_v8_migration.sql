-- Chốn Học Tập: diễn đàn V8 (Hive Moderation và hàng chờ an toàn).
-- Yêu cầu: đã chạy forum_v7_migration.sql.
-- Chạy toàn bộ file này trong Supabase Dashboard > SQL Editor trước khi
-- deploy phiên bản mới của Edge Function moderate-forum.

begin;

-- Lưu vết kiểm duyệt cho bình luận giống bài viết để biết Hive đã duyệt,
-- từ chối hay đã chuyển cho người quản trị.
alter table public.forum_comments
  add column if not exists ai_moderation_status text not null default 'approved',
  add column if not exists ai_moderation_reason text,
  add column if not exists ai_moderation_result jsonb,
  add column if not exists ai_moderated_at timestamptz;

alter table public.forum_comments
  drop constraint if exists forum_comments_ai_moderation_values;
alter table public.forum_comments
  add constraint forum_comments_ai_moderation_values
    check (ai_moderation_status in ('pending', 'approved', 'rejected', 'manual_review'));

-- Những nội dung từng bị kẹt do OpenAI trả 429 không còn hiển thị sai rằng AI
-- vẫn đang chạy. Chúng được chuyển thành hàng chờ rõ ràng để staff xử lý hoặc
-- chủ nội dung bấm kiểm tra lại sau khi Hive được cấu hình.
update public.forum_posts
set moderation_reason = 'Kiểm duyệt tự động trước đó chưa hoàn tất. Đang chờ kiểm tra lại bằng Hive hoặc người quản trị duyệt.',
    ai_moderation_status = 'manual_review',
    ai_moderation_reason = 'Kiểm duyệt tự động trước đó chưa hoàn tất.',
    ai_moderation_result = jsonb_build_object(
      'provider', 'migration',
      'reason', 'legacy_provider_failed'
    ),
    ai_moderated_at = now()
where moderation_status = 'pending_review'
  and ai_moderation_status = 'pending';

update public.forum_comments
set moderation_reason = 'Kiểm duyệt tự động trước đó chưa hoàn tất. Đang chờ kiểm tra lại bằng Hive hoặc người quản trị duyệt.',
    ai_moderation_status = 'manual_review',
    ai_moderation_reason = 'Kiểm duyệt tự động trước đó chưa hoàn tất.',
    ai_moderation_result = jsonb_build_object(
      'provider', 'migration',
      'reason', 'legacy_provider_failed'
    ),
    ai_moderated_at = now()
where moderation_status = 'pending_review';

-- Bình luận mới luôn khởi tạo trạng thái AI pending. Edge Function sẽ đổi sang
-- approved/rejected/manual_review trong cùng quy trình kiểm duyệt.
create or replace function public.prepare_forum_comment_v8()
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
    new.moderation_reason = 'Hive đang kiểm tra bình luận trước khi công khai.';
    new.ai_moderation_status = 'pending';
    new.ai_moderation_reason = null;
    new.ai_moderation_result = null;
    new.ai_moderated_at = null;
  elsif new.body is distinct from old.body then
    new.moderation_status = 'pending_review';
    new.moderation_reason = 'Hive đang kiểm tra lại bình luận vừa sửa.';
    new.ai_moderation_status = 'pending';
    new.ai_moderation_reason = null;
    new.ai_moderation_result = null;
    new.ai_moderated_at = null;
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
drop trigger if exists forum_comments_prepare_v8 on public.forum_comments;
create trigger forum_comments_prepare_v8
before insert or update of body, parent_comment_id
on public.forum_comments
for each row execute procedure public.prepare_forum_comment_v8();

-- Khi người quản trị xử lý hàng chờ, lưu rõ kết quả là quyết định của con
-- người. Việc này giúp tránh gửi lại thông báo hoặc hiểu nhầm là Hive đã duyệt.
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
  if review_action not in ('approve', 'reject') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_comments
  set moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
      moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
      ai_moderation_status = case when review_action = 'approve' then 'approved' else 'rejected' end,
      ai_moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
      ai_moderation_result = jsonb_build_object(
        'provider', 'human',
        'reviewerId', (select auth.uid()),
        'action', review_action,
        'reviewedAt', now()
      ),
      ai_moderated_at = now()
  where id = target_comment_id
  returning author_id, post_id into comment_author, target_post;
  get diagnostics changed = row_count;

  if changed = 1 and comment_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(
      recipient_id, actor_id, type, post_id, comment_id, message
    ) values (
      comment_author,
      (select auth.uid()),
      'review',
      target_post,
      target_comment_id,
      case when review_action = 'approve'
        then 'Bình luận của bạn đã được duyệt.'
        else 'Bình luận của bạn không được duyệt.'
      end
    );
  end if;
  return changed = 1;
end;
$$;

revoke execute on function public.review_forum_comment(uuid, text, text)
  from public, anon;
grant execute on function public.review_forum_comment(uuid, text, text)
  to authenticated;

commit;
