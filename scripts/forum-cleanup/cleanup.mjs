import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_POSTS = 500;
const R2_DELETE_BATCH_SIZE = 500;
const DEFAULT_R2_RETRY_DELAYS = [0, 500, 1500, 3000];

export function isSupabaseMediaPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !/^(post|comment)\//u.test(path);
}

export function uniqueSupabasePaths(rows) {
  return [...new Set(
    rows
      .map(row => row?.media_path)
      .filter(isSupabaseMediaPath)
  )];
}

export function isR2MediaPath(path) {
  return typeof path === 'string'
    && /^(post|comment)\//u.test(path)
    && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

export function uniqueR2Paths(rows) {
  return [...new Set(
    rows
      .map(row => row?.media_path)
      .filter(isR2MediaPath)
  )];
}

function chunk(items, size = 100) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function requiredEnv(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Thiếu GitHub Actions Secret: ${name}.`);
  return value;
}

export function createAdminClient(env = process.env) {
  const url = requiredEnv('SUPABASE_URL', env);
  const secretKey = requiredEnv('SUPABASE_SECRET_KEY', env);
  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    }
  });
}

export async function selectExpiredPosts(supabase, now, limit) {
  const { data, error } = await supabase
    .from('forum_posts')
    .select('id, category, media_path, expires_at')
    .not('expires_at', 'is', null)
    .lte('expires_at', now.toISOString())
    .order('expires_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Không thể đọc bài hết hạn: ${error.message}`);
  return data || [];
}

