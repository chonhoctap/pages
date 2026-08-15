import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSupabaseMediaPath,
  uniqueSupabasePaths,
  isR2MediaPath,
  uniqueR2Paths,
  removeR2Paths
} from './cleanup.mjs';

test('Supabase media paths exclude future R2 object keys', () => {
  assert.equal(
    isSupabaseMediaPath('user-id/1750000000000-homework.webp'),
    true
  );
  assert.equal(isSupabaseMediaPath('post/user-id/file.webp'), false);
  assert.equal(isSupabaseMediaPath('comment/user-id/post-id/file.mp4'), false);
  assert.equal(isSupabaseMediaPath(''), false);
});

test('media paths are de-duplicated and empty paths are ignored', () => {
  assert.deepEqual(
    uniqueSupabasePaths([
      { media_path: 'user/file.webp' },
      { media_path: 'user/file.webp' },
      { media_path: null },
      { media_path: 'post/user/r2.webp' }
    ]),
    ['user/file.webp']
  );
});

test('R2 media paths only accept post and comment object keys', () => {
  assert.equal(isR2MediaPath('post/user-id/file.webp'), true);
  assert.equal(isR2MediaPath('comment/user-id/post-id/file.mp4'), true);
  assert.equal(isR2MediaPath('avatars/user-id/file.webp'), false);
  assert.equal(isR2MediaPath('post/../file.webp'), false);
  assert.deepEqual(uniqueR2Paths([
    { media_path: 'post/user-id/file.webp' },
    { media_path: 'post/user-id/file.webp' },
    { media_path: 'comment/user-id/post-id/file.mp4' },
    { media_path: 'user-id/legacy.webp' }
  ]), [
    'post/user-id/file.webp',
    'comment/user-id/post-id/file.mp4'
  ]);
});

test('R2 cleanup authenticates, retries and confirms every deleted key', async () => {
  const calls = [];
  let attempt = 0;
  const removed = await removeR2Paths({
    paths: ['post/user-id/file.webp', 'comment/user-id/post-id/file.mp4'],
    mediaApiUrl: 'https://media.example/',
    cleanupSecret: 'cleanup-secret',
    retryDelays: [0, 1],
    sleep: async milliseconds => calls.push({ sleep: milliseconds }),
    fetchImpl: async (url, options) => {
      attempt += 1;
      calls.push({ url, options });
      if (attempt === 1) return Response.json({ error: 'Tạm lỗi' }, { status: 503 });
      return Response.json({ ok: true, deleted: 2 });
    }
  });

  assert.equal(removed, 2);
  assert.equal(attempt, 2);
  assert.equal(calls[1].sleep, 1);
  assert.equal(calls[2].url, 'https://media.example/api/cleanup');
  assert.equal(calls[2].options.headers['X-Cleanup-Secret'], 'cleanup-secret');
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    keys: ['post/user-id/file.webp', 'comment/user-id/post-id/file.mp4']
  });
});

test('R2 cleanup stops database cleanup when the Worker never confirms deletion', async () => {
  await assert.rejects(
    removeR2Paths({
      paths: ['post/user-id/file.webp'],
      mediaApiUrl: 'https://media.example',
      cleanupSecret: 'cleanup-secret',
      retryDelays: [0, 0],
      sleep: async () => {},
      fetchImpl: async () => Response.json({ error: 'Không xóa được' }, { status: 500 })
    }),
    /Không thể xóa media R2/iu
  );
});
