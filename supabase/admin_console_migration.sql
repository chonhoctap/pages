-- Chốn Học Tập: nhật ký bảng lệnh quản trị.
-- Chạy một lần trong Supabase Dashboard > SQL Editor trước khi deploy
-- Edge Function supabase/functions/admin-console/index.ts.

begin;

create table if not exists public.admin_console_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  target_user_id uuid references public.profiles(id) on delete set null,
  command_text text not null,
  action text not null,
  status text not null default 'running',
  parameters jsonb not null default '{}'::jsonb,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint admin_console_logs_command_length
    check (char_length(command_text) between 1 and 500),
  constraint admin_console_logs_action_length
    check (char_length(action) between 1 and 80),
  constraint admin_console_logs_status_values
    check (status in ('running', 'succeeded', 'failed')),
  constraint admin_console_logs_error_length
    check (error_message is null or char_length(error_message) <= 2000)
);

create index if not exists admin_console_logs_created_idx
  on public.admin_console_logs(created_at desc);
create index if not exists admin_console_logs_actor_idx
  on public.admin_console_logs(actor_id, created_at desc);
create index if not exists admin_console_logs_target_idx
  on public.admin_console_logs(target_user_id, created_at desc)
  where target_user_id is not null;

alter table public.admin_console_logs enable row level security;

drop policy if exists "Admins read admin console logs"
  on public.admin_console_logs;
create policy "Admins read admin console logs"
on public.admin_console_logs
for select
to authenticated
using (public.is_admin());

-- Nhật ký chỉ được ghi bởi Edge Function dùng service role. Trình duyệt chỉ
-- được đọc khi database xác nhận tài khoản đang là admin hoạt động.
revoke all on table public.admin_console_logs from public, anon, authenticated;
grant select on table public.admin_console_logs to authenticated;

commit;
