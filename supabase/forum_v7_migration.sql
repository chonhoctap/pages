-- Chốn Học Tập: diễn đàn V7 (quy trình báo cáo do admin quyết định).
-- Yêu cầu: đã chạy forum_v6_migration.sql.

begin;

-- Khôi phục những bài chỉ bị trigger cũ tự động ẩn/chuyển hàng chờ và chưa
-- từng được người quản trị xem xét. Không đụng vào bài đã được admin xử lý.
update public.forum_posts
set moderation_status = 'published',
    moderation_reason = null,
    visibility = 'visible',
    hidden_at = null,
    hidden_by = null
where reviewed_at is null
  and moderation_reason in (
    'Bài viết đã bị báo cáo và đang chờ quản trị viên xem xét.',
    'Bài viết nhận được nhiều báo cáo từ cộng đồng.'
  );

-- Báo cáo chỉ tạo thư cho admin. Bài viết giữ nguyên trạng thái cho đến khi
-- admin tự chọn duyệt, ẩn hoặc xóa.
create or replace function public.flag_frequently_reported_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.forum_notifications(
    recipient_id,
    actor_id,
    type,
    post_id,
    message
  )
  select
    p.id,
    new.reporter_id,
    'report',
    new.post_id,
    'Có báo cáo bài viết mới. Hãy xem xét và quyết định duyệt, ẩn hoặc xóa.'
  from public.profiles p
  where p.role = 'admin'
    and p.account_status = 'active';
  return new;
end;
$$;

-- Chỉ người báo cáo và admin được đọc báo cáo. Moderator không nhận hộp thư
-- báo cáo và cũng không xử lý báo cáo thay admin.
drop policy if exists "Members can view own reports and staff view all"
  on public.forum_reports;
create policy "Members view own reports and admins view all"
on public.forum_reports
for select
to authenticated
using (
  reporter_id = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.account_status = 'active'
  )
);

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
  if not exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.account_status = 'active'
  ) then
    raise exception 'Chỉ quản trị viên được xử lý báo cáo';
  end if;
  if review_status not in ('resolved', 'dismissed') then
    raise exception 'Trạng thái báo cáo không hợp lệ';
  end if;

  update public.forum_reports
  set status = review_status,
      reviewed_by = (select auth.uid()),
      reviewed_at = now()
  where id = target_report_id
    and status = 'open';
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke execute on function public.review_forum_report(uuid, text)
  from public, anon;
grant execute on function public.review_forum_report(uuid, text)
  to authenticated;

-- Trigger forum_reports_flag_post từ V3/V5 tiếp tục gọi hàm đã thay thế ở trên.

commit;
