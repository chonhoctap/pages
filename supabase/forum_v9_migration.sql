-- Chốn Học Tập: diễn đàn V9 (lọc nghiêm ngặt và âm thanh do admin duyệt).
-- Yêu cầu: đã chạy forum_v8_migration.sql.

begin;

create extension if not exists unaccent with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;

-- Chuẩn hóa chữ cố tình viết né: bỏ dấu, đổi số/ký hiệu gần giống chữ,
-- thu gọn ký tự lặp và bỏ dấu câu thừa.
create or replace function public.normalize_forum_moderation_text(input_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        pg_catalog.translate(
          extensions.unaccent(pg_catalog.lower(pg_catalog.coalesce(input_text, ''))),
          '0134579@$!',
          'oieastgasi'
        ),
        '([a-z0-9])\1{2,}',
        '\1',
        'g'
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  );
$$;

create table if not exists public.forum_banned_terms (
  term text primary key,
  normalized_term text not null,
  category text not null,
  match_mode text not null default 'token',
  max_distance smallint not null default 1,
  active boolean not null default true,
  constraint forum_banned_terms_category_values
    check (category in ('profanity', 'harassment', 'sexual', 'violence')),
  constraint forum_banned_terms_mode_values
    check (match_mode in ('token', 'phrase', 'compact')),
  constraint forum_banned_terms_distance_values
    check (max_distance between 0 and 2)
);

alter table public.forum_banned_terms enable row level security;
revoke all on table public.forum_banned_terms from public, anon, authenticated;

-- Danh sách khởi đầu chỉ chứa cụm có độ tin cậy cao. Admin có thể bổ sung
-- trực tiếp trong SQL Editor mà không cần sửa website.
insert into public.forum_banned_terms(
  term,
  normalized_term,
  category,
  match_mode,
  max_distance
)
select
  source.term,
  public.normalize_forum_moderation_text(source.term),
  source.category,
  source.match_mode,
  source.max_distance
from (values
  ('địt mẹ', 'profanity', 'compact', 0),
  ('địt con mẹ', 'profanity', 'compact', 0),
  ('đụ má', 'profanity', 'compact', 0),
  ('đụ mẹ', 'profanity', 'compact', 0),
  ('con mẹ mày', 'profanity', 'compact', 0),
  ('vãi lồn', 'profanity', 'compact', 0),
  ('cái lồn', 'profanity', 'compact', 0),
  ('dmm', 'profanity', 'token', 0),
  ('dmml', 'profanity', 'token', 0),
  ('dcm', 'profanity', 'token', 0),
  ('dkm', 'profanity', 'token', 0),
  ('clm', 'profanity', 'token', 0),
  ('vcl', 'profanity', 'token', 0),
  ('fuck', 'profanity', 'token', 1),
  ('fukc', 'profanity', 'token', 0),
  ('fucking', 'profanity', 'token', 1),
  ('motherfucker', 'profanity', 'token', 2),
  ('óc chó', 'harassment', 'compact', 0),
  ('ngu như chó', 'harassment', 'compact', 0),
  ('chó đẻ', 'harassment', 'compact', 0),
  ('súc vật', 'harassment', 'compact', 0),
  ('khốn nạn', 'harassment', 'compact', 0),
  ('mất dạy', 'harassment', 'compact', 0),
  ('đồ ngu', 'harassment', 'compact', 0),
  ('ngu ngốc', 'harassment', 'compact', 0),
  ('đần độn', 'harassment', 'compact', 0),
  ('bitch', 'harassment', 'token', 1),
  ('whore', 'harassment', 'token', 1),
  ('slut', 'harassment', 'token', 1),
  ('hiếp dâm', 'sexual', 'compact', 0),
  ('khoe thân', 'sexual', 'compact', 0),
  ('ảnh nóng', 'sexual', 'compact', 0),
  ('clip nóng', 'sexual', 'compact', 0),
  ('porn', 'sexual', 'token', 1),
  ('hentai', 'sexual', 'token', 1),
  ('nude', 'sexual', 'token', 1),
  ('nudes', 'sexual', 'token', 1),
  ('tao giết', 'violence', 'compact', 0),
  ('giết mày', 'violence', 'compact', 0),
  ('giết chết', 'violence', 'compact', 0),
  ('chém chết', 'violence', 'compact', 0),
  ('chặt xác', 'violence', 'compact', 0),
  ('xác chết', 'violence', 'compact', 0)
) as source(term, category, match_mode, max_distance)
on conflict (term) do update
set normalized_term = excluded.normalized_term,
    category = excluded.category,
    match_mode = excluded.match_mode,
    max_distance = excluded.max_distance,
    active = true;

