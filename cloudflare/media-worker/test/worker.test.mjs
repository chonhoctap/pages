import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const baseEnv = {
  ALLOWED_ORIGIN: 'https://chonhoctap.github.io',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'publishable-test-key',
  R2_CLEANUP_SECRET: 'cleanup-test-secret'
};

test('health endpoint reports R2 service', async () => {
  const response = await worker.fetch(
    new Request('https://media.example/health', {
      headers: { Origin: baseEnv.ALLOWED_ORIGIN }
    }),
    baseEnv
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'chonhoctap-media',
    storage: 'r2'
  });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), baseEnv.ALLOWED_ORIGIN);
});

test('authenticated active member can upload a valid image', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: '4cc57975-9f97-4c9d-8f4e-19bba306d335' });
    }
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: '4cc57975-9f97-4c9d-8f4e-19bba306d335',
        role: 'member',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };

  let stored;
  const env = {
    ...baseEnv,
    MEDIA_BUCKET: {
      async put(key, body, options) {
        stored = { key, body, options };
      }
    }
  };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const response = await worker.fetch(
    new Request('https://media.example/api/media', {
      method: 'POST',
      headers: {
        Origin: baseEnv.ALLOWED_ORIGIN,
        Authorization: 'Bearer valid-token',
        'Content-Type': 'image/jpeg',
        'X-Media-Scope': 'post',
        'X-File-Name': 'bai-tap.jpg'
      },
      body: jpeg
    }),
    env
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.match(payload.path, /^post\/4cc57975-9f97-4c9d-8f4e-19bba306d335\//);
  assert.equal(payload.provider, 'r2');
  assert.equal(stored.options.customMetadata.ownerRole, 'member');
  assert.equal(stored.options.httpMetadata.contentType, 'image/jpeg');
});

test('member original image is capped at 50 MB', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '4cc57975-9f97-4c9d-8f4e-19bba306d335' });
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: '4cc57975-9f97-4c9d-8f4e-19bba306d335',
        role: 'member',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const response = await worker.fetch(new Request('https://media.example/api/media', {
    method: 'POST',
    headers: {
      Origin: baseEnv.ALLOWED_ORIGIN,
      Authorization: 'Bearer valid-token',
      'Content-Type': 'image/jpeg',
      'Content-Length': String(50 * 1024 * 1024 + 1),
      'X-Media-Scope': 'post'
    },
    body: jpeg
  }), { ...baseEnv, MEDIA_BUCKET: { async put() {} } });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /50 MB/iu);
});

test('authenticated active member can upload a valid MP3 audio file', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: '4cc57975-9f97-4c9d-8f4e-19bba306d335' });
    }
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: '4cc57975-9f97-4c9d-8f4e-19bba306d335',
        role: 'member',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };

  let stored;
  const env = {
    ...baseEnv,
    MEDIA_BUCKET: {
      async put(key, body, options) {
        stored = { key, body, options };
      }
    }
  };
  const mp3 = new TextEncoder().encode('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000');
  const response = await worker.fetch(
    new Request('https://media.example/api/media', {
      method: 'POST',
      headers: {
        Origin: baseEnv.ALLOWED_ORIGIN,
        Authorization: 'Bearer valid-token',
        'Content-Type': 'audio/mpeg',
        'X-Media-Scope': 'post',
        'X-File-Name': 'loi-giai.mp3'
      },
      body: mp3
    }),
    env
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.type, 'audio');
  assert.match(payload.path, /\.mp3$/u);
  assert.equal(stored.options.httpMetadata.contentType, 'audio/mpeg');
});

test('upload without a Supabase session is rejected', async () => {
  const response = await worker.fetch(
    new Request('https://media.example/api/media', {
      method: 'POST',
      headers: {
        Origin: baseEnv.ALLOWED_ORIGIN,
        'Content-Type': 'image/jpeg',
        'X-Media-Scope': 'post'
      },
      body: new Uint8Array([0xff, 0xd8, 0xff])
    }),
    { ...baseEnv, MEDIA_BUCKET: {} }
  );
  assert.equal(response.status, 401);
});

test('active member can upload a valid video up to 50 MB', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '4cc57975-9f97-4c9d-8f4e-19bba306d335' });
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: '4cc57975-9f97-4c9d-8f4e-19bba306d335',
        role: 'member',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };
  const env = { ...baseEnv, MEDIA_BUCKET: { async put() {} } };
  const mp4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
  const response = await worker.fetch(new Request('https://media.example/api/media', {
    method: 'POST',
    headers: {
      Origin: baseEnv.ALLOWED_ORIGIN,
      Authorization: 'Bearer valid-token',
      'Content-Type': 'video/mp4',
      'X-Media-Scope': 'post'
    },
    body: mp4
  }), env);
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.type, 'video');
  assert.match(payload.path, /\.mp4$/u);
});

