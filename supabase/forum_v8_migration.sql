-- Chốn Học Tập: diễn đàn V8 (giữ thời gian chờ đăng bài sau khi xóa bài).
-- Yêu cầu: đã chạy forum_v7_migration.sql.

begin;

-- Mốc chống spam được lưu độc lập với bài viết. Vì vậy xóa bài sẽ không xóa
-- luôn thời gian chờ 15 phút của tác giả.
create table if not exists public.forum_post_cooldowns (
  author_id uuid primary key
    references public.profiles(id) on delete cascade,
  last_post_at timestamptz not null
);

alter table public.forum_post_cooldowns enable row level security;

-- Giữ lại thời gian chờ của các bài đã tồn tại trước khi chạy migration.
insert into public.forum_post_cooldowns as cooldowns(author_id, last_post_at)
select author_id, max(created_at)
from public.forum_posts
group by author_id
on conflict (author_id) do update
set last_post_at = greatest(
  cooldowns.last_post_at,
  excluded.last_post_at
);

-- Claim mốc đăng theo một thao tác atomic để hai tab không thể cùng vượt qua
-- giới hạn. Bản ghi này không có khóa ngoại tới forum_posts nên vẫn còn khi
-- bài vừa đăng bị xóa.
create or replace function public.enforce_forum_post_cooldown_v8()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  claimed_at timestamptz;
begin
  -- Các tác vụ backend dùng service role không có auth.uid() và không bị chặn.
  if caller_id is null then
    return new;
  end if;

  if caller_id <> new.author_id then
    raise exception 'Không thể đăng bài thay cho tài khoản khác';
  end if;

  insert into public.forum_post_cooldowns as cooldowns(author_id, last_post_at)
  values (new.author_id, now())
  on conflict (author_id) do update
  set last_post_at = excluded.last_post_at
  where cooldowns.last_post_at
    <= excluded.last_post_at - interval '15 minutes'
  returning last_post_at into claimed_at;

  if claimed_at is null then
    raise exception 'Bạn chỉ có thể đăng một bài sau mỗi 15 phút';
  end if;

  return new;
end;
$$;

drop trigger if exists forum_posts_claim_cooldown_v8 on public.forum_posts;
create trigger forum_posts_claim_cooldown_v8
before insert on public.forum_posts
for each row execute procedure public.enforce_forum_post_cooldown_v8();

-- Frontend chỉ nhận đúng thời điểm được đăng tiếp của tài khoản đang đăng
-- nhập; không được đọc hoặc sửa bảng cooldown trực tiếp.
create or replace function public.get_forum_post_cooldown()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.last_post_at + interval '15 minutes' > now()
      then c.last_post_at + interval '15 minutes'
    else null
  end
  from public.forum_post_cooldowns c
  where c.author_id = (select auth.uid());
$$;

revoke all on table public.forum_post_cooldowns from public, anon, authenticated;
revoke execute on function public.enforce_forum_post_cooldown_v8() from public, anon, authenticated;
revoke execute on function public.get_forum_post_cooldown() from public, anon;
grant execute on function public.get_forum_post_cooldown() to authenticated;

commit;
