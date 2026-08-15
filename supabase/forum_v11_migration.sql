-- Chốn Học Tập: diễn đàn V11 (OpenAI Moderation cho văn bản và hình ảnh).
-- Yêu cầu: đã chạy forum_v10_migration.sql.

begin;

-- Giữ cơ chế chốt kiểm duyệt tối đa khoảng 5 phút nhưng đổi toàn bộ lý do
-- vận hành sang nhà cung cấp hiện tại.
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
      moderation_reason = 'OpenAI không hoàn tất kiểm duyệt trong thời gian cho phép. Vui lòng đăng lại.',
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
      moderation_reason = 'OpenAI không hoàn tất kiểm duyệt trong thời gian cho phép. Vui lòng gửi lại.',
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

update public.forum_posts p
set moderation_reason = 'OpenAI đang kiểm tra văn bản và hình ảnh trước khi công khai.'
where p.moderation_status = 'pending_review'
  and p.ai_moderation_status = 'pending'
  and not public.forum_content_requires_admin_review(p.id, null);

update public.forum_comments c
set moderation_reason = 'OpenAI đang kiểm tra bình luận trước khi công khai.'
where c.moderation_status = 'pending_review'
  and not public.forum_content_requires_admin_review(null, c.id);

commit;
