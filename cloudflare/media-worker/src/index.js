const MB = 1024 * 1024;
const MEMBER_LIMITS = { image: 50 * MB, video: 50 * MB, audio: 50 * MB };
const VIP_LIMITS = { image: 50 * MB, video: 50 * MB, audio: 50 * MB };
const ADMIN_LIMITS = { image: 50 * MB, video: 50 * MB, audio: 50 * MB };

const MEDIA_TYPES = new Map([
  ['image/jpeg', { kind: 'image', extension: 'jpg' }],
  ['image/png', { kind: 'image', extension: 'png' }],
  ['image/webp', { kind: 'image', extension: 'webp' }],
  ['image/gif', { kind: 'image', extension: 'gif' }],
  ['video/mp4', { kind: 'video', extension: 'mp4' }],
  ['video/webm', { kind: 'video', extension: 'webm' }],
  ['video/quicktime', { kind: 'video', extension: 'mov' }],
  ['audio/mpeg', { kind: 'audio', extension: 'mp3' }],
  ['audio/mp4', { kind: 'audio', extension: 'm4a' }],
  ['audio/ogg', { kind: 'audio', extension: 'ogg' }],
  ['audio/webm', { kind: 'audio', extension: 'webm' }],
  ['audio/wav', { kind: 'audio', extension: 'wav' }],
  ['audio/x-wav', { kind: 'audio', extension: 'wav' }]
]);

function mediaLimit(role, kind, scope = 'post') {
  if (role === 'vip' && scope === 'post') return Infinity;
  if (role === 'admin') return ADMIN_LIMITS[kind];
  if (['vip', 'moderator'].includes(role)) return VIP_LIMITS[kind];
  return MEMBER_LIMITS[kind];
}

function unlimitedVipPost(profile, scope) {
  return profile?.role === 'vip' && scope === 'post';
}

function mediaLabel(kind) {
  if (kind === 'image') return 'Ảnh';
  if (kind === 'video') return 'Video';
  return 'Âm thanh';
}

