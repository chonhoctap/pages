import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSupabaseMediaPath,
  uniqueSupabasePaths
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
