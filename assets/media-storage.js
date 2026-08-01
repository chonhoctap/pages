import { MEDIA_API_URL } from './media-config.js?v=20260730-1';
import { Upload } from 'https://cdn.jsdelivr.net/npm/tus-js-client@4/+esm';

const MB = 1024 * 1024;
const SUPABASE_TUS_URL =
  'https://qartstnodgujgqkczzml.storage.supabase.co/storage/v1/upload/resumable';
export const IMAGE_OUTPUT_LIMIT = 1.5 * MB;
export const VIDEO_OUTPUT_LIMIT = 25 * MB;
export const AUDIO_OUTPUT_LIMIT = 10 * MB;
export const VIP_IMAGE_OUTPUT_LIMIT = 3 * MB;
export const VIP_VIDEO_OUTPUT_LIMIT = 50 * MB;
export const VIP_AUDIO_OUTPUT_LIMIT = 20 * MB;
export const MEDIA_DURATION_LIMIT = 180;
export const AUDIO_DURATION_LIMIT = 600;

export function mediaLimitsForRole(role) {
  const elevated = ['vip', 'moderator', 'admin'].includes(role);
  return {
    elevated,
    maxImages: elevated ? 6 : 2,
    maxVideos: elevated ? 2 : 1,
    maxAudios: elevated ? 2 : 1,
    imageBytes: elevated ? VIP_IMAGE_OUTPUT_LIMIT : IMAGE_OUTPUT_LIMIT,
    videoBytes: elevated ? VIP_VIDEO_OUTPUT_LIMIT : VIDEO_OUTPUT_LIMIT,
    audioBytes: elevated ? VIP_AUDIO_OUTPUT_LIMIT : AUDIO_OUTPUT_LIMIT,
    maxWidth: elevated ? 1920 : 1280,
    maxHeight: elevated ? 1080 : 720,
    qualityLabel: elevated ? '1080p' : '720p'
  };
}

export function r2Enabled() {
  return /^https:\/\/[a-z0-9.-]+(?:\/.*)?$/i.test(MEDIA_API_URL);
}

function mediaType(file) {
  if (file?.type?.startsWith('image/')) return 'image';
  if (file?.type?.startsWith('video/')) return 'video';
  if (file?.type?.startsWith('audio/')) return 'audio';
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

function targetDimensions(width, height, maxWidth, maxHeight, scale = 1) {
  const landscape = width >= height;
  const frameWidth = (landscape ? maxWidth : maxHeight) * scale;
  const frameHeight = (landscape ? maxHeight : maxWidth) * scale;
  const ratio = Math.min(1, frameWidth / width, frameHeight / height);
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

export async function optimizeImage(file, role = 'member') {
  if (!file?.type?.startsWith('image/')) return file;
  const limits = mediaLimitsForRole(role);
  if (file.type === 'image/gif') {
    if (file.size > limits.imageBytes) {
      throw new Error(
        `GIF động phải nhỏ hơn ${(limits.imageBytes / MB).toFixed(1)} MB.`
      );
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
    const dimensions = targetDimensions(
      sourceWidth,
      sourceHeight,
      limits.maxWidth,
      limits.maxHeight,
      scale
    );
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    blob = await canvasBlob(canvas, 'image/webp', quality);
    if (blob.size <= limits.imageBytes) break;
    if (quality > 0.58) quality -= 0.08;
    else scale *= 0.82;
  }
  source.close?.();
  if (!blob || blob.size > limits.imageBytes) {
    throw new Error(
      `Không thể nén ảnh xuống dưới ${(limits.imageBytes / MB).toFixed(1)} MB. `
      + 'Hãy chọn ảnh nhỏ hơn.'
    );
  }

  const baseName = (file.name || 'image').replace(/\.[^.]+$/u, '');
  return new File([blob], `${baseName}.webp`, {
    type: 'image/webp',
    lastModified: Date.now()
  });
}

function videoMetadata(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Không đọc được thông tin video. Hãy dùng video MP4 hoặc WebM.'));
    }, 12000);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      const result = {
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        durationSeconds: Number.isFinite(video.duration)
          ? Math.max(1, Math.ceil(video.duration))
          : null
      };
      cleanup();
      resolve(result);
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      cleanup();
      reject(new Error('Trình duyệt không đọc được video này. Hãy đổi sang MP4 hoặc WebM.'));
    };
    video.src = url;
  });
}

