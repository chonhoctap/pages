-- Chốn Học Tập: diễn đàn Hỏi đáp và Giải trí.
-- Yêu cầu: đã chạy permissions_migration.sql.
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

begin;

create or replace function public.can_view_forum()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and account_status in ('active', 'suspended')
  );
$$;

revoke execute on function public.can_view_forum() from public;
revoke execute on function public.can_view_forum() from anon;
grant execute on function public.can_view_forum() to authenticated;

create table if not exists public.forum_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  category text not null,
  title text not null,
  body text,
  hashtags text[] not null default '{}',
  subject text,
  grade text,
  is_solved boolean not null default false,
  media_url text,
  media_path text,
  media_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint forum_posts_author_id_fkey
    foreign key (author_id) references public.profiles(id) on delete cascade,
  constraint forum_posts_category_values
    check (category in ('question', 'entertainment')),
  constraint forum_posts_title_length
    check (char_length(trim(title)) between 3 and 180),
  constraint forum_posts_body_length
    check (body is null or char_length(body) <= 5000),
  constraint forum_posts_hashtags_limit
    check (cardinality(hashtags) <= 8),
  constraint forum_posts_subject_values
    check (
      subject is null
      or subject in (
        'toan',
        'vat-ly',
        'hoa-hoc',
        'sinh-hoc',
        'ngu-van',
        'tieng-anh',
        'tin-hoc',
        'khac'
      )
    ),
  constraint forum_posts_grade_values
    check (grade is null or grade in ('10', '11', '12', 'other')),
  constraint forum_posts_media_type_values
    check (media_type is null or media_type in ('image', 'video')),
  constraint forum_posts_media_pair
    check (
      (media_url is null and media_path is null and media_type is null)
      or (media_url is not null and media_path is not null and media_type is not null)
    ),
  constraint forum_posts_question_fields
    check (
      (
        category = 'question'
        and subject is not null
        and grade is not null
      )
      or (
        category = 'entertainment'
        and subject is null
        and grade is null
        and is_solved = false
      )
    )
);

create table if not exists public.forum_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null,
  author_id uuid not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint forum_comments_post_id_fkey
    foreign key (post_id) references public.forum_posts(id) on delete cascade,
  constraint forum_comments_author_id_fkey
    foreign key (author_id) references public.profiles(id) on delete cascade,
  constraint forum_comments_body_length
    check (char_length(trim(body)) between 1 and 1200)
);

create table if not exists public.forum_likes (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id),
  constraint forum_likes_post_id_fkey
    foreign key (post_id) references public.forum_posts(id) on delete cascade,
  constraint forum_likes_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade
);

create table if not exists public.forum_shares (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id),
  constraint forum_shares_post_id_fkey
    foreign key (post_id) references public.forum_posts(id) on delete cascade,
  constraint forum_shares_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade
);

create index if not exists forum_posts_category_created_idx
  on public.forum_posts(category, created_at desc);
create index if not exists forum_posts_author_created_idx
  on public.forum_posts(author_id, created_at desc);
create index if not exists forum_posts_question_filter_idx
  on public.forum_posts(grade, subject, is_solved, created_at desc)
  where category = 'question';
create index if not exists forum_posts_hashtags_idx
  on public.forum_posts using gin(hashtags);
create index if not exists forum_comments_post_created_idx
  on public.forum_comments(post_id, created_at);
create index if not exists forum_likes_post_idx
  on public.forum_likes(post_id);
create index if not exists forum_shares_post_idx
  on public.forum_shares(post_id);

drop trigger if exists forum_posts_set_updated_at on public.forum_posts;
create trigger forum_posts_set_updated_at
before update on public.forum_posts
for each row execute procedure public.set_updated_at();

drop trigger if exists forum_comments_set_updated_at on public.forum_comments;
create trigger forum_comments_set_updated_at
before update on public.forum_comments
for each row execute procedure public.set_updated_at();

alter table public.forum_posts enable row level security;
alter table public.forum_comments enable row level security;
alter table public.forum_likes enable row level security;
alter table public.forum_shares enable row level security;

drop policy if exists "Members can view forum posts" on public.forum_posts;
create policy "Members can view forum posts"
on public.forum_posts
for select
to authenticated
using (public.can_view_forum());

