import { MEDIA_API_URL } from './media-config.js?v=20260730-1';

const MB = 1024 * 1024;
export const IMAGE_OUTPUT_LIMIT = 2 * MB;
export const VIDEO_OUTPUT_LIMIT = 25 * MB;

export function r2Enabled() {
  return /^https:\/\/[a-z0-9.-]+(?:\/.*)?$/i.test(MEDIA_API_URL);
}

function mediaType(file) {
  if (file?.type?.startsWith('image/')) return 'image';
  if (file?.type?.startsWith('video/')) return 'video';
  return '';
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Không thể nén ảnh này.')),
      type,
      quality
    );
  });
}

function targetDimensions(width, height, scale = 1) {
  const landscape = width >= height;
  const maxWidth = (landscape ? 1280 : 720) * scale;
  const maxHeight = (landscape ? 720 : 1280) * scale;
  const ratio = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function optimizeImage(file) {
  if (!file?.type?.startsWith('image/')) return file;
  if (file.type === 'image/gif') {
    if (file.size > IMAGE_OUTPUT_LIMIT) {
      throw new Error('GIF động phải nhỏ hơn 2 MB.');
    }
    return file;
  }

  const source = await decodeImage(file);
  const sourceWidth = source.width || source.naturalWidth;
  const sourceHeight = source.height || source.naturalHeight;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Trình duyệt không hỗ trợ nén ảnh.');

  let scale = 1;
  let quality = 0.84;
  let blob;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const dimensions = targetDimensions(sourceWidth, sourceHeight, scale);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    blob = await canvasBlob(canvas, 'image/webp', quality);
    if (blob.size <= IMAGE_OUTPUT_LIMIT) break;
    if (quality > 0.58) quality -= 0.08;
    else scale *= 0.82;
  }
  source.close?.();
  if (!blob || blob.size > IMAGE_OUTPUT_LIMIT) {
    throw new Error('Không thể nén ảnh xuống dưới 2 MB. Hãy chọn ảnh nhỏ hơn.');
  }

  const baseName = (file.name || 'image').replace(/\.[^.]+$/u, '');
  return new File([blob], `${baseName}.webp`, {
    type: 'image/webp',
    lastModified: Date.now()
  });
}

export async function prepareMedia(file) {
  const kind = mediaType(file);
  if (!kind) {
    throw new Error('Chỉ hỗ trợ ảnh hoặc video.');
  }
  if (kind === 'image') return optimizeImage(file);
  if (file.size > VIDEO_OUTPUT_LIMIT) {
    throw new Error('Video phải nhỏ hơn 25 MB.');
  }
  if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) {
    throw new Error('Chỉ hỗ trợ video MP4, WebM hoặc MOV.');
  }
  return file;
}

function encodedKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function apiError(response) {
  try {
    const payload = await response.json();
    return payload.error || `Máy chủ trả về mã ${response.status}.`;
  } catch {
    return `Máy chủ trả về mã ${response.status}.`;
  }
}

export async function uploadToR2(session, file, options = {}) {
  if (!r2Enabled()) throw new Error('Cloudflare R2 chưa được cấu hình.');
  const headers = {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': file.type,
    'X-Media-Scope': options.scope || 'post',
    'X-File-Name': file.name || ''
  };
  if (options.postId) headers['X-Post-Id'] = options.postId;

  const response = await fetch(`${MEDIA_API_URL}/api/media`, {
    method: 'POST',
    headers,
    body: file
  });
  if (!response.ok) throw new Error(await apiError(response));
  return response.json();
}

export async function deleteFromR2(session, key) {
  if (!r2Enabled()) throw new Error('Cloudflare R2 chưa được cấu hình.');
  const response = await fetch(`${MEDIA_API_URL}/api/media/${encodedKey(key)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.access_token}` }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(await apiError(response));
  }
}