function audioMetadata(file) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      audio.load();
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Không đọc được thông tin âm thanh. Hãy dùng MP3, M4A, OGG, WebM hoặc WAV.'));
    }, 12000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      const result = {
        width: null,
        height: null,
        durationSeconds: Number.isFinite(audio.duration)
          ? Math.max(1, Math.ceil(audio.duration))
          : null
      };
      cleanup();
      resolve(result);
    };
    audio.onerror = () => {
      window.clearTimeout(timeout);
      cleanup();
      reject(new Error('Trình duyệt không đọc được tệp âm thanh này.'));
    };
    audio.src = url;
  });
}

export async function mediaMetadata(file) {
  if (file?.type?.startsWith('image/')) {
    const source = await decodeImage(file);
    const result = {
      width: source.width || source.naturalWidth || null,
      height: source.height || source.naturalHeight || null,
      durationSeconds: null
    };
    source.close?.();
    return result;
  }
  if (file?.type?.startsWith('video/')) return videoMetadata(file);
  if (file?.type?.startsWith('audio/')) return audioMetadata(file);
  return { width: null, height: null, durationSeconds: null };
}

function fitsFrame(metadata, limits) {
  if (!metadata.width || !metadata.height) return false;
  const landscape = metadata.width >= metadata.height;
  return landscape
    ? metadata.width <= limits.maxWidth && metadata.height <= limits.maxHeight
    : metadata.width <= limits.maxHeight && metadata.height <= limits.maxWidth;
}

export async function prepareMedia(file, role = 'member') {
  const kind = mediaType(file);
  if (!kind) {
    throw new Error('Chỉ hỗ trợ ảnh, video hoặc âm thanh.');
  }
  const limits = mediaLimitsForRole(role);
  if (kind === 'image') return optimizeImage(file, role);
  if (kind === 'audio') {
    if (file.size > limits.audioBytes) {
      throw new Error(
        `Âm thanh phải nhỏ hơn ${Math.round(limits.audioBytes / MB)} MB.`
      );
    }
    if (![
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'audio/webm',
      'audio/wav',
      'audio/x-wav'
    ].includes(file.type)) {
      throw new Error('Chỉ hỗ trợ âm thanh MP3, M4A, OGG, WebM hoặc WAV.');
    }
    const metadata = await mediaMetadata(file);
    if (
      metadata.durationSeconds
      && metadata.durationSeconds > AUDIO_DURATION_LIMIT
    ) {
      throw new Error('Âm thanh tối đa 10 phút.');
    }
    return file;
  }
  if (file.size > limits.videoBytes) {
    throw new Error(
      `Video phải nhỏ hơn ${Math.round(limits.videoBytes / MB)} MB.`
    );
  }
  if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) {
    throw new Error('Chỉ hỗ trợ video MP4, WebM hoặc MOV.');
  }
  const metadata = await mediaMetadata(file);
  if (!fitsFrame(metadata, limits)) {
    throw new Error(
      `Video phải có sẵn chất lượng tối đa ${limits.qualityLabel}. `
      + 'Trình duyệt chưa thể tự nén video; hãy giảm độ phân giải trước khi tải lên.'
    );
  }
  if (
    metadata.durationSeconds
    && metadata.durationSeconds > MEDIA_DURATION_LIMIT
  ) {
    throw new Error('Video tối đa 3 phút.');
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

export function uploadToSupabaseResumable(session, bucket, path, file) {
  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: SUPABASE_TUS_URL,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'x-upsert': 'false'
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * MB,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: file.type,
        cacheControl: '3600'
      },
      onError: reject,
      onSuccess: () => resolve({ path })
    });
    upload.start();
  });
}
