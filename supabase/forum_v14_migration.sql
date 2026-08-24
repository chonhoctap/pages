-- Chốn Học Tập: diễn đàn V14.
-- Cho phép Thành viên đăng video; mỗi bài viết hoặc bình luận có tổng ảnh + video tối đa 50 MB.
-- Giữ nguyên: tối đa 2 ảnh, 1 video 720p/1 phút và 1 âm thanh 2 MB/1 phút.

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
  image_total bigint;
  image_video_total bigint;
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
      coalesce(sum(size_bytes) filter (where media_type = 'image'), 0),
      coalesce(sum(size_bytes) filter (where media_type in ('image', 'video')), 0)
    into image_count, video_count, audio_count, image_total, image_video_total
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
      coalesce(sum(size_bytes) filter (where media_type = 'image'), 0),
      coalesce(sum(size_bytes) filter (where media_type in ('image', 'video')), 0)
    into image_count, video_count, audio_count, image_total, image_video_total
    from public.forum_comment_media
    where comment_id = new.comment_id and id is distinct from new.id;
  end if;

  if owner_id is distinct from new.uploader_id
    and uploader_role not in ('moderator', 'admin') then
    raise exception 'Bạn không thể gắn media vào nội dung của người khác';
  end if;

  if new.media_type = 'image' then
    image_count := image_count + 1;
    image_total := image_total + new.size_bytes;
    image_video_total := image_video_total + new.size_bytes;
  elsif new.media_type = 'video' then
    video_count := video_count + 1;
    image_video_total := image_video_total + new.size_bytes;
  else
    audio_count := audio_count + 1;
  end if;

  if new.media_type in ('image', 'video')
    and (new.width is null or new.height is null) then
    raise exception 'Thiếu kích thước ảnh/video';
  end if;

  if new.media_type in ('video', 'audio')
    and new.duration_seconds is null then
    raise exception 'Thiếu thời lượng video/âm thanh';
  end if;

  if uploader_role = 'admin' then
    return new;
  end if;

  if uploader_role = 'member' then
    if image_count > 2 or video_count > 1 or audio_count > 1 then
      raise exception 'Thành viên: tối đa 2 ảnh, 1 video và 1 âm thanh';
    end if;
    if image_video_total > 52428800 then
      raise exception 'Tổng dung lượng ảnh và video tối đa 50 MB';
    end if;
    if new.media_type = 'image' and new.size_bytes > 5242880 then
      raise exception 'Mỗi ảnh thành viên tối đa 5 MB sau nén';
    end if;
    if new.media_type = 'video'
      and (new.size_bytes > 52428800 or new.duration_seconds > 60) then
      raise exception 'Video thành viên tối đa 50 MB và 1 phút';
    end if;
    if new.media_type = 'audio'
      and (new.size_bytes > 2097152 or new.duration_seconds > 60) then
      raise exception 'Âm thanh thành viên tối đa 2 MB và 1 phút';
    end if;
  else
    if image_count > 5 or video_count > 1 or audio_count > 1 then
      raise exception 'VIP/điều hành viên: tối đa 5 ảnh, 1 video và 1 âm thanh';
    end if;
    if new.media_type = 'audio'
      and (new.size_bytes > 5242880 or new.duration_seconds > 120) then
      raise exception 'Âm thanh VIP tối đa 5 MB và 2 phút';
    end if;
    if new.media_type = 'video' and new.duration_seconds > 60 then
      raise exception 'Video VIP tối đa 1 phút';
    end if;
  end if;

  if new.media_type in ('image', 'video')
    and new.width is not null and new.height is not null
    and not (
      (new.width <= 1280 and new.height <= 720)
      or (new.width <= 720 and new.height <= 1280)
    ) then
    raise exception 'Ảnh/video phải nằm trong khung 720p';
  end if;

  return new;
end;
$$;

comment on function public.validate_forum_media_limits() is
  'Giới hạn media theo role; Member được 2 ảnh + 1 video, tổng ảnh/video 50 MB cho mỗi bài hoặc bình luận.';

commit;
