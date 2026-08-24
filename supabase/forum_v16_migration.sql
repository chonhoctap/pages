-- Chốn Học Tập: diễn đàn V16.
-- Video và âm thanh không giới hạn thời lượng.
-- Mỗi bài viết hoặc bình luận có tổng ảnh + video + âm thanh tối đa 50 MB.
-- Ảnh giữ nguyên độ phân giải; video lưu cuối cùng phải nằm trong khung 720p.

begin;

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
begin
  select role into uploader_role
  from public.profiles
  where id = new.uploader_id and account_status = 'active';

  if not found then
    raise exception 'Tài khoản không được phép tải media';
  end if;

  if tg_table_name = 'forum_post_media' then
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

  if new.media_type in ('video', 'audio')
    and new.duration_seconds is null then
    raise exception 'Thiếu thời lượng video/âm thanh';
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
  'Video/âm thanh không giới hạn thời lượng; tổng mọi media tối đa 50 MB; video tối đa 720p.';

commit;
