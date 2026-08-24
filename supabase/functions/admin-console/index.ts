import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type CommandAction =
  | 'help'
  | 'user.info'
  | 'cooldown.clear'
  | 'post_cooldown.clear'
  | 'comment_cooldown.clear'
  | 'role.set'
  | 'status.set'
  | 'posts.delete_all'
  | 'comments.delete_all'
  | 'content.delete_all';

type ParsedCommand = {
  action: CommandAction;
  target?: string;
  value?: string;
  destructive: boolean;
};

type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  account_status: string;
};

type MediaCollection = {
  postIds: string[];
  commentIds: string[];
  r2Paths: string[];
  postStoragePaths: string[];
  commentStoragePaths: string[];
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || SERVICE_ROLE_KEY;
const MEDIA_API_URL = (Deno.env.get('MEDIA_API_URL') || '').replace(/\/+$/u, '');
const R2_CLEANUP_SECRET = Deno.env.get('R2_CLEANUP_SECRET') || '';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TARGET_PATTERN = /^[a-z0-9_.-]{1,80}$/iu;
const BATCH_SIZE = 100;
const PAGE_SIZE = 1000;

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('Origin') || '';
  const configured = (Deno.env.get('ALLOWED_ORIGINS') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const allowed = new Set([
    'https://chonhoctap.github.io',
    'https://chonhoctap.vn',
    'https://www.chonhoctap.vn',
    ...configured
  ]);
  return {
    'Access-Control-Allow-Origin': allowed.has(origin) ? origin : 'https://chonhoctap.github.io',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  };
}

function json(request: Request, data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders(request) });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 2000);
  if (typeof error === 'string') return error.slice(0, 2000);
  try { return JSON.stringify(error).slice(0, 2000); } catch { return 'Lỗi không xác định.'; }
}