function megabyteLabel(bytes) {
  const value = bytes / MB;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = origin === env.ALLOWED_ORIGIN
    || origin === 'http://localhost:8000'
    || origin === 'http://127.0.0.1:8000';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, X-Media-Scope, X-Post-Id, X-File-Name, '
      + 'X-File-Type, X-File-Size, X-Upload-Key, X-Upload-Id, X-Part-Number, X-Cleanup-Secret',
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

function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided.length || provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < provided.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function cleanupAuthorized(request, env) {
  return secretMatches(
    request.headers.get('X-Cleanup-Secret'),
    env.R2_CLEANUP_SECRET
  );
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
  if (contentType === 'audio/mpeg') {
    return ascii(bytes, 0, 3) === 'ID3'
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }
  if (contentType === 'audio/mp4') {
    return ascii(bytes, 4, 4) === 'ftyp';
  }
  if (contentType === 'audio/ogg') {
    return ascii(bytes, 0, 4) === 'OggS';
  }
  if (contentType === 'audio/webm') {
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') {
    return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
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
  const scope = request.headers.get('X-Media-Scope');
  if (!['post', 'comment'].includes(scope)) {
    return errorResponse(request, env, 'Loại tệp tải lên không hợp lệ.');
  }
  if (env.UPLOAD_RATE_LIMITER && !unlimitedVipPost(profile, scope)) {
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
    return errorResponse(
      request,
      env,
      'Chỉ hỗ trợ ảnh JPG/PNG/WebP/GIF, video MP4/WebM/MOV hoặc âm thanh MP3/M4A/OGG/WebM/WAV.',
      415
    );
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  const limit = mediaLimit(profile.role, media.kind, scope);
  const label = mediaLabel(media.kind);
  if (declaredLength > limit) {
    return errorResponse(
      request,
      env,
      `${label} vượt quá ${megabyteLabel(limit)} MB.`,
      413
    );
  }

  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > limit) {
    return errorResponse(
      request,
      env,
      `${label} phải nhỏ hơn ${megabyteLabel(limit)} MB.`,
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

function ownedUploadKey(key, userId) {
  const cleaned = cleanR2Key(key);
  if (!cleaned) return '';
  const [scope, ownerId] = cleaned.split('/');
  return ['post', 'comment'].includes(scope) && ownerId === userId ? cleaned : '';
}

function validUploadId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : '';
}

function multipartMedia(request) {
  const contentType = (request.headers.get('X-File-Type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return { contentType, media: MEDIA_TYPES.get(contentType) };
}

async function startMultipartUpload(request, env) {
  const { user, profile } = await authenticate(request, env);
  const scope = request.headers.get('X-Media-Scope');
  if (!['post', 'comment'].includes(scope)) {
    return errorResponse(request, env, 'Loại tệp tải lên không hợp lệ.');
  }
  if (env.UPLOAD_RATE_LIMITER && !unlimitedVipPost(profile, scope)) {
    const { success } = await env.UPLOAD_RATE_LIMITER.limit({ key: user.id });
    if (!success) {
      return errorResponse(request, env, 'Bạn tải tệp quá nhanh. Hãy đợi một phút rồi thử lại.', 429);
    }
  }

  const postId = cleanPostId(request.headers.get('X-Post-Id'));
  if (scope === 'comment' && !postId) {
    return errorResponse(request, env, 'Thiếu mã bài viết cho tệp bình luận.');
  }
  const { contentType, media } = multipartMedia(request);
  if (!media) {
    return errorResponse(request, env, 'Định dạng tệp tải lên không được hỗ trợ.', 415);
  }
  const fileSize = Number(request.headers.get('X-File-Size'));
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    return errorResponse(request, env, 'Dung lượng tệp không hợp lệ.');
  }
  const limit = mediaLimit(profile.role, media.kind, scope);
  if (fileSize > limit) {
    return errorResponse(
      request,
      env,
      `${mediaLabel(media.kind)} vượt quá ${megabyteLabel(limit)} MB.`,
      413
    );
  }

  const key = mediaKey(scope, user.id, postId, media.extension);
  const multipart = await env.MEDIA_BUCKET.createMultipartUpload(key, {
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
      mediaKind: media.kind,
      declaredSize: String(fileSize),
      originalName: (request.headers.get('X-File-Name') || '').slice(0, 160)
    }
  });
  return json(request, env, { key: multipart.key, uploadId: multipart.uploadId }, 201);
}

async function uploadMultipartPart(request, env) {
  const { user } = await authenticate(request, env);
  const key = ownedUploadKey(request.headers.get('X-Upload-Key') || '', user.id);
  const uploadId = validUploadId(request.headers.get('X-Upload-Id'));
  const partNumber = Number(request.headers.get('X-Part-Number'));
  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return errorResponse(request, env, 'Thông tin phần tải lên không hợp lệ.');
  }

  const body = await request.arrayBuffer();
  if (!body.byteLength) return errorResponse(request, env, 'Phần tải lên không có dữ liệu.');
  if (partNumber === 1) {
    const contentType = (request.headers.get('Content-Type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!MEDIA_TYPES.has(contentType) || !signatureMatches(new Uint8Array(body.slice(0, 16)), contentType)) {
      return errorResponse(request, env, 'Nội dung tệp không khớp với định dạng đã khai báo.', 415);
    }
  }

  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await multipart.uploadPart(partNumber, body);
  return json(request, env, { partNumber: part.partNumber, etag: part.etag });
}

async function multipartPayload(request, userId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return null;
  }
  const key = ownedUploadKey(payload?.key || '', userId);
  const uploadId = validUploadId(payload?.uploadId);
  return key && uploadId ? { ...payload, key, uploadId } : null;
}

async function completeMultipartUpload(request, env) {
  const { user } = await authenticate(request, env);
  const payload = await multipartPayload(request, user.id);
  if (!payload || !Array.isArray(payload.parts) || !payload.parts.length || payload.parts.length > 10000) {
    return errorResponse(request, env, 'Danh sách phần tải lên không hợp lệ.');
  }
  const parts = payload.parts.map(part => ({
    partNumber: Number(part?.partNumber),
    etag: typeof part?.etag === 'string' ? part.etag : ''
  }));
  if (parts.some(part => (
    !Number.isInteger(part.partNumber)
    || part.partNumber < 1
    || part.partNumber > 10000
    || !part.etag
  ))) {
    return errorResponse(request, env, 'Danh sách phần tải lên chứa dữ liệu sai.');
  }

  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(payload.key, payload.uploadId);
  await multipart.complete(parts);
  const object = await env.MEDIA_BUCKET.head(payload.key);
  if (!object) throw new Error('R2 không xác nhận tệp sau khi ghép.');
  return json(request, env, {
    path: payload.key,
    url: `${new URL(request.url).origin}/media/${encodedKey(payload.key)}`,
    type: object.customMetadata?.mediaKind || 'file',
    size: object.size,
    provider: 'r2'
  }, 201);
}

async function abortMultipartUpload(request, env) {
  const { user } = await authenticate(request, env);
  const payload = await multipartPayload(request, user.id);
  if (!payload) return errorResponse(request, env, 'Thông tin lượt tải lên không hợp lệ.');
  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(payload.key, payload.uploadId);
  await multipart.abort();
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
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

function cleanR2Key(value) {
  if (typeof value !== 'string' || !/^(post|comment)\//u.test(value)) return '';
  if (value.includes('\0')) return '';
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  return value;
}

async function cleanupMedia(request, env) {
  if (!cleanupAuthorized(request, env)) {
    return errorResponse(request, env, 'Không có quyền dọn media R2.', 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(request, env, 'Dữ liệu dọn media không hợp lệ.');
  }
  if (!Array.isArray(payload?.keys) || payload.keys.length > 500) {
    return errorResponse(request, env, 'Danh sách media phải có tối đa 500 đường dẫn.');
  }

  const cleaned = payload.keys.map(cleanR2Key);
  if (cleaned.some(key => !key)) {
    return errorResponse(request, env, 'Danh sách chứa đường dẫn R2 không hợp lệ.');
  }
  const keys = [...new Set(cleaned)];
  if (keys.length) await env.MEDIA_BUCKET.delete(keys);
  return json(request, env, { ok: true, deleted: keys.length });
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
  const admin = profile.role === 'admin';
  if (ownerId !== user.id && !admin) {
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
      if (request.method === 'POST' && url.pathname === '/api/media/multipart/start') {
        return await startMultipartUpload(request, env);
      }
      if (request.method === 'PUT' && url.pathname === '/api/media/multipart/part') {
        return await uploadMultipartPart(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/media/multipart/complete') {
        return await completeMultipartUpload(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/media/multipart/abort') {
        return await abortMultipartUpload(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/cleanup') {
        return await cleanupMedia(request, env);
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
