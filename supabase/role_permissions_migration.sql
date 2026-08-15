-- Chốn Học Tập: quyền động theo role cho trang Quản trị.
-- Yêu cầu: đã chạy forum_v12_migration.sql.
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

begin;

create table if not exists public.role_permissions (
  role_name text not null,
  permission_key text not null,
  allowed boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (role_name, permission_key),
  constraint role_permissions_role_values
    check (role_name in ('member', 'vip', 'moderator', 'admin')),
  constraint role_permissions_key_values
    check (permission_key in (
      'forum.access',
      'forum.create_post',
      'forum.create_comment',
      'forum.react',
      'forum.share',
      'forum.report',
      'forum.moderate_posts',
      'forum.review_reports',
      'forum.delete_any_content',
      'admin.manage_users',
      'admin.manage_role_permissions'
    ))
);

create table if not exists public.role_permission_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  role_name text not null,
  permission_key text not null,
  old_allowed boolean not null,
  new_allowed boolean not null,
  created_at timestamptz not null default now(),
  constraint role_permission_audit_role_values
    check (role_name in ('member', 'vip', 'moderator', 'admin'))
);

create index if not exists role_permission_audit_created_idx
  on public.role_permission_audit_log(created_at desc);

insert into public.role_permissions(role_name, permission_key, allowed)
select seed.role_name, seed.permission_key, seed.allowed
from (values
  ('member', 'forum.access', true),
  ('member', 'forum.create_post', true),
  ('member', 'forum.create_comment', true),
  ('member', 'forum.react', true),
  ('member', 'forum.share', true),
  ('member', 'forum.report', true),
  ('member', 'forum.moderate_posts', false),
  ('member', 'forum.review_reports', false),
  ('member', 'forum.delete_any_content', false),
  ('member', 'admin.manage_users', false),
  ('member', 'admin.manage_role_permissions', false),

  ('vip', 'forum.access', true),
  ('vip', 'forum.create_post', true),
  ('vip', 'forum.create_comment', true),
  ('vip', 'forum.react', true),
  ('vip', 'forum.share', true),
  ('vip', 'forum.report', true),
  ('vip', 'forum.moderate_posts', false),
  ('vip', 'forum.review_reports', false),
  ('vip', 'forum.delete_any_content', false),
  ('vip', 'admin.manage_users', false),
  ('vip', 'admin.manage_role_permissions', false),

  ('moderator', 'forum.access', true),
  ('moderator', 'forum.create_post', true),
  ('moderator', 'forum.create_comment', true),
  ('moderator', 'forum.react', true),
  ('moderator', 'forum.share', true),
  ('moderator', 'forum.report', true),
  ('moderator', 'forum.moderate_posts', true),
  ('moderator', 'forum.review_reports', false),
  ('moderator', 'forum.delete_any_content', false),
  ('moderator', 'admin.manage_users', false),
  ('moderator', 'admin.manage_role_permissions', false),

  ('admin', 'forum.access', true),
  ('admin', 'forum.create_post', true),
  ('admin', 'forum.create_comment', true),
  ('admin', 'forum.react', true),
  ('admin', 'forum.share', true),
  ('admin', 'forum.report', true),
  ('admin', 'forum.moderate_posts', true),
  ('admin', 'forum.review_reports', true),
  ('admin', 'forum.delete_any_content', true),
  ('admin', 'admin.manage_users', true),
  ('admin', 'admin.manage_role_permissions', true)
) as seed(role_name, permission_key, allowed)
on conflict (role_name, permission_key) do nothing;

-- Các quyền này là ranh giới an toàn cố định theo yêu cầu: Staff chỉ duyệt/ẩn,
-- còn tài khoản, báo cáo và xóa nội dung người khác chỉ dành cho admin.
update public.role_permissions
set allowed = (role_name = 'admin'),
    updated_at = now()
where permission_key in (
  'forum.review_reports',
  'forum.delete_any_content',
  'admin.manage_users',
  'admin.manage_role_permissions'
);