create index if not exists forum_banned_terms_active_idx
  on public.forum_banned_terms(active, match_mode);

-- Lớp lọc thứ nhất chạy ngay trong database. Cụm compact bắt kiểu chèn dấu,
-- khoảng trắng; token dùng Levenshtein để bắt lỗi gần giống có chủ ý.
create or replace function public.forum_text_needs_review(
  post_title text,
  post_body text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with prepared as (
    select public.normalize_forum_moderation_text(
      pg_catalog.coalesce(post_title, '') || ' ' || pg_catalog.coalesce(post_body, '')
    ) as normalized_text
  ), expanded as (
    select
      normalized_text,
      pg_catalog.regexp_replace(normalized_text, '[^a-z0-9]+', '', 'g') as compact_text
    from prepared
  ), tokens as (
    select token
    from expanded,
      lateral pg_catalog.regexp_split_to_table(normalized_text, '[^a-z0-9]+') as token
    where token <> ''
  )
  select exists (
    select 1
    from public.forum_banned_terms banned
    cross join expanded content
    where banned.active
      and (
        (
          banned.match_mode = 'compact'
          and content.compact_text like '%'
            || pg_catalog.regexp_replace(banned.normalized_term, '[^a-z0-9]+', '', 'g')
            || '%'
        )
        or (
          banned.match_mode = 'phrase'
          and (' ' || content.normalized_text || ' ')
            like '% ' || banned.normalized_term || ' %'
        )
        or (
          banned.match_mode = 'token'
          and (
            (
              pg_catalog.length(banned.normalized_term) >= 4
              and content.compact_text like '%' || banned.normalized_term || '%'
            )
            or exists (
              select 1
              from tokens
              where token = banned.normalized_term
                or (
                  banned.max_distance > 0
                  and pg_catalog.length(banned.normalized_term) >= 4
                  and pg_catalog.abs(
                    pg_catalog.length(token) - pg_catalog.length(banned.normalized_term)
                  ) <= banned.max_distance
                  and extensions.levenshtein(token, banned.normalized_term)
                    <= banned.max_distance
                )
            )
          )
        )
      )
  );
$$;

revoke execute on function public.normalize_forum_moderation_text(text)
  from public, anon, authenticated;
revoke execute on function public.forum_text_needs_review(text, text)
  from public, anon;
grant execute on function public.forum_text_needs_review(text, text)
  to authenticated;

-- Xác định quyền admin riêng; moderator không được quyết định nội dung âm thanh.
create or replace function public.is_active_forum_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.account_status = 'active'
  );
$$;

create or replace function public.forum_content_has_audio(
  target_post_id uuid default null,
  target_comment_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      target_post_id is not null
      and (
        exists (
          select 1 from public.forum_posts p
          where p.id = target_post_id and p.media_type = 'audio'
        )
        or exists (
          select 1 from public.forum_post_media m
          where m.post_id = target_post_id and m.media_type = 'audio'
        )
      )
    )
    or
    (
      target_comment_id is not null
      and (
        exists (
          select 1 from public.forum_comments c
          where c.id = target_comment_id and c.media_type = 'audio'
        )
        or exists (
          select 1 from public.forum_comment_media m
          where m.comment_id = target_comment_id and m.media_type = 'audio'
        )
      )
    );
$$;

revoke execute on function public.is_active_forum_admin()
  from public, anon, authenticated;
revoke execute on function public.forum_content_has_audio(uuid, uuid)
  from public, anon, authenticated;

-- Ngay khi một file âm thanh được gắn vào bài/bình luận, nội dung bị giữ lại
-- và chỉ hộp thư admin nhận thông báo.
create or replace function public.queue_forum_audio_for_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_post uuid;
  target_comment uuid;
  content_author uuid;