drop policy if exists "Active members can create forum posts" on public.forum_posts;
create policy "Active members can create forum posts"
on public.forum_posts
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and public.is_account_active()
);

drop policy if exists "Authors and staff can update forum posts" on public.forum_posts;
create policy "Authors and staff can update forum posts"
on public.forum_posts
for update
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
)
with check (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
);

drop policy if exists "Authors and staff can delete forum posts" on public.forum_posts;
create policy "Authors and staff can delete forum posts"
on public.forum_posts
for delete
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
);

drop policy if exists "Members can view forum comments" on public.forum_comments;
create policy "Members can view forum comments"
on public.forum_comments
for select
to authenticated
using (public.can_view_forum());

drop policy if exists "Active members can create forum comments" on public.forum_comments;
create policy "Active members can create forum comments"
on public.forum_comments
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and public.is_account_active()
);

drop policy if exists "Authors and staff can update forum comments" on public.forum_comments;
create policy "Authors and staff can update forum comments"
on public.forum_comments
for update
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
)
with check (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
);

drop policy if exists "Authors and staff can delete forum comments" on public.forum_comments;
create policy "Authors and staff can delete forum comments"
on public.forum_comments
for delete
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
  )
  or public.is_moderator_or_admin()
);

drop policy if exists "Members can view forum likes" on public.forum_likes;
create policy "Members can view forum likes"
on public.forum_likes
for select
to authenticated
using (public.can_view_forum());

drop policy if exists "Active members can like forum posts" on public.forum_likes;
create policy "Active members can like forum posts"
on public.forum_likes
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
);

drop policy if exists "Active members can remove own likes" on public.forum_likes;
create policy "Active members can remove own likes"
on public.forum_likes
for delete
to authenticated
using (
  user_id = (select auth.uid())
  and public.is_account_active()
);

drop policy if exists "Members can view forum shares" on public.forum_shares;
create policy "Members can view forum shares"
on public.forum_shares
for select
to authenticated
using (public.can_view_forum());

drop policy if exists "Active members can register forum shares" on public.forum_shares;
create policy "Active members can register forum shares"
on public.forum_shares
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
);

revoke all on table public.forum_posts from anon;
revoke all on table public.forum_posts from authenticated;
grant select on table public.forum_posts to authenticated;
grant insert (
  author_id,
  category,
  title,
  body,
  hashtags,
  subject,
  grade,
  is_solved,
  media_url,
  media_path,
  media_type
) on table public.forum_posts to authenticated;
grant update (
  category,
  title,
  body,
  hashtags,
  subject,
  grade,
  is_solved,
  media_url,
  media_path,
  media_type
) on table public.forum_posts to authenticated;
grant delete on table public.forum_posts to authenticated;

revoke all on table public.forum_comments from anon;
revoke all on table public.forum_comments from authenticated;
grant select on table public.forum_comments to authenticated;
grant insert (post_id, author_id, body)
  on table public.forum_comments to authenticated;
grant update (body)
  on table public.forum_comments to authenticated;
grant delete on table public.forum_comments to authenticated;

revoke all on table public.forum_likes from anon;
revoke all on table public.forum_likes from authenticated;
grant select on table public.forum_likes to authenticated;
grant insert (post_id, user_id)
  on table public.forum_likes to authenticated;
grant delete on table public.forum_likes to authenticated;

revoke all on table public.forum_shares from anon;
revoke all on table public.forum_shares from authenticated;
grant select on table public.forum_shares to authenticated;
grant insert (post_id, user_id)
  on table public.forum_shares to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'forum-media',
  'forum-media',
  true,
  26214400,
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

drop policy if exists "Public forum media access" on storage.objects;
create policy "Public forum media access"
on storage.objects
for select
to public
using (bucket_id = 'forum-media');

drop policy if exists "Active members upload forum media" on storage.objects;
create policy "Active members upload forum media"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'forum-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
);

drop policy if exists "Owners update forum media" on storage.objects;
create policy "Owners update forum media"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'forum-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
)
with check (
  bucket_id = 'forum-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.is_account_active()
);

drop policy if exists "Owners and staff delete forum media" on storage.objects;
create policy "Owners and staff delete forum media"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'forum-media'
  and (
    (
      (storage.foldername(name))[1] = (select auth.uid())::text
      and public.is_account_active()
    )
    or public.is_moderator_or_admin()
  )
);

commit;