-- Quyền duyệt bài chỉ có thể thuộc Staff hoặc admin. Admin luôn giữ quyền này;
-- Staff có thể được bật/tắt trong trang quản trị.
update public.role_permissions
set allowed = case when role_name = 'admin' then true else false end,
    updated_at = now()
where permission_key = 'forum.moderate_posts'
  and role_name in ('member', 'vip', 'admin');

alter table public.role_permissions enable row level security;
alter table public.role_permission_audit_log enable row level security;

drop policy if exists "Admins read role permissions" on public.role_permissions;
create policy "Admins read role permissions"
on public.role_permissions
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins read role permission audit log"
  on public.role_permission_audit_log;
create policy "Admins read role permission audit log"
on public.role_permission_audit_log
for select
to authenticated
using (public.is_admin());

revoke all on table public.role_permissions from anon, authenticated;
revoke all on table public.role_permission_audit_log from anon, authenticated;
grant select on table public.role_permissions to authenticated;
grant select on table public.role_permission_audit_log to authenticated;

create or replace function public.has_role_permission(target_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when p.account_status = 'banned' then false
      when target_permission in (
        'forum.review_reports',
        'forum.delete_any_content',
        'admin.manage_users',
        'admin.manage_role_permissions'
      ) then p.role = 'admin'
      else rp.allowed
    end
    from public.profiles p
    left join public.role_permissions rp
      on rp.role_name = p.role
     and rp.permission_key = target_permission
    where p.id = (select auth.uid())
  ), false);
$$;

revoke execute on function public.has_role_permission(text) from public, anon;
grant execute on function public.has_role_permission(text) to authenticated;

