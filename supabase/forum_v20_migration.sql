-- Chốn Học Tập: diễn đàn V20.
-- Đồng bộ lớp chống spam đăng bài về một nguồn duy nhất.
--
-- Lỗi cũ:
--   * Nút đăng bài đọc public.forum_post_cooldowns qua get_forum_post_cooldown().
--   * Trigger forum_posts_rate_limit_v9 lại chặn bằng public.forum_post_rate_limits.
-- Hai trigger v8/v9 cùng chạy khiến giao diện có thể hết giờ nhưng INSERT vẫn bị chặn.
--
-- V20 giữ hệ v8 đang được frontend và migration V18 sử dụng. Dữ liệu lịch sử
-- từ bảng v9 được gộp trước khi tháo trigger v9; hàm/bảng cũ chưa bị xóa để
-- việc phục hồi vẫn an toàn nếu cần.

begin;

insert into public.forum_post_cooldowns as cooldowns(author_id, last_post_at)
select user_id, last_posted_at
from public.forum_post_rate_limits
where last_posted_at is not null
on conflict (author_id) do update
set last_post_at = greatest(cooldowns.last_post_at, excluded.last_post_at);

drop trigger if exists forum_posts_rate_limit_v9 on public.forum_posts;

commit;
