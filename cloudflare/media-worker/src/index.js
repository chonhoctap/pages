const IMAGE_LIMIT = 2 * 1024 * 1024;
const VIDEO_LIMIT = 25 * 1024 * 1024;

const MEDIA_TYPES = new Map([
  ['image/jpeg', { kind: 'image', extension: 'jpg' }],
  ['image/png', { kind: 'image', extension: 'png' }],
  ['image/webp', { kind: 'image', extension: 'webp' }],
  ['image/gif', { kind: 'image', extension: 'gif' }],
  ['video/mp4', { kind: 'video', extension: 'mp4' }],
  ['video/webm', { kind: 'video', extension: 'webm' }],
  ['video/quicktime', { kind: 'video', extension: 'mov' }]
]);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = origin === env.ALLOWED_ORIGIN
    || origin === 'http://localhost:8000'
    || origin === 'http://127.0.0.1:8000';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, X-Media-Scope, X-Post-Id, X-File-Name',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
    Vary: 'Origin'
  };
}

function json(request, env, data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function errorResponse(request, env, message, status = 400) {
  return json(request, env, { error: message }, status);
}

function bearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

async function authenticate(request, env) {
  const token = bearerToken(request);
  if (!token) throw new Response('Bạn cần đăng nhập.', { status: 401 });

  const commonHeaders = {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`
  };
  const userResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: commonHeaders
  });
  if (!userResponse.ok) {
    throw new Response('Phiên đăng nhập đã hết hạn.', { status: 401 });
  }
  const user = await userResponse.json();

  const profileUrl = new URL(`${env.SUPABASE_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set('id', `eq.${user.id}`);
  profileUrl.searchParams.set('select', 'id,role,account_status');
  const profileResponse = await fetch(profileUrl, {
    headers: {
      ...commonHeaders,
      Accept: 'application/json'
    }
  });
  if (!profileResponse.ok) {
    throw new Response('Không thể kiểm tra quyền tài khoản.', { status: 403 });
  }
  const [profile] = await profileResponse.json();
  if (!profile || profile.account_status !== 'active') {
    throw new Response('Tài khoản hiện không được phép tải tệp.', { status: 403 });
  }
  return { user, profile };
}

function ascii(buffer, start, length) {
  return String.fromCharCode(...buffer.slice(start, start + length));
}

function signatureMatches(bytes, contentType) {
  if (contentType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG';
  }
  if (contentType === 'image/webp') {
    return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
  }
  if (contentType === 'image/gif') {
    return ascii(bytes, 0, 4) === 'GIF8';
  }
  if (contentType === 'video/webm') {
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  if (contentType === 'video/mp4' || contentType === 'video/quicktime') {
    return ascii(bytes, 4, 4) === 'ftyp';
  }
  return false;
}

function cleanPostId(value) {
  if (!value) return '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)
    ? value
    : '';
}

function encodedKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function mediaKey(scope, ownerId, postId, extension) {
  const parts = [scope, ownerId];
  if (scope === 'comment') parts.push(postId);
  parts.push(`${Date.now()}-${crypto.randomUUID()}.${extension}`);
  return parts.join('/');
}

async function upload(request, env) {
  const { user, profile } = await authenticate(request, env);
  if (env.UPLOAD_RATE_LIMITER) {
    const { success } = await env.UPLOAD_RATE_LIMITER.limit({ key: user.id });
    if (!success) {
      return errorResponse(
        request,
        env,
        'Bạn tải tệp quá nhanh. Hãy đợi một phút rồi thử lại.',
        429
      );
    }
  }
  const scope = request.headers.get('X-Media-Scope');
  if (!['post', 'comment'].includes(scope)) {
    return errorResponse(request, env, 'Loại tệp tải lên không hợp lệ.');
  }

  const postId = cleanPostId(request.headers.get('X-Post-Id'));
  if (scope === 'comment' && !postId) {
    return errorResponse(request, env, 'Thiếu mã bài viết cho tệp bình luận.');
  }

  const contentType = (request.headers.get('Content-Type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const media = MEDIA_TYPES.get(contentType);
  if (!media) {
    return errorResponse(request, env, 'Chỉ hỗ trợ JPG, PNG, WebP, GIF, MP4, WebM hoặc MOV.', 415);
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  const limit = media.kind === 'image' ? IMAGE_LIMIT : VIDEO_LIMIT;
  if (declaredLength > limit) {
    return errorResponse(
      request,
      env,
      media.kind === 'image' ? 'Ảnh vượt quá 2 MB.' : 'Video vượt quá 25 MB.',
      413
    );
  }

  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > limit) {
    return errorResponse(
      request,
      env,
      media.kind === 'image' ? 'Ảnh phải nhỏ hơn 2 MB.' : 'Video phải nhỏ hơn 25 MB.',
      413
    );
  }
  const bytes = new Uint8Array(body.slice(0, 16));
  if (!signatureMatches(bytes, contentType)) {
    return errorResponse(request, env, 'Nội dung tệp không khớp với định dạng đã khai báo.', 415);
  }

  const key = mediaKey(scope, user.id, postId, media.extension);
  await env.MEDIA_BUCKET.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: 'inline'
    },
    customMetadata: {
      ownerId: user.id,
      ownerRole: profile.role || 'member',
      scope,
      postId,
      originalName: (request.headers.get('X-File-Name') || '').slice(0, 160)
    }
  });

  return json(request, env, {
    path: key,
    url: `${new URL(request.url).origin}/media/${encodedKey(key)}`,
    type: media.kind,
    size: body.byteLength,
    provider: 'r2'
  }, 201);
}

function keyFromPath(pathname, prefix) {
  const raw = pathname.slice(prefix.length);
  if (!raw) return '';
  const key = raw.split('/').map(part => decodeURIComponent(part)).join('/');
  if (key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) {
    return '';
  }
  return key;
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value || '');
  if (!match) return null;
  if (!match[1] && !match[2]) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function objectHeaders(object, request, env, extra = {}) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
  Object.entries(extra).forEach(([key, value]) => headers.set(key, value));
  return headers;
}

async function serveMedia(request, env, key) {
  const head = await env.MEDIA_BUCKET.head(key);
  if (!head) return new Response('Không tìm thấy tệp.', { status: 404 });
  if (request.headers.get('If-None-Match') === head.httpEtag) {
    return new Response(null, { status: 304, headers: objectHeaders(head, request, env) });
  }
  if (request.method === 'HEAD') {
    return new Response(null, {
      headers: objectHeaders(head, request, env, { 'Content-Length': String(head.size) })
    });
  }

  const range = parseRange(request.headers.get('Range'), head.size);
  if (request.headers.has('Range') && !range) {
    return new Response(null, {
      status: 416,
      headers: objectHeaders(head, request, env, { 'Content-Range': `bytes */${head.size}` })
    });
  }
  const object = range
    ? await env.MEDIA_BUCKET.get(key, {
        range: { offset: range.start, length: range.end - range.start + 1 }
      })
    : await env.MEDIA_BUCKET.get(key);
  if (!object) return new Response('Không tìm thấy tệp.', { status: 404 });

  const extraHeaders = range
    ? {
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${head.size}`
      }
    : { 'Content-Length': String(head.size) };
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: objectHeaders(object, request, env, extraHeaders)
  });
}

async function removeMedia(request, env, key) {
  const { user, profile } = await authenticate(request, env);
  const object = await env.MEDIA_BUCKET.head(key);
  if (!object) return errorResponse(request, env, 'Tệp không tồn tại.', 404);

  const ownerId = object.customMetadata?.ownerId || key.split('/')[1];
  const staff = ['moderator', 'admin'].includes(profile.role);
  if (ownerId !== user.id && !staff) {
    return errorResponse(request, env, 'Bạn không có quyền xóa tệp này.', 403);
  }
  await env.MEDIA_BUCKET.delete(key);
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env)
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(request, env, { ok: true, service: 'chonhoctap-media', storage: 'r2' });
    }

    try {
      if (request.method === 'POST' && url.pathname === '/api/media') {
        return await upload(request, env);
      }
      if (['GET', 'HEAD'].includes(request.method) && url.pathname.startsWith('/media/')) {
        const key = keyFromPath(url.pathname, '/media/');
        return key
          ? await serveMedia(request, env, key)
          : errorResponse(request, env, 'Đường dẫn tệp không hợp lệ.');
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/media/')) {
        const key = keyFromPath(url.pathname, '/api/media/');
        return key
          ? await removeMedia(request, env, key)
          : errorResponse(request, env, 'Đường dẫn tệp không hợp lệ.');
      }
      return errorResponse(request, env, 'Không tìm thấy đường dẫn.', 404);
    } catch (error) {
      if (error instanceof Response) {
        const message = await error.text();
        return errorResponse(request, env, message || 'Yêu cầu bị từ chối.', error.status);
      }
      console.error(error);
      return errorResponse(request, env, 'Máy chủ media gặp lỗi.', 500);
    }
  }
};
