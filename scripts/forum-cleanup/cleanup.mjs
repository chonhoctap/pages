import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_POSTS = 500;

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
  logger = console
}) {
  let deletedPosts = 0;
  let deletedPostMedia = 0;
  let deletedCommentMedia = 0;

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

    logger.info(
      `${dryRun ? '[DRY RUN] ' : ''}Tìm thấy ${posts.length} bài, `
      + `${postPaths.length} media bài và ${commentPaths.length} media bình luận.`
    );

    if (dryRun) {
      return {
        dryRun: true,
        candidatePosts: posts.length,
        candidatePostMedia: postPaths.length,
        candidateCommentMedia: commentPaths.length
      };
    }

    // Xóa object trước để không để lại file mồ côi chiếm dung lượng.
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
    reachedRunLimit: deletedPosts >= maxPosts
  };
}

async function main() {
  const result = await cleanupForum({
    supabase: createAdminClient(),
    dryRun: process.env.DRY_RUN === 'true'
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
