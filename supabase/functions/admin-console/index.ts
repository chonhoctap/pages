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
const TARGET_PATTERN = /^[a-z0-9_]{3,24}$/iu;
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

function normalizeLookup(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function editDistance(first: string, second: string) {
  const left = normalizeLookup(first);
  const right = normalizeLookup(second);
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = previous;
    }
  }
  return row[right.length];
}

function bigramSimilarity(first: string, second: string) {
  const left = normalizeLookup(first);
  const right = normalizeLookup(second);
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const rightPairs: string[] = [];
  for (let index = 0; index < right.length - 1; index += 1) {
    rightPairs.push(right.slice(index, index + 2));
  }
  let matches = 0;
  for (let index = 0; index < left.length - 1; index += 1) {
    const pairIndex = rightPairs.indexOf(left.slice(index, index + 2));
    if (pairIndex >= 0) {
      matches += 1;
      rightPairs.splice(pairIndex, 1);
    }
  }
  return (2 * matches) / (left.length + right.length - 2);
}

function isR2Path(path: string) {
  return /^(post|comment)\//u.test(path)
    && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

function parseCommand(commandText: string): ParsedCommand {
  const command = commandText.trim().replace(/^\/+\s*/u, '').replace(/\s+/gu, ' ');
  if (!command || command.length > 500) throw new AppError('Lệnh trống hoặc quá dài.');
  const parts = command.split(' ');
  const [first = '', second = '', third = '', fourth = ''] = parts;
  const one = first.toLowerCase();
  const two = second.toLowerCase();

  if (one === 'help' && parts.length === 1) {
    return { action: 'help', destructive: false };
  }
  if (((one === 'user' && two === 'info') || (one === 'info' && two === 'user')) && third && parts.length === 3) {
    return { action: 'user.info', target: third, destructive: false };
  }
  if (((one === 'cooldown' && two === 'clear') || (one === 'clear' && two === 'cooldown')) && third && parts.length === 3) {
    return { action: 'cooldown.clear', target: third, destructive: false };
  }
  if (((one === 'post-cooldown' && two === 'clear') || (one === 'clear' && two === 'post-cooldown')) && third && parts.length === 3) {
    return { action: 'post_cooldown.clear', target: third, destructive: false };
  }
  if (((one === 'comment-cooldown' && two === 'clear') || (one === 'clear' && two === 'comment-cooldown')) && third && parts.length === 3) {
    return { action: 'comment_cooldown.clear', target: third, destructive: false };
  }
  if (((one === 'role' && two === 'set') || (one === 'set' && two === 'role')) && third && fourth && parts.length === 4) {
    return { action: 'role.set', target: third, value: fourth.toLowerCase(), destructive: true };
  }
  if (((one === 'status' && two === 'set') || (one === 'set' && two === 'status')) && third && fourth && parts.length === 4) {
    return { action: 'status.set', target: third, value: fourth.toLowerCase(), destructive: true };
  }
  if (((one === 'posts' && two === 'delete-all') || (one === 'delete-all' && two === 'posts')) && third && parts.length === 3) {
    return { action: 'posts.delete_all', target: third, destructive: true };
  }
  if (((one === 'comments' && two === 'delete-all') || (one === 'delete-all' && two === 'comments')) && third && parts.length === 3) {
    return { action: 'comments.delete_all', target: third, destructive: true };
  }
  if (((one === 'content' && two === 'delete-all') || (one === 'delete-all' && two === 'content')) && third && parts.length === 3) {
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
  if (!data) {
    const { data: candidates } = await service
      .from('profiles')
      .select('id, username, display_name, role, account_status')
      .limit(1000);
    const ranked = (candidates || [])
      .map(candidate => {
        const username = String(candidate.username || '');
        const displayName = String(candidate.display_name || '');
        return {
          candidate: candidate as Profile,
          distance: Math.min(editDistance(clean, username), editDistance(clean, displayName)),
          similarity: Math.max(bigramSimilarity(clean, username), bigramSimilarity(clean, displayName))
        };
      })
      .filter(item =>
        item.distance <= Math.max(2, Math.ceil(clean.length * 0.4))
        || item.similarity >= 0.45
      )
      .sort((left, right) => right.similarity - left.similarity || left.distance - right.distance)
      .slice(0, 3)
      .map(item => `@${item.candidate.username}`);
    const hint = ranked.length ? ` Có phải bạn muốn dùng ${ranked.join(', ')}?` : '';
    throw new AppError(`Không tìm thấy tài khoản ${identifier}.${hint}`, 404);
  }
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
  const postAvailableAt = postCooldown?.last_post_at
    ? new Date(new Date(postCooldown.last_post_at).getTime() + 15 * 60 * 1000)
    : null;
  const commentAvailableAt = commentCooldown?.last_commented_at
    ? new Date(new Date(commentCooldown.last_commented_at).getTime() + 2 * 60 * 1000)
    : null;
  return {
    cooldownFormat: 'available_at',
    user: target,
    counts: { posts: postCount || 0, comments: commentCount || 0 },
    cooldowns: {
      post: postAvailableAt && postAvailableAt.getTime() > Date.now()
        ? postAvailableAt.toISOString()
        : null,
      comment: commentAvailableAt && commentAvailableAt.getTime() > Date.now()
        ? commentAvailableAt.toISOString()
        : null
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
  const checks = await Promise.all([
    post
      ? service.from('forum_post_cooldowns').select('author_id', { head: true, count: 'exact' }).eq('author_id', targetId)
      : Promise.resolve({ count: 0, error: null }),
    comment
      ? service.from('forum_comment_rate_limits').select('user_id', { head: true, count: 'exact' }).eq('user_id', targetId)
      : Promise.resolve({ count: 0, error: null })
  ]);
  if (checks[0].error || checks[1].error) {
    throw new AppError(checks[0].error?.message || checks[1].error?.message || 'Không thể xác minh thời gian chờ.', 500);
  }
  if ((post && checks[0].count) || (comment && checks[1].count)) {
    throw new AppError('Đã gửi lệnh nhưng mốc thời gian chờ vẫn còn trong database.', 500);
  }
  return {
    cleared: result,
    verified: true,
    message: [
      post ? (result.post ? 'Đã xóa thời gian chờ đăng bài.' : 'Tài khoản vốn không còn thời gian chờ đăng bài.') : '',
      comment ? (result.comment ? 'Đã xóa thời gian chờ bình luận.' : 'Tài khoản vốn không còn thời gian chờ bình luận.') : ''
    ].filter(Boolean).join(' ')
  };
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
  const confirmed = Array.isArray(data) ? data[0] : data;
  if (confirmed?.role !== nextRole || confirmed?.account_status !== nextStatus) {
    throw new AppError('Database trả về trạng thái không khớp với yêu cầu.', 500);
  }
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

  const verification = await Promise.all([
    includePosts
      ? service.from('forum_posts').select('id', { head: true, count: 'exact' }).eq('author_id', targetId)
      : Promise.resolve({ count: 0, error: null }),
    includeOwnComments
      ? service.from('forum_comments').select('id', { head: true, count: 'exact' }).eq('author_id', targetId)
      : Promise.resolve({ count: 0, error: null })
  ]);
  if (verification[0].error || verification[1].error) {
    throw new AppError(verification[0].error?.message || verification[1].error?.message || 'Không thể xác minh thao tác xóa.', 500);
  }
  if ((includePosts && verification[0].count) || (includeOwnComments && verification[1].count)) {
    throw new AppError('Database vẫn còn nội dung của tài khoản sau khi chạy lệnh.', 500);
  }

  return {
    deleted: { posts: deletedPosts, comments: deletedComments },
    cascadedComments: includePosts ? Math.max(0, media.commentIds.length - deletedComments) : 0,
    media: {
      r2: r2Files,
      supabase: postStorageFiles + commentStorageFiles
    },
    verified: true
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