test('member video is capped at 50 MB', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '4cc57975-9f97-4c9d-8f4e-19bba306d335' });
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: '4cc57975-9f97-4c9d-8f4e-19bba306d335',
        role: 'member',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };
  const mp4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
  const response = await worker.fetch(new Request('https://media.example/api/media', {
    method: 'POST',
    headers: {
      Origin: baseEnv.ALLOWED_ORIGIN,
      Authorization: 'Bearer valid-token',
      'Content-Type': 'video/mp4',
      'Content-Length': String(50 * 1024 * 1024 + 1),
      'X-Media-Scope': 'post'
    },
    body: mp4
  }), { ...baseEnv, MEDIA_BUCKET: { async put() {} } });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /50 MB/iu);
});

test('VIP audio is capped at 50 MB', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '4cc57975-9f97-4c9d-8f4e-19bba306d335' });
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: '4cc57975-9f97-4c9d-8f4e-19bba306d335',
        role: 'vip',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };
  const oversized = new TextEncoder().encode('ID3');
  const response = await worker.fetch(new Request('https://media.example/api/media', {
    method: 'POST',
    headers: {
      Origin: baseEnv.ALLOWED_ORIGIN,
      Authorization: 'Bearer valid-token',
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(50 * 1024 * 1024 + 1),
      'X-Media-Scope': 'post'
    },
    body: oversized
  }), { ...baseEnv, MEDIA_BUCKET: { async put() {} } });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /50 MB/iu);
});

test('moderator cannot delete media owned by another member', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'moderator-id' });
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: 'moderator-id',
        role: 'moderator',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };

  let deleted = false;
  const env = {
    ...baseEnv,
    MEDIA_BUCKET: {
      async head() {
        return { customMetadata: { ownerId: 'member-id' } };
      },
      async delete() {
        deleted = true;
      }
    }
  };
  const response = await worker.fetch(new Request(
    'https://media.example/api/media/post/member-id/file.jpg',
    {
      method: 'DELETE',
      headers: {
        Origin: baseEnv.ALLOWED_ORIGIN,
        Authorization: 'Bearer valid-token'
      }
    }
  ), env);

  assert.equal(response.status, 403);
  assert.equal(deleted, false);
});

test('admin can delete media owned by another member', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'admin-id' });
    if (url.includes('/rest/v1/profiles')) {
      return Response.json([{
        id: 'admin-id',
        role: 'admin',
        account_status: 'active'
      }]);
    }
    return new Response(null, { status: 404 });
  };

  let deletedKey = '';
  const env = {
    ...baseEnv,
    MEDIA_BUCKET: {
      async head() {
        return { customMetadata: { ownerId: 'member-id' } };
      },
      async delete(key) {
        deletedKey = key;
      }
    }
  };
  const response = await worker.fetch(new Request(
    'https://media.example/api/media/post/member-id/file.jpg',
    {
      method: 'DELETE',
      headers: {
        Origin: baseEnv.ALLOWED_ORIGIN,
        Authorization: 'Bearer valid-token'
      }
    }
  ), env);

  assert.equal(response.status, 204);
  assert.equal(deletedKey, 'post/member-id/file.jpg');
});

test('cleanup endpoint rejects requests without the server secret', async () => {
  let deleted = false;
  const response = await worker.fetch(new Request(
    'https://media.example/api/cleanup',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['post/member-id/file.jpg'] })
    }
  ), {
    ...baseEnv,
    MEDIA_BUCKET: {
      async delete() {
        deleted = true;
      }
    }
  });

  assert.equal(response.status, 401);
  assert.equal(deleted, false);
});

test('cleanup endpoint deletes unique post and comment media keys', async () => {
  let deletedKeys = [];
  const response = await worker.fetch(new Request(
    'https://media.example/api/cleanup',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cleanup-Secret': baseEnv.R2_CLEANUP_SECRET
      },
      body: JSON.stringify({
        keys: [
          'post/member-id/file.jpg',
          'comment/member-id/post-id/file.mp4',
          'post/member-id/file.jpg'
        ]
      })
    }
  ), {
    ...baseEnv,
    MEDIA_BUCKET: {
      async delete(keys) {
        deletedKeys = keys;
      }
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(deletedKeys, [
    'post/member-id/file.jpg',
    'comment/member-id/post-id/file.mp4'
  ]);
  assert.deepEqual(await response.json(), { ok: true, deleted: 2 });
});

test('cleanup endpoint refuses paths outside forum R2 prefixes', async () => {
  let deleted = false;
  const response = await worker.fetch(new Request(
    'https://media.example/api/cleanup',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cleanup-Secret': baseEnv.R2_CLEANUP_SECRET
      },
      body: JSON.stringify({ keys: ['avatars/member-id/avatar.jpg'] })
    }
  ), {
    ...baseEnv,
    MEDIA_BUCKET: {
      async delete() {
        deleted = true;
      }
    }
  });

  assert.equal(response.status, 400);
  assert.equal(deleted, false);
});
