-- Chốn Học Tập: diễn đàn V6 (bình luận nhanh, chống spam và realtime).
-- Yêu cầu: đã chạy forum_v5_migration.sql.

begin;

-- Mốc chống spam tách khỏi bảng bình luận để xóa bình luận cũng không thể
-- lách quy tắc chờ 2 phút.
create table if not exists public.forum_comment_rate_limits (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_commented_at timestamptz not null default now()
);

alter table public.forum_comment_rate_limits enable row level security;
revoke all on table public.forum_comment_rate_limits from public, anon, authenticated;

create or replace function public.enforce_forum_comment_cooldown()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_comment_at timestamptz;
  remaining_seconds integer;
begin
  -- Các tác vụ backend không tạo bình luận thay người dùng.
  if (select auth.uid()) is null then return new; end if;
  if new.author_id is distinct from (select auth.uid()) then
    raise exception 'Không thể tạo bình luận cho tài khoản khác';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.author_id::text, 6101)
  );

  select last_commented_at into previous_comment_at
  from public.forum_comment_rate_limits
  where user_id = new.author_id;

  if previous_comment_at is not null
    and previous_comment_at > now() - interval '2 minutes' then
    remaining_seconds := greatest(
      1,
      ceil(extract(epoch from (previous_comment_at + interval '2 minutes' - now())))::integer
    );
    raise exception 'Bạn có thể bình luận tiếp sau % giây', remaining_seconds;
  end if;

  insert into public.forum_comment_rate_limits(user_id, last_commented_at)
  values (new.author_id, now())
  on conflict (user_id) do update
  set last_commented_at = excluded.last_commented_at;
  return new;
end;
$$;

revoke execute on function public.enforce_forum_comment_cooldown()
  from public, anon, authenticated;

drop trigger if exists forum_comments_rate_limit_v6 on public.forum_comments;
create trigger forum_comments_rate_limit_v6
before insert on public.forum_comments
for each row execute procedure public.enforce_forum_comment_cooldown();

-- Bật Realtime an toàn, không thêm trùng bảng nếu migration được chạy lại.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'forum_posts',
    'forum_post_media',
    'forum_comments',
    'forum_comment_media',
    'forum_reactions',
    'forum_shares',
    'forum_notifications',
    'forum_reports'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = target_table
    ) then
      execute pg_catalog.format(
        'alter publication supabase_realtime add table public.%I',
        target_table
      );
    end if;
  end loop;
end;
$$;

alter table public.forum_posts replica identity full;
alter table public.forum_post_media replica identity full;
alter table public.forum_comments replica identity full;
alter table public.forum_comment_media replica identity full;
alter table public.forum_reactions replica identity full;
alter table public.forum_shares replica identity full;
alter table public.forum_notifications replica identity full;
alter table public.forum_reports replica identity full;

commit;
