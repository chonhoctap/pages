import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const baseEnv = {
  ALLOWED_ORIGIN: 'https://chonhoctap.github.io',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'publishable-test-key'
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