create or replace function public.get_my_role_permissions()
returns table(permission_key text, allowed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select rp.permission_key,
    case
      when p.account_status = 'banned' then false
      when rp.permission_key in (
        'forum.review_reports',
        'forum.delete_any_content',
        'admin.manage_users',
        'admin.manage_role_permissions'
      ) then p.role = 'admin'
      else rp.allowed
    end as allowed
  from public.profiles p
  join public.role_permissions rp on rp.role_name = p.role
  where p.id = (select auth.uid())
  order by rp.permission_key;
$$;

revoke execute on function public.get_my_role_permissions() from public, anon;
grant execute on function public.get_my_role_permissions() to authenticated;

create or replace function public.admin_list_role_permissions()
returns table(
  role_name text,
  permission_key text,
  allowed boolean,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Chỉ quản trị viên đang hoạt động được xem cấu hình quyền';
  end if;

  return query
  select rp.role_name, rp.permission_key, rp.allowed, rp.updated_at
  from public.role_permissions rp
  order by
    case rp.role_name
      when 'member' then 1
      when 'vip' then 2
      when 'moderator' then 3
      when 'admin' then 4
    end,
    rp.permission_key;
end;
$$;

revoke execute on function public.admin_list_role_permissions() from public, anon;
grant execute on function public.admin_list_role_permissions() to authenticated;

create or replace function public.admin_update_role_permission(
  target_role_name text,
  target_permission_key text,
  target_allowed boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_allowed boolean;
begin
  if not public.is_admin() then
    raise exception 'Chỉ quản trị viên đang hoạt động được thay đổi quyền';
  end if;
  if target_role_name not in ('member', 'vip', 'moderator', 'admin') then
    raise exception 'Role không hợp lệ';
  end if;
  if target_allowed is null then
    raise exception 'Giá trị bật/tắt quyền không hợp lệ';
  end if;
  if target_permission_key not in (
    'forum.access',
    'forum.create_post',
    'forum.create_comment',
    'forum.react',
    'forum.share',
    'forum.report',
    'forum.moderate_posts',
    'forum.review_reports',
    'forum.delete_any_content',
    'admin.manage_users',
    'admin.manage_role_permissions'
  ) then
    raise exception 'Quyền không hợp lệ';
  end if;

  if target_permission_key in (
    'forum.review_reports',
    'forum.delete_any_content',
    'admin.manage_users',
    'admin.manage_role_permissions'
  ) and (target_role_name <> 'admin' or target_allowed = false) then
    raise exception 'Quyền này được khóa an toàn và chỉ admin được sử dụng';
  end if;

  if target_permission_key = 'forum.moderate_posts'
    and target_role_name in ('member', 'vip')
    and target_allowed = true then
    raise exception 'Quyền duyệt bài chỉ dành cho Staff hoặc admin';
  end if;
  if target_permission_key = 'forum.moderate_posts'
    and target_role_name = 'admin'
    and target_allowed = false then
    raise exception 'Admin luôn phải giữ quyền duyệt bài';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(8126, 20260809);

  select rp.allowed into previous_allowed
  from public.role_permissions rp
  where rp.role_name = target_role_name
    and rp.permission_key = target_permission_key
  for update;

  if not found then raise exception 'Không tìm thấy cấu hình quyền'; end if;
  if previous_allowed = target_allowed then return true; end if;

  update public.role_permissions
  set allowed = target_allowed,
      updated_by = (select auth.uid()),
      updated_at = now()
  where role_name = target_role_name
    and permission_key = target_permission_key;

  insert into public.role_permission_audit_log(
    actor_id, role_name, permission_key, old_allowed, new_allowed
  ) values (
    (select auth.uid()), target_role_name, target_permission_key,
    previous_allowed, target_allowed
  );

  if target_permission_key = 'forum.moderate_posts' and target_allowed then
    insert into public.forum_notifications(
      recipient_id, actor_id, type, post_id, comment_id, message
    )
    select
      reviewer.id,
      p.author_id,
      'moderation',
      p.id,
      null,
      'Có bài viết đang chờ bạn duyệt.'
    from public.forum_posts p
    cross join public.profiles reviewer
    where p.moderation_status = 'pending_review'
      and reviewer.role = target_role_name
      and reviewer.account_status = 'active'
      and not exists (
        select 1
        from public.forum_notifications n
        where n.recipient_id = reviewer.id
          and n.type = 'moderation'
          and n.post_id = p.id
          and n.comment_id is null
          and n.read_at is null
      );
  elsif target_permission_key = 'forum.moderate_posts' and not target_allowed then
    update public.forum_notifications n
    set read_at = coalesce(n.read_at, now())
    where n.type = 'moderation'
      and n.comment_id is null
      and n.read_at is null
      and exists (
        select 1
        from public.profiles reviewer
        where reviewer.id = n.recipient_id
          and reviewer.role = target_role_name
      );
  end if;
  return true;
end;
$$;

revoke execute on function public.admin_update_role_permission(text, text, boolean)
  from public, anon;
grant execute on function public.admin_update_role_permission(text, text, boolean)
  to authenticated;

-- Quyền truy cập và xem bài chờ duyệt được lấy từ ma trận role.
create or replace function public.can_view_forum()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_role_permission('forum.access');
$$;

revoke execute on function public.can_view_forum() from public, anon;
grant execute on function public.can_view_forum() to authenticated;

create or replace function public.can_view_forum_post(target_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.forum_posts p
    where p.id = target_post_id
      and public.can_view_forum()
      and (
        (p.moderation_status = 'published' and p.visibility = 'visible')
        or p.author_id = (select auth.uid())
        or public.has_role_permission('forum.moderate_posts')
      )
  );
$$;

revoke execute on function public.can_view_forum_post(uuid) from public, anon;
grant execute on function public.can_view_forum_post(uuid) to authenticated;

drop policy if exists "Members can view forum posts" on public.forum_posts;
create policy "Members can view forum posts"
on public.forum_posts
for select
to authenticated
using (
  public.can_view_forum()
  and (
    (moderation_status = 'published' and visibility = 'visible')
    or author_id = (select auth.uid())
    or public.has_role_permission('forum.moderate_posts')
  )
);

drop policy if exists "Active members can create forum posts" on public.forum_posts;
create policy "Active members can create forum posts"
on public.forum_posts
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.create_post')
);

drop policy if exists "Authors and staff can update forum posts" on public.forum_posts;
drop policy if exists "Authors and admins can update forum posts" on public.forum_posts;
create policy "Authors and admins can update forum posts"
on public.forum_posts
for update
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
    and public.has_role_permission('forum.create_post')
  )
  or public.is_active_forum_admin()
)
with check (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
    and public.has_role_permission('forum.create_post')
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Members can view forum comments" on public.forum_comments;
create policy "Members can view forum comments"
on public.forum_comments
for select
to authenticated
using (
  public.can_view_forum_post(post_id)
  and (
    moderation_status = 'published'
    or author_id = (select auth.uid())
    or public.has_role_permission('forum.moderate_posts')
  )
);

drop policy if exists "Active members can create forum comments" on public.forum_comments;
create policy "Active members can create forum comments"
on public.forum_comments
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.create_comment')
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Authors and staff can update forum comments" on public.forum_comments;
drop policy if exists "Authors and admins can update forum comments" on public.forum_comments;
create policy "Authors and admins can update forum comments"
on public.forum_comments
for update
to authenticated
using (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
    and public.has_role_permission('forum.create_comment')
  )
  or public.is_active_forum_admin()
)
with check (
  (
    author_id = (select auth.uid())
    and public.is_account_active()
    and public.has_role_permission('forum.create_comment')
  )
  or public.is_active_forum_admin()
);

