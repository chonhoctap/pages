-- Chốn Học Tập: nâng cấp diễn đàn lần 2.
-- Yêu cầu: đã chạy forum_migration.sql.
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

begin;

-- Bình luận có thể chỉ chứa chữ, chỉ chứa media hoặc có cả hai.
alter table public.forum_comments
  add column if not exists media_url text,
  add column if not exists media_path text,
  add column if not exists media_type text;

alter table public.forum_comments
  alter column body drop not null;

alter table public.forum_comments
  drop constraint if exists forum_comments_body_length,
  drop constraint if exists forum_comments_media_type_values,
  drop constraint if exists forum_comments_media_pair,
  drop constraint if exists forum_comments_content_required;

alter table public.forum_comments
  add constraint forum_comments_body_length
    check (
      body is null
      or char_length(trim(body)) between 1 and 1200
    ),
  add constraint forum_comments_media_type_values
    check (media_type is null or media_type in ('image', 'video')),
  add constraint forum_comments_media_pair
    check (
      (media_url is null and media_path is null and media_type is null)
      or (media_url is not null and media_path is not null and media_type is not null)
    ),
  add constraint forum_comments_content_required
    check (body is not null or media_url is not null);

revoke insert on table public.forum_comments from authenticated;
revoke update on table public.forum_comments from authenticated;
grant insert (
  post_id,
  author_id,
  body,
  media_url,
  media_path,
  media_type
) on table public.forum_comments to authenticated;
grant update (
  body,
  media_url,
  media_path,
  media_type
) on table public.forum_comments to authenticated;

-- Không cho client sửa trực tiếp is_solved. Chỉ RPC có kiểm tra quyền được phép sửa.
revoke update (is_solved)
  on table public.forum_posts
  from authenticated;

create or replace function public.mark_forum_post_solved(target_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not public.is_account_active() then
    return false;
  end if;

  update public.forum_posts
  set is_solved = true
  where id = target_post_id
    and category = 'question'
    and is_solved = false
    and (
      author_id = (select auth.uid())
      or public.is_moderator_or_admin()
    );

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke execute on function public.mark_forum_post_solved(uuid) from public;
revoke execute on function public.mark_forum_post_solved(uuid) from anon;
grant execute on function public.mark_forum_post_solved(uuid) to authenticated;

-- Bucket riêng cho media bình luận: tối đa 8 MB để tiết kiệm dung lượng.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'forum-comment-media',
  'forum-comment-media',
  true,
  8388608,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public forum comment media access" on storage.objects;
create policy "Public forum comment media access"
on storage.objects
for select
to public
using (bucket_id = 'forum-comment-media');

drop policy if exists "Active members upload forum comment media" on storage.objects;
create policy "Active members upload forum comment media"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'forum-comment-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
);

drop policy if exists "Owners update forum comment media" on storage.objects;
create policy "Owners update forum comment media"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'forum-comment-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
)
with check (
  bucket_id = 'forum-comment-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
);

drop policy if exists "Owners post authors and staff delete comment media" on storage.objects;
create policy "Owners post authors and staff delete comment media"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'forum-comment-media'
  and public.is_account_active()
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.is_moderator_or_admin()
    or exists (
      select 1
      from public.forum_posts
      where id::text = (storage.foldername(name))[2]
        and author_id = (select auth.uid())
    )
  )
);

commit;
