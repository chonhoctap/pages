-- Chốn Học Tập: diễn đàn V18.
-- Đặc quyền đăng bài VIP:
--   * Không có thời gian chờ 15 phút.
--   * Media của bài viết không giới hạn số lượng, dung lượng, thời lượng
--     hoặc độ phân giải.
-- Giới hạn bình luận VIP và mọi giới hạn của role khác vẫn giữ nguyên.

begin;

create or replace function public.enforce_forum_post_cooldown_v8()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_role text;
  caller_status text;
  claimed_at timestamptz;
begin
  -- Các tác vụ backend dùng service role không có auth.uid() và không bị chặn.
  if caller_id is null then
    return new;
  end if;

  if caller_id <> new.author_id then
    raise exception 'Không thể đăng bài thay cho tài khoản khác';
  end if;

  select role, account_status
  into caller_role, caller_status
  from public.profiles
  where id = caller_id;

  if caller_status is distinct from 'active' then
    raise exception 'Tài khoản hiện không được phép đăng bài';
  end if;

  -- VIP được đăng liên tiếp và không tạo/cập nhật mốc chờ.
  if caller_role = 'vip' then
    return new;
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

create or replace function public.get_forum_post_cooldown()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p.role = 'vip' then null
    when c.last_post_at + interval '15 minutes' > now()
      then c.last_post_at + interval '15 minutes'
    else null
  end
  from public.profiles p
  left join public.forum_post_cooldowns c on c.author_id = p.id
  where p.id = (select auth.uid());
$$;

create or replace function public.validate_forum_media_limits()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uploader_role text;
  owner_id uuid;
  image_count integer;
  video_count integer;
  audio_count integer;
  media_total bigint;
  is_post_media boolean := tg_table_name = 'forum_post_media';
begin
  select role into uploader_role
  from public.profiles
  where id = new.uploader_id and account_status = 'active';

  if not found then
    raise exception 'Tài khoản không được phép tải media';
  end if;

  if is_post_media then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.post_id::text, 5101)
    );
    select author_id into owner_id
    from public.forum_posts
    where id = new.post_id;

    select
      count(*) filter (where media_type = 'image'),
      count(*) filter (where media_type = 'video'),
      count(*) filter (where media_type = 'audio'),
      coalesce(sum(size_bytes), 0)
    into image_count, video_count, audio_count, media_total
    from public.forum_post_media
    where post_id = new.post_id and id is distinct from new.id;
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.comment_id::text, 5102)
    );
    select author_id into owner_id
    from public.forum_comments
    where id = new.comment_id;

    select
      count(*) filter (where media_type = 'image'),
      count(*) filter (where media_type = 'video'),
      count(*) filter (where media_type = 'audio'),
      coalesce(sum(size_bytes), 0)
    into image_count, video_count, audio_count, media_total
    from public.forum_comment_media
    where comment_id = new.comment_id and id is distinct from new.id;
  end if;

  if owner_id is distinct from new.uploader_id
    and uploader_role not in ('moderator', 'admin') then
    raise exception 'Bạn không thể gắn media vào nội dung của người khác';
  end if;

  if new.media_type = 'image' then
    image_count := image_count + 1;
  elsif new.media_type = 'video' then
    video_count := video_count + 1;
  else
    audio_count := audio_count + 1;
  end if;
  media_total := media_total + new.size_bytes;

  if new.media_type in ('image', 'video')
    and (new.width is null or new.height is null) then
    raise exception 'Thiếu kích thước ảnh/video';
  end if;

  -- Chỉ media gắn vào bài viết của VIP được miễn toàn bộ hạn mức.
  if is_post_media and uploader_role = 'vip' then
    return new;
  end if;

  if new.media_type = 'video'
    and not (
      (new.width <= 1280 and new.height <= 720)
      or (new.width <= 720 and new.height <= 1280)
    ) then
    raise exception 'Video phải được nén về tối đa 720p trước khi lưu';
  end if;

  if media_total > 52428800 then
    raise exception 'Tổng dung lượng ảnh, video và âm thanh tối đa 50 MB';
  end if;

  if uploader_role = 'admin' then
    return new;
  end if;

  if uploader_role = 'member' then
    if image_count > 2 or video_count > 1 or audio_count > 1 then
      raise exception 'Thành viên: tối đa 2 ảnh, 1 video và 1 âm thanh';
    end if;
  else
    if image_count > 5 or video_count > 1 or audio_count > 1 then
      raise exception 'VIP/điều hành viên: tối đa 5 ảnh, 1 video và 1 âm thanh';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.validate_forum_media_limits() is
  'VIP không giới hạn media khi đăng bài; bình luận VIP và các role khác giữ hạn mức V17.';

revoke execute on function public.enforce_forum_post_cooldown_v8() from public, anon, authenticated;
revoke execute on function public.get_forum_post_cooldown() from public, anon;
grant execute on function public.get_forum_post_cooldown() to authenticated;

commit;