drop policy if exists "Active members manage own reactions" on public.forum_reactions;
create policy "Active members manage own reactions"
on public.forum_reactions
for all
to authenticated
using (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.react')
  and public.can_view_forum_post(post_id)
)
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.react')
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Active members can like forum posts" on public.forum_likes;
create policy "Active members can like forum posts"
on public.forum_likes
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.react')
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Active members can remove own likes" on public.forum_likes;
create policy "Active members can remove own likes"
on public.forum_likes
for delete
to authenticated
using (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.react')
);

drop policy if exists "Active members can register forum shares" on public.forum_shares;
create policy "Active members can register forum shares"
on public.forum_shares
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.share')
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Active members can report posts" on public.forum_reports;
create policy "Active members can report posts"
on public.forum_reports
for insert
to authenticated
with check (
  reporter_id = (select auth.uid())
  and public.is_account_active()
  and public.has_role_permission('forum.report')
  and public.can_view_forum_post(post_id)
);

drop policy if exists "Members can view own reports and staff view all"
  on public.forum_reports;
drop policy if exists "Members view own reports and admins view all"
  on public.forum_reports;
create policy "Members view own reports and admins view all"
on public.forum_reports
for select
to authenticated
using (
  reporter_id = (select auth.uid())
  or public.has_role_permission('forum.review_reports')
);