async function selectLegacyCommentMedia(supabase, postIds) {
  if (!postIds.length) return [];
  const rows = [];
  for (const ids of chunk(postIds)) {
    const { data, error } = await supabase
      .from('forum_comments')
      .select('media_path')
      .in('post_id', ids)
      .not('media_path', 'is', null);
    if (error) throw new Error(`Không thể đọc media bình luận cũ: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function selectPostMedia(supabase, postIds) {
  if (!postIds.length) return [];
  const rows = [];
  for (const ids of chunk(postIds)) {
    const { data, error } = await supabase
      .from('forum_post_media')
      .select('media_path')
      .in('post_id', ids);
    if (error) throw new Error(`Không thể đọc media bài viết: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function selectCommentMedia(supabase, postIds) {
  if (!postIds.length) return [];
  const rows = [];
  for (const ids of chunk(postIds)) {
    const { data: comments, error: commentError } = await supabase
      .from('forum_comments')
      .select('id')
      .in('post_id', ids);
    if (commentError) throw new Error(`Không thể đọc bình luận: ${commentError.message}`);
    const commentIds = (comments || []).map(comment => comment.id);
    for (const commentIdGroup of chunk(commentIds)) {
      const { data, error } = await supabase
        .from('forum_comment_media')
        .select('media_path')
        .in('comment_id', commentIdGroup);
      if (error) throw new Error(`Không thể đọc media bình luận: ${error.message}`);
      rows.push(...(data || []));
    }
  }
  return rows;
}

async function removeStoragePaths(supabase, bucket, paths) {
  for (const group of chunk(paths)) {
    const { error } = await supabase.storage.from(bucket).remove(group);
    if (error) {
      throw new Error(`Không thể xóa media trong ${bucket}: ${error.message}`);
    }
  }
}

function normalizedMediaApiUrl(value) {
  const url = value?.trim().replace(/\/+$/u, '');
  return /^https:\/\/[a-z0-9.-]+(?:\/.*)?$/iu.test(url || '') ? url : '';
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function cleanupApiError(response) {
  try {
    const payload = await response.json();
    return payload?.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function removeR2Paths({
  paths,
  mediaApiUrl,
  cleanupSecret,
  fetchImpl = globalThis.fetch,
  sleep = delay,
  retryDelays = DEFAULT_R2_RETRY_DELAYS
}) {
  if (!paths.length) return 0;
  const apiUrl = normalizedMediaApiUrl(mediaApiUrl);
  if (!apiUrl) throw new Error('Thiếu hoặc sai cấu hình MEDIA_API_URL.');
  if (!cleanupSecret?.trim()) {
    throw new Error('Thiếu GitHub Actions Secret: R2_CLEANUP_SECRET.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Môi trường không hỗ trợ gọi R2 Worker.');

  let removed = 0;
  for (const group of chunk(paths, R2_DELETE_BATCH_SIZE)) {
    let lastError;
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (retryDelays[attempt] > 0) await sleep(retryDelays[attempt]);
      try {
        const response = await fetchImpl(`${apiUrl}/api/cleanup`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Cleanup-Secret': cleanupSecret.trim()
          },
          body: JSON.stringify({ keys: group })
        });
        if (!response.ok) throw new Error(await cleanupApiError(response));
        const payload = await response.json();
        if (payload?.deleted !== group.length) {
          throw new Error('R2 Worker không xác nhận đủ số media cần xóa.');
        }
        removed += group.length;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      throw new Error(`Không thể xóa media R2: ${lastError.message}`);
    }
  }
  return removed;
}

async function deletePosts(supabase, ids) {
  for (const group of chunk(ids)) {
    const { error } = await supabase.from('forum_posts').delete().in('id', group);
    if (error) throw new Error(`Không thể xóa bài hết hạn: ${error.message}`);
  }
}

export async function cleanupForum({
  supabase,
  now = new Date(),
  dryRun = false,
  batchSize = DEFAULT_BATCH_SIZE,
  maxPosts = DEFAULT_MAX_POSTS,
  mediaApiUrl = '',
  cleanupSecret = '',
  fetchImpl = globalThis.fetch,
  sleep = delay,
  r2RetryDelays = DEFAULT_R2_RETRY_DELAYS,
  logger = console
}) {
  let deletedPosts = 0;
  let deletedPostMedia = 0;
  let deletedCommentMedia = 0;
  let deletedR2Media = 0;

  while (deletedPosts < maxPosts) {
    const remaining = Math.min(batchSize, maxPosts - deletedPosts);
    const posts = await selectExpiredPosts(supabase, now, remaining);
    if (!posts.length) break;

    const postIds = posts.map(post => post.id);
    const [
      legacyCommentRows,
      postMediaRows,
      commentMediaRows
    ] = await Promise.all([
      selectLegacyCommentMedia(supabase, postIds),
      selectPostMedia(supabase, postIds),
      selectCommentMedia(supabase, postIds)
    ]);
    const postPaths = uniqueSupabasePaths([...posts, ...postMediaRows]);
    const commentPaths = uniqueSupabasePaths([
      ...legacyCommentRows,
      ...commentMediaRows
    ]);
    const r2Paths = uniqueR2Paths([
      ...posts,
      ...legacyCommentRows,
      ...postMediaRows,
      ...commentMediaRows
    ]);

    logger.info(
      `${dryRun ? '[DRY RUN] ' : ''}Tìm thấy ${posts.length} bài, `
      + `${postPaths.length} media bài Supabase, `
      + `${commentPaths.length} media bình luận Supabase và ${r2Paths.length} media R2.`
    );

    if (dryRun) {
      return {
        dryRun: true,
        candidatePosts: posts.length,
        candidatePostMedia: postPaths.length,
        candidateCommentMedia: commentPaths.length,
        candidateR2Media: r2Paths.length
      };
    }

    // Xóa object trước để không để lại file mồ côi chiếm dung lượng.
    deletedR2Media += await removeR2Paths({
      paths: r2Paths,
      mediaApiUrl,
      cleanupSecret,
      fetchImpl,
      sleep,
      retryDelays: r2RetryDelays
    });
    await removeStoragePaths(supabase, 'forum-comment-media', commentPaths);
    await removeStoragePaths(supabase, 'forum-media', postPaths);
    await deletePosts(supabase, postIds);

    deletedPosts += posts.length;
    deletedPostMedia += postPaths.length;
    deletedCommentMedia += commentPaths.length;
  }

  return {
    dryRun: false,
    deletedPosts,
    deletedPostMedia,
    deletedCommentMedia,
    deletedR2Media,
    reachedRunLimit: deletedPosts >= maxPosts
  };
}

async function main() {
  const result = await cleanupForum({
    supabase: createAdminClient(),
    dryRun: process.env.DRY_RUN === 'true',
    mediaApiUrl: process.env.MEDIA_API_URL,
    cleanupSecret: process.env.R2_CLEANUP_SECRET
  });
  console.info(JSON.stringify(result, null, 2));
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