function chunks<T>(items: T[], size = BATCH_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function unique(items: Array<string | null | undefined>) {
  return [...new Set(items.filter((item): item is string => Boolean(item)) )];
}

function isR2Path(path: string) {
  return /^(post|comment)\//u.test(path)
    && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

function parseCommand(commandText: string): ParsedCommand {
  const command = commandText.trim().replace(/\s+/gu, ' ');
  if (!command || command.length > 500) throw new AppError('Lệnh trống hoặc quá dài.');
  const parts = command.split(' ');
  const [first = '', second = '', third = '', fourth = ''] = parts;

  if (first.toLowerCase() === 'help' && parts.length === 1) {
    return { action: 'help', destructive: false };
  }
  if (first.toLowerCase() === 'user' && second.toLowerCase() === 'info' && third && parts.length === 3) {
    return { action: 'user.info', target: third, destructive: false };
  }
  if (first.toLowerCase() === 'cooldown' && second.toLowerCase() === 'clear' && third && parts.length === 3) {
    return { action: 'cooldown.clear', target: third, destructive: false };
  }
  if (first.toLowerCase() === 'post-cooldown' && second.toLowerCase() === 'clear' && third && parts.length === 3) {
    return { action: 'post_cooldown.clear', target: third, destructive: false };
  }
  if (first.toLowerCase() === 'comment-cooldown' && second.toLowerCase() === 'clear' && third && parts.length === 3) {
    return { action: 'comment_cooldown.clear', target: third, destructive: false };
  }
  if (first.toLowerCase() === 'role' && second.toLowerCase() === 'set' && third && fourth && parts.length === 4) {
    return { action: 'role.set', target: third, value: fourth.toLowerCase(), destructive: true };
  }
  if (first.toLowerCase() === 'status' && second.toLowerCase() === 'set' && third && fourth && parts.length === 4) {
    return { action: 'status.set', target: third, value: fourth.toLowerCase(), destructive: true };
  }
  if (first.toLowerCase() === 'posts' && second.toLowerCase() === 'delete-all' && third && parts.length === 3) {
    return { action: 'posts.delete_all', target: third, destructive: true };
  }
  if (first.toLowerCase() === 'comments' && second.toLowerCase() === 'delete-all' && third && parts.length === 3) {
    return { action: 'comments.delete_all', target: third, destructive: true };
  }
  if (first.toLowerCase() === 'content' && second.toLowerCase() === 'delete-all' && third && parts.length === 3) {
    return { action: 'content.delete_all', target: third, destructive: true };
  }
  throw new AppError('Cú pháp không hợp lệ. Gõ help để xem danh sách lệnh.');
}

function commandHelp() {
  return {
    commands: [
      { syntax: 'help', description: 'Xem danh sách lệnh được phép.' },
      { syntax: 'user info @username', description: 'Xem role, trạng thái, số bài/bình luận và thời gian chờ.' },
      { syntax: 'cooldown clear @username', description: 'Xóa cả thời gian chờ đăng bài và bình luận.' },
      { syntax: 'post-cooldown clear @username', description: 'Chỉ xóa thời gian chờ đăng bài.' },
      { syntax: 'comment-cooldown clear @username', description: 'Chỉ xóa thời gian chờ bình luận.' },
      { syntax: 'role set @username member|vip|moderator|admin', description: 'Đặt role tài khoản.' },
      { syntax: 'status set @username active|suspended|banned', description: 'Đặt trạng thái tài khoản.' },
      { syntax: 'posts delete-all @username', description: 'Xóa mọi bài viết và media thuộc các bài đó.' },
      { syntax: 'comments delete-all @username', description: 'Xóa mọi bình luận và media của tài khoản.' },
      { syntax: 'content delete-all @username', description: 'Xóa toàn bộ bài viết, bình luận và media của tài khoản.' }
    ]
  };
}

async function resolveTarget(identifier = ''): Promise<Profile> {
  const clean = identifier.trim().replace(/^@/u, '');
  if (!UUID_PATTERN.test(clean) && !TARGET_PATTERN.test(clean)) {
    throw new AppError('Tài khoản phải là @username hoặc UUID hợp lệ.');
  }
  let query = service
    .from('profiles')
    .select('id, username, display_name, role, account_status');
  query = UUID_PATTERN.test(clean)
    ? query.eq('id', clean)
    : query.eq('username', clean.toLowerCase());
  const { data, error } = await query.maybeSingle();
  if (error) throw new AppError(`Không thể tìm tài khoản: ${error.message}`, 500);
  if (!data) throw new AppError(`Không tìm thấy tài khoản ${identifier}.`, 404);
  return data as Profile;
}

async function startAudit(actorId: string, commandText: string, parsed: ParsedCommand) {
  const { data, error } = await service
    .from('admin_console_logs')
    .insert({
      actor_id: actorId,
      command_text: commandText.trim(),
      action: parsed.action,
      parameters: { target: parsed.target || null, value: parsed.value || null },
      status: 'running'
    })
    .select('id')
    .single();
  if (error || !data?.id) {
    throw new AppError('Chưa thể ghi nhật ký quản trị. Hãy chạy admin_console_migration.sql.', 503);
  }
  return data.id as string;
}

async function attachAuditTarget(auditId: string, targetId: string) {
  const { error } = await service
    .from('admin_console_logs')
    .update({ target_user_id: targetId })
    .eq('id', auditId);
  if (error) throw new AppError(`Không thể cập nhật nhật ký: ${error.message}`, 500);
}

async function finishAudit(auditId: string, status: 'succeeded' | 'failed', result?: unknown, error?: string) {
  const { error: updateError } = await service
    .from('admin_console_logs')
    .update({
      status,
      result: result ?? null,
      error_message: error || null,
      finished_at: new Date().toISOString()
    })
    .eq('id', auditId);
  if (updateError) console.error('Admin console audit update failed', updateError);
}

async function userInfo(target: Profile) {
  const [{ count: postCount, error: postError }, { count: commentCount, error: commentError }] = await Promise.all([
    service.from('forum_posts').select('id', { head: true, count: 'exact' }).eq('author_id', target.id),
    service.from('forum_comments').select('id', { head: true, count: 'exact' }).eq('author_id', target.id)
  ]);
  if (postError || commentError) throw new AppError(postError?.message || commentError?.message || 'Không thể thống kê nội dung.', 500);

  const [{ data: postCooldown, error: postCooldownError }, { data: commentCooldown, error: commentCooldownError }] = await Promise.all([
    service.from('forum_post_cooldowns').select('last_post_at').eq('author_id', target.id).maybeSingle(),
    service.from('forum_comment_rate_limits').select('last_commented_at').eq('user_id', target.id).maybeSingle()
  ]);
  if (postCooldownError || commentCooldownError) {
    throw new AppError(postCooldownError?.message || commentCooldownError?.message || 'Không thể đọc thời gian chờ.', 500);
  }
  return {
    user: target,
    counts: { posts: postCount || 0, comments: commentCount || 0 },
    cooldowns: {
      post: postCooldown?.last_post_at || null,
      comment: commentCooldown?.last_commented_at || null
    }
  };
}

async function clearCooldown(targetId: string, post: boolean, comment: boolean) {
  const result = { post: 0, comment: 0 };
  if (post) {
    const { count, error } = await service
      .from('forum_post_cooldowns')
      .delete({ count: 'exact' })
      .eq('author_id', targetId);
    if (error) throw new AppError(`Không thể xóa thời gian chờ đăng bài: ${error.message}`, 500);
    result.post = count || 0;
  }
  if (comment) {
    const { count, error } = await service
      .from('forum_comment_rate_limits')
      .delete({ count: 'exact' })
      .eq('user_id', targetId);
    if (error) throw new AppError(`Không thể xóa thời gian chờ bình luận: ${error.message}`, 500);
    result.comment = count || 0;
  }
  return { cleared: result };
}

async function updateAccess(
  authorization: string,
  actorId: string,
  target: Profile,
  nextRole: string,
  nextStatus: string
) {
  if (!['member', 'vip', 'moderator', 'admin'].includes(nextRole)) {
    throw new AppError('Role chỉ nhận member, vip, moderator hoặc admin.');
  }
  if (!['active', 'suspended', 'banned'].includes(nextStatus)) {
    throw new AppError('Trạng thái chỉ nhận active, suspended hoặc banned.');
  }
  if (target.id === actorId && (nextRole !== 'admin' || nextStatus !== 'active')) {
    throw new AppError('Bạn không thể tự hạ quyền hoặc khóa tài khoản quản trị của chính mình.', 409);
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } }
  });
  const { data, error } = await userClient.rpc('admin_update_user_access', {
    target_user_id: target.id,
    target_role: nextRole,
    target_status: nextStatus
  });
  if (error) throw new AppError(error.message, 409);
  if (!data) throw new AppError('Database không xác nhận thay đổi tài khoản.', 500);
  return {
    before: { role: target.role, status: target.account_status },
    after: { role: nextRole, status: nextStatus }
  };
}