-- Chủ bài vẫn tự ẩn/hiện bài của mình. Người có quyền duyệt bài được ẩn/hiện
-- bài của người khác, nhưng không được xóa.
create or replace function public.set_forum_post_visibility(
  target_post_id uuid,
  should_hide boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if not public.is_account_active() then return false; end if;

  update public.forum_posts
  set visibility = case when should_hide then 'hidden' else 'visible' end,
      hidden_at = case when should_hide then now() else null end,
      hidden_by = case when should_hide then (select auth.uid()) else null end
  where id = target_post_id
    and (
      author_id = (select auth.uid())
      or public.has_role_permission('forum.moderate_posts')
    );
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke execute on function public.set_forum_post_visibility(uuid, boolean)
  from public, anon;
grant execute on function public.set_forum_post_visibility(uuid, boolean)
  to authenticated;

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
  if not public.is_account_active()
    or not public.has_role_permission('forum.moderate_posts') then
    raise exception 'Tài khoản này không có quyền duyệt bài';
  end if;
  if review_action not in ('approve', 'reject', 'hide') then
    raise exception 'Thao tác kiểm duyệt không hợp lệ';
  end if;

  update public.forum_posts
  set moderation_status = case when review_action = 'approve' then 'published' else 'rejected' end,
      visibility = case when review_action = 'approve' then 'visible' else 'hidden' end,
      moderation_reason = nullif(btrim(coalesce(review_note, '')), ''),
      hidden_at = case when review_action = 'approve' then null else now() end,
      hidden_by = case when review_action = 'approve' then null else (select auth.uid()) end,
      reviewed_by = (select auth.uid()),
      reviewed_at = now()
  where id = target_post_id
  returning author_id into post_author;
  get diagnostics changed = row_count;

  update public.forum_notifications
  set read_at = coalesce(read_at, now())
  where type = 'moderation'
    and post_id = target_post_id
    and comment_id is null;

  if changed = 1 and post_author is distinct from (select auth.uid()) then
    insert into public.forum_notifications(
      recipient_id, actor_id, type, post_id, message
    ) values (
      post_author,
      (select auth.uid()),
      'review',
      target_post_id,
      case when review_action = 'approve'
        then 'Bài viết của bạn đã được duyệt.'
        else 'Bài viết của bạn đã bị ẩn hoặc từ chối.'
      end
    );
  end if;

  if changed = 1 and review_action = 'approve' then
    insert into public.forum_notifications(
      recipient_id, actor_id, type, post_id, message
    )
    select m.user_id, post_author, 'mention', target_post_id,
      'Bạn được nhắc đến trong một bài viết.'
    from public.forum_post_mentions m
    where m.post_id = target_post_id
      and not exists (
        select 1
        from public.forum_notifications n
        where n.recipient_id = m.user_id
          and n.post_id = target_post_id
          and n.type = 'mention'
      );
  end if;
  return changed = 1;
end;
$$;

revoke execute on function public.review_forum_post(uuid, text, text)
  from public, anon;
grant execute on function public.review_forum_post(uuid, text, text)
  to authenticated;

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
  if not public.is_account_active()
    or not public.has_role_permission('forum.review_reports') then
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

-- Khi một tài khoản đổi role/trạng thái, hộp thư duyệt bài được đồng bộ theo
-- quyền mới để không còn thông báo mà tài khoản không thể xử lý.
create or replace function public.sync_profile_moderation_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  may_moderate boolean;
begin
  select coalesce(rp.allowed, false)
  into may_moderate
  from public.role_permissions rp
  where rp.role_name = new.role
    and rp.permission_key = 'forum.moderate_posts';

  if new.account_status = 'active' and may_moderate then
    insert into public.forum_notifications(
      recipient_id, actor_id, type, post_id, comment_id, message
    )
    select
      new.id,
      p.author_id,
      'moderation',
      p.id,
      null,
      'Có bài viết đang chờ bạn duyệt.'
    from public.forum_posts p
    where p.moderation_status = 'pending_review'
      and not exists (
        select 1
        from public.forum_notifications n
        where n.recipient_id = new.id
          and n.type = 'moderation'
          and n.post_id = p.id
          and n.comment_id is null
          and n.read_at is null
      );
  else
    update public.forum_notifications n
    set read_at = coalesce(n.read_at, now())
    where n.recipient_id = new.id
      and n.type = 'moderation'
      and n.comment_id is null
      and n.read_at is null;
  end if;
  return new;
end;
$$;

revoke execute on function public.sync_profile_moderation_notifications()
  from public, anon, authenticated;

drop trigger if exists profiles_sync_moderation_notifications
  on public.profiles;
create trigger profiles_sync_moderation_notifications
after update of role, account_status on public.profiles
for each row
when (
  old.role is distinct from new.role
  or old.account_status is distinct from new.account_status
)
execute procedure public.sync_profile_moderation_notifications();

-- Media âm thanh/video trong bình luận vẫn chỉ thông báo admin. Media của bài
-- viết dùng cùng quyền duyệt bài động như hàng chờ bài viết.
create or replace function public.queue_forum_manual_media_for_admin()
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
  if new.media_type is null or new.media_type not in ('audio', 'video') then
    return new;
  end if;

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
    from public.forum_comments c
    where c.id = target_comment;
  end if;

  if target_comment is null then
    update public.forum_posts p
    set moderation_status = 'pending_review',
        moderation_reason = 'Bài viết đang chờ Staff hoặc quản trị viên duyệt.',
        reviewed_by = null,
        reviewed_at = null
    where p.id = target_post
      and p.moderation_status <> 'rejected'
    returning p.author_id into content_author;
  else
    update public.forum_comments c
    set moderation_status = 'pending_review',
        moderation_reason =
          'Bình luận có âm thanh hoặc video đang chờ quản trị viên duyệt.'
    where c.id = target_comment
      and c.moderation_status <> 'rejected'
    returning c.author_id into content_author;
  end if;

  if content_author is null then return new; end if;

  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select
    reviewer.id,
    content_author,
    'moderation',
    target_post,
    target_comment,
    case when target_comment is null
      then 'Có bài viết mới đang chờ bạn duyệt.'
      else 'Có bình luận chứa âm thanh hoặc video đang chờ bạn duyệt.'
    end
  from public.profiles reviewer
  left join public.role_permissions rp
    on rp.role_name = reviewer.role
   and rp.permission_key = 'forum.moderate_posts'
  where reviewer.account_status = 'active'
    and (
      (target_comment is null and coalesce(rp.allowed, false))
      or (target_comment is not null and reviewer.role = 'admin')
    )
    and not exists (
      select 1
      from public.forum_notifications n
      where n.recipient_id = reviewer.id
        and n.type = 'moderation'
        and n.post_id = target_post
        and n.comment_id is not distinct from target_comment
        and n.read_at is null
    );
  return new;
end;
$$;

revoke execute on function public.queue_forum_manual_media_for_admin()
  from public, anon, authenticated;

-- Chỉ role đang có quyền duyệt bài mới nhận thông báo hàng chờ bài viết.
create or replace function public.notify_admins_for_pending_forum_post_v12()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.moderation_status <> 'pending_review' then return new; end if;

  insert into public.forum_notifications(
    recipient_id, actor_id, type, post_id, comment_id, message
  )
  select
    reviewer.id,
    new.author_id,
    'moderation',
    new.id,
    null,
    case when tg_op = 'INSERT'
      then 'Có bài viết mới đang chờ bạn duyệt.'
      else 'Có bài viết vừa chỉnh sửa đang chờ bạn duyệt lại.'
    end
  from public.profiles reviewer
  join public.role_permissions rp
    on rp.role_name = reviewer.role
   and rp.permission_key = 'forum.moderate_posts'
   and rp.allowed = true
  where reviewer.account_status = 'active'
    and not exists (
      select 1
      from public.forum_notifications n
      where n.recipient_id = reviewer.id
        and n.type = 'moderation'
        and n.post_id = new.id
        and n.comment_id is null
        and n.read_at is null
    );
  return new;
end;
$$;

revoke execute on function public.notify_admins_for_pending_forum_post_v12()
  from public, anon, authenticated;

-- Đồng bộ thư đang chờ ngay sau khi bật quyền duyệt cho một role.
insert into public.forum_notifications(
  recipient_id, actor_id, type, post_id, comment_id, message
)
select
  reviewer.id,
  p.author_id,
  'moderation',
  p.id,
  null,
  'Có bài viết đang chờ bạn duyệt.'
from public.forum_posts p
cross join public.profiles reviewer
join public.role_permissions rp
  on rp.role_name = reviewer.role
 and rp.permission_key = 'forum.moderate_posts'
 and rp.allowed = true
where p.moderation_status = 'pending_review'
  and reviewer.account_status = 'active'
  and not exists (
    select 1
    from public.forum_notifications n
    where n.recipient_id = reviewer.id
      and n.type = 'moderation'
      and n.post_id = p.id
      and n.comment_id is null
      and n.read_at is null
  );

commit;