begin
  if new.media_type is distinct from 'audio' then return new; end if;

  if tg_table_name = 'forum_posts' then
    target_post := new.id;
  elsif tg_table_name = 'forum_post_media' then
    target_post := new.post_id;
  elsif tg_table_name = 'forum_comments' then
    target_comment := new.id;
    target_post := new.post_id;
  elsif tg_table_name = 'forum_comment_media' then
    target_comment := new.comment_id;
    select c.post_id into target_post
    from public.forum_comments c where c.id = target_comment;
  end if;

  if target_comment is null then
    update public.forum_posts p
    set moderation_status = 'pending_review',
        moderation_reason = 'Nội dung có âm thanh: chỉ quản trị viên được nghe và quyết định duyệt.',
        ai_moderation_status = 'manual_review',
        ai_moderation_reason = 'Âm thanh do quản trị viên duyệt.',
        reviewed_by = null,
        reviewed_at = null
    where p.id = target_post
      and p.moderation_status <> 'rejected'
    returning p.author_id into content_author;
  else
    update public.forum_comments c
    set moderation_status = 'pending_review',
        moderation_reason = 'Nội dung có âm thanh: chỉ quản trị viên được nghe và quyết định duyệt.'
    where c.id = target_comment
      and c.moderation_status <> 'rejected'
    returning c.author_id into content_author;
  end if;

  -- Nội dung đã bị từ chối trước đó không được đưa ngược vào hàng chờ.
  if content_author is null then return new; end if;

  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select
    admin.id,
    content_author,
    'moderation',
    target_post,
    target_comment,
    'Nội dung có âm thanh đang chờ quản trị viên nghe và quyết định duyệt.'
  from public.profiles admin
  where admin.role = 'admin'
    and admin.account_status = 'active'
    and not exists (
      select 1 from public.forum_notifications n
      where n.recipient_id = admin.id
        and n.type = 'moderation'
        and n.post_id = target_post
        and n.comment_id is not distinct from target_comment
    );
  return new;
end;
$$;

revoke execute on function public.queue_forum_audio_for_admin()
  from public, anon, authenticated;

drop trigger if exists forum_posts_audio_admin_v9 on public.forum_posts;
create trigger forum_posts_audio_admin_v9
after insert or update of media_type on public.forum_posts
for each row execute procedure public.queue_forum_audio_for_admin();

drop trigger if exists forum_post_media_audio_admin_v9 on public.forum_post_media;
create trigger forum_post_media_audio_admin_v9
after insert or update of media_type on public.forum_post_media
for each row execute procedure public.queue_forum_audio_for_admin();

drop trigger if exists forum_comments_audio_admin_v9 on public.forum_comments;
create trigger forum_comments_audio_admin_v9
after insert or update of media_type on public.forum_comments
for each row execute procedure public.queue_forum_audio_for_admin();

drop trigger if exists forum_comment_media_audio_admin_v9 on public.forum_comment_media;
create trigger forum_comment_media_audio_admin_v9
after insert or update of media_type on public.forum_comment_media
for each row execute procedure public.queue_forum_audio_for_admin();