async function collectRows(table: string, select: string, column: string, values: string[]) {
  const rows: Record<string, unknown>[] = [];
  for (const group of chunks(values)) {
    let offset = 0;
    while (true) {
      const { data, error } = await service
        .from(table)
        .select(select)
        .in(column, group)
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new AppError(`Không thể đọc ${table}: ${error.message}`, 500);
      const page = data || [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }
  return rows;
}

async function collectAuthorRows(table: string, select: string, authorId: string) {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await service
      .from(table)
      .select(select)
      .eq('author_id', authorId)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new AppError(`Không thể đọc ${table}: ${error.message}`, 500);
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function collectContentMedia(targetId: string, includePosts: boolean, includeOwnComments: boolean): Promise<MediaCollection> {
  const posts: Record<string, unknown>[] = [];
  if (includePosts) {
    posts.push(...await collectAuthorRows('forum_posts', 'id, media_path', targetId));
  }
  const postIds = unique(posts.map(row => row.id as string));
  const comments = new Map<string, Record<string, unknown>>();

  if (postIds.length) {
    const nested = await collectRows('forum_comments', 'id, post_id, media_path', 'post_id', postIds);
    nested.forEach(row => comments.set(row.id as string, row));
  }
  if (includeOwnComments) {
    const ownComments = await collectAuthorRows(
      'forum_comments',
      'id, post_id, media_path',
      targetId
    );
    ownComments.forEach(row => comments.set(row.id as string, row));
  }
  const commentRows = [...comments.values()];
  const commentIds = [...comments.keys()];
  const postMedia = postIds.length
    ? await collectRows('forum_post_media', 'media_path', 'post_id', postIds)
    : [];
  const commentMedia = commentIds.length
    ? await collectRows('forum_comment_media', 'media_path', 'comment_id', commentIds)
    : [];

  const postPaths = unique([
    ...posts.map(row => row.media_path as string | null),
    ...postMedia.map(row => row.media_path as string | null)
  ]);
  const commentPaths = unique([
    ...commentRows.map(row => row.media_path as string | null),
    ...commentMedia.map(row => row.media_path as string | null)
  ]);
  return {
    postIds,
    commentIds,
    r2Paths: unique([...postPaths, ...commentPaths].filter(isR2Path)),
    postStoragePaths: postPaths.filter(path => !isR2Path(path)),
    commentStoragePaths: commentPaths.filter(path => !isR2Path(path))
  };
}

async function removeR2Paths(paths: string[]) {
  if (!paths.length) return 0;
  if (!MEDIA_API_URL || !R2_CLEANUP_SECRET) {
    throw new AppError('Thiếu MEDIA_API_URL hoặc R2_CLEANUP_SECRET; chưa xóa dữ liệu để tránh sót file R2.', 503);
  }
  let removed = 0;
  for (const group of chunks(paths, 500)) {
    const response = await fetch(`${MEDIA_API_URL}/api/cleanup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cleanup-Secret': R2_CLEANUP_SECRET
      },
      body: JSON.stringify({ keys: group })
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new AppError(`R2 cleanup thất bại: ${String(payload.error || `HTTP ${response.status}`)}`, 502);
    if (Number(payload.deleted) !== group.length) {
      throw new AppError('R2 không xác nhận xóa đủ số file; database chưa bị xóa.', 502);
    }
    removed += group.length;
  }
  return removed;
}

async function removeStoragePaths(bucket: string, paths: string[]) {
  let removed = 0;
  for (const group of chunks(paths)) {
    const { error } = await service.storage.from(bucket).remove(group);
    if (error) throw new AppError(`Không thể xóa media trong ${bucket}: ${error.message}`, 502);
    removed += group.length;
  }
  return removed;
}

async function deleteIds(table: string, ids: string[]) {
  let deleted = 0;
  for (const group of chunks(ids)) {
    const { count, error } = await service.from(table).delete({ count: 'exact' }).in('id', group);
    if (error) throw new AppError(`Không thể xóa ${table}: ${error.message}`, 500);
    deleted += count || 0;
  }
  return deleted;
}

async function deleteContent(targetId: string, action: CommandAction) {
  const includePosts = action === 'posts.delete_all' || action === 'content.delete_all';
  const includeOwnComments = action === 'comments.delete_all' || action === 'content.delete_all';
  const media = await collectContentMedia(targetId, includePosts, includeOwnComments);

  const [r2Files, postStorageFiles, commentStorageFiles] = await Promise.all([
    removeR2Paths(media.r2Paths),
    removeStoragePaths('forum-media', media.postStoragePaths),
    removeStoragePaths('forum-comment-media', media.commentStoragePaths)
  ]);

  let deletedComments = 0;
  let deletedPosts = 0;
  if (includeOwnComments) deletedComments = await deleteIds('forum_comments', media.commentIds);
  if (includePosts) deletedPosts = await deleteIds('forum_posts', media.postIds);

  return {
    deleted: { posts: deletedPosts, comments: deletedComments },
    media: {
      r2: r2Files,
      supabase: postStorageFiles + commentStorageFiles
    }
  };
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== 'POST') return json(request, { error: 'Chỉ hỗ trợ POST.' }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json(request, { error: 'Edge Function chưa được cấu hình Supabase.' }, 503);
  }

  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/iu, '');
  if (!token) return json(request, { error: 'Bạn chưa đăng nhập.' }, 401);
  const { data: authData, error: authError } = await service.auth.getUser(token);
  const user = authData?.user;
  if (authError || !user) return json(request, { error: 'Phiên đăng nhập không hợp lệ.' }, 401);

  const { data: actor, error: actorError } = await service
    .from('profiles')
    .select('id, role, account_status')
    .eq('id', user.id)
    .maybeSingle();
  if (actorError) return json(request, { error: 'Không thể xác minh quyền quản trị.' }, 500);
  if (actor?.role !== 'admin' || actor?.account_status !== 'active') {
    return json(request, { error: 'Bảng lệnh chỉ dành cho quản trị viên đang hoạt động.' }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json(request, { error: 'Dữ liệu JSON không hợp lệ.' }, 400); }
  const commandText = String(body.command || '').trim();
  let parsed: ParsedCommand;
  try { parsed = parseCommand(commandText); } catch (error) {
    return json(request, { error: errorMessage(error) }, error instanceof AppError ? error.status : 400);
  }
  if (parsed.destructive && body.confirm !== true) {
    return json(request, { error: 'Lệnh nhạy cảm cần xác nhận trên giao diện quản trị.', confirmationRequired: true }, 409);
  }

  let auditId = '';
  try {
    auditId = await startAudit(user.id, commandText, parsed);
    let target: Profile | null = null;
    if (parsed.target) {
      target = await resolveTarget(parsed.target);
      await attachAuditTarget(auditId, target.id);
    }

    let result: unknown;
    switch (parsed.action) {
      case 'help':
        result = commandHelp();
        break;
      case 'user.info':
        result = await userInfo(target as Profile);
        break;
      case 'cooldown.clear':
        result = await clearCooldown((target as Profile).id, true, true);
        break;
      case 'post_cooldown.clear':
        result = await clearCooldown((target as Profile).id, true, false);
        break;
      case 'comment_cooldown.clear':
        result = await clearCooldown((target as Profile).id, false, true);
        break;
      case 'role.set':
        result = await updateAccess(authorization, user.id, target as Profile, parsed.value || '', (target as Profile).account_status);
        break;
      case 'status.set':
        result = await updateAccess(authorization, user.id, target as Profile, (target as Profile).role, parsed.value || '');
        break;
      case 'posts.delete_all':
      case 'comments.delete_all':
      case 'content.delete_all':
        result = await deleteContent((target as Profile).id, parsed.action);
        break;
      default:
        throw new AppError('Lệnh chưa được hỗ trợ.');
    }

    await finishAudit(auditId, 'succeeded', result);
    return json(request, {
      ok: true,
      action: parsed.action,
      target: target ? { id: target.id, username: target.username } : null,
      result,
      auditId
    });
  } catch (error) {
    const message = errorMessage(error);
    if (auditId) await finishAudit(auditId, 'failed', null, message);
    const status = error instanceof AppError ? error.status : 500;
    console.error('Admin console command failed', { action: parsed.action, message });
    return json(request, { error: message, auditId: auditId || null }, status);
  }
});