-- Moderator vẫn duyệt nội dung thông thường, nhưng nội dung có âm thanh bắt
-- buộc phải do admin quyết định.
create or replace function public.review_forum_post(
  target_post_id uuid,
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
  post_author uuid;
begin
  if not public.is_moderator_or_admin() then
    raise exception 'Chỉ điều hành viên hoặc quản trị viên được duyệt bài';
  end if;
  if public.forum_content_has_audio(target_post_id, null)
    and not public.is_active_forum_admin() then
    raise exception 'Bài có âm thanh chỉ quản trị viên được duyệt';
  end if;
  if review_action not in ('approve', 'reject', 'hide') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_posts
  set moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
      visibility = case when review_action = 'approve' then 'visible' else 'hidden' end,
      moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
      ai_moderation_status = case when review_action = 'approve' then 'approved' else 'rejected' end,
      ai_moderation_reason = nullif(trim(coalesce(review_note, '')), ''),
      hidden_at = case when review_action = 'approve' then null else now() end,
      hidden_by = case when review_action = 'approve' then null else (select auth.uid()) end,
      reviewed_by = (select auth.uid()),
      reviewed_at = now()
  where id = target_post_id
  returning author_id into post_author;
  get diagnostics changed = row_count;

  if changed = 1 and post_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
    values (
      post_author,
      (select auth.uid()),
      'review',
      target_post_id,
      case when review_action = 'approve' then 'Bài viết của bạn đã được duyệt.'
      else 'Bài viết của bạn đã bị ẩn hoặc từ chối.' end
    );
  end if;

  if changed = 1 and review_action = 'approve' then
    insert into public.forum_notifications(recipient_id, actor_id, type, post_id, message)
    select m.user_id, post_author, 'mention', target_post_id,
      'Bạn được nhắc đến trong một bài viết.'
    from public.forum_post_mentions m
    where m.post_id = target_post_id
      and not exists (
        select 1 from public.forum_notifications n
        where n.recipient_id = m.user_id
          and n.post_id = target_post_id
          and n.type = 'mention'
      );
  end if;
  return changed = 1;
end;
$$;

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
  if public.forum_content_has_audio(null, target_comment_id)
    and not public.is_active_forum_admin() then
    raise exception 'Bình luận có âm thanh chỉ quản trị viên được duyệt';
  end if;
  if review_action not in ('approve', 'reject') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_comments
  set moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
      moderation_reason = nullif(trim(coalesce(review_note, '')), '')
  where id = target_comment_id
  returning author_id, post_id into comment_author, target_post;
  get diagnostics changed = row_count;

  if changed = 1 and comment_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(
      recipient_id, actor_id, type, post_id, comment_id, message
    )
    values (
      comment_author,
      (select auth.uid()),
      'review',
      target_post,
      target_comment_id,
      case when review_action = 'approve' then 'Bình luận của bạn đã được duyệt.'
      else 'Bình luận của bạn không được duyệt.' end
    );
  end if;
  return changed = 1;
end;
$$;

revoke execute on function public.review_forum_post(uuid, text, text)
  from public, anon;
grant execute on function public.review_forum_post(uuid, text, text)
  to authenticated;
revoke execute on function public.review_forum_comment(uuid, text, text)
  from public, anon;
grant execute on function public.review_forum_comment(uuid, text, text)
  to authenticated;

-- Thu hồi ngay các nội dung âm thanh cũ đang công khai để admin xem xét lại.
update public.forum_posts p
set moderation_status = 'pending_review',
    moderation_reason = 'Nội dung có âm thanh: chỉ quản trị viên được nghe và quyết định duyệt.',
    ai_moderation_status = 'manual_review',
    ai_moderation_reason = 'Âm thanh do quản trị viên duyệt.',
    reviewed_by = null,
    reviewed_at = null
where p.moderation_status <> 'rejected'
  and public.forum_content_has_audio(p.id, null);

update public.forum_comments c
set moderation_status = 'pending_review',
    moderation_reason = 'Nội dung có âm thanh: chỉ quản trị viên được nghe và quyết định duyệt.'
where c.moderation_status <> 'rejected'
  and public.forum_content_has_audio(null, c.id);

insert into public.forum_notifications(
  recipient_id, actor_id, type, post_id, comment_id, message
)
select
  admin.id,
  p.author_id,
  'moderation',
  p.id,
  null,
  'Bài viết có âm thanh đang chờ quản trị viên nghe và quyết định duyệt.'
from public.forum_posts p
cross join public.profiles admin
where admin.role = 'admin'
  and admin.account_status = 'active'
  and public.forum_content_has_audio(p.id, null)
  and not exists (
    select 1 from public.forum_notifications n
    where n.recipient_id = admin.id
      and n.type = 'moderation'
      and n.post_id = p.id
      and n.comment_id is null
  );

insert into public.forum_notifications(
  recipient_id, actor_id, type, post_id, comment_id, message
)
select
  admin.id,
  c.author_id,
  'moderation',
  c.post_id,
  c.id,
  'Bình luận có âm thanh đang chờ quản trị viên nghe và quyết định duyệt.'
from public.forum_comments c
cross join public.profiles admin
where admin.role = 'admin'
  and admin.account_status = 'active'
  and public.forum_content_has_audio(null, c.id)
  and not exists (
    select 1 from public.forum_notifications n
    where n.recipient_id = admin.id
      and n.type = 'moderation'
      and n.post_id = c.post_id
      and n.comment_id = c.id
  );

commit;
