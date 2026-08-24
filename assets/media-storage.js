import { MEDIA_API_URL } from './media-config.js?v=20260815-1';

const MB = 1024 * 1024;
const SUPABASE_TUS_URL =
  'https://qartstnodgujgqkczzml.storage.supabase.co/storage/v1/upload/resumable';
export const IMAGE_OUTPUT_LIMIT = 50 * MB;
export const VIDEO_OUTPUT_LIMIT = 50 * MB;
export const VIDEO_SOURCE_LIMIT = 300 * MB;
export const AUDIO_OUTPUT_LIMIT = 50 * MB;
export const VIP_IMAGE_OUTPUT_LIMIT = 50 * MB;
export const VIP_VIDEO_OUTPUT_LIMIT = 50 * MB;
export const VIP_AUDIO_OUTPUT_LIMIT = 50 * MB;
export const MEDIA_TOTAL_LIMIT = 50 * MB;

export function mediaLimitsForRole(role) {
  const admin = role === 'admin';
  const elevated = ['vip', 'moderator'].includes(role);
  return {
    elevated: elevated || admin,
    admin,
    maxImages: admin ? Infinity : elevated ? 5 : 2,
    maxVideos: admin ? Infinity : 1,
    maxAudios: admin ? Infinity : 1,
    imageBytes: admin ? 50 * MB : elevated ? VIP_IMAGE_OUTPUT_LIMIT : IMAGE_OUTPUT_LIMIT,
    totalMediaBytes: MEDIA_TOTAL_LIMIT,
    videoBytes: admin ? 50 * MB : VIP_VIDEO_OUTPUT_LIMIT,
    audioBytes: admin ? 50 * MB : elevated ? VIP_AUDIO_OUTPUT_LIMIT : AUDIO_OUTPUT_LIMIT,
    videoDuration: Infinity,
    audioDuration: Infinity,
    maxWidth: 1280,
    maxHeight: 720,
    qualityLabel: '720p'
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
  if (file.size > limits.imageBytes) {
    throw new Error(
      `Ảnh phải nhỏ hơn ${Math.round(limits.imageBytes / MB)} MB. `
      + 'Ảnh được giữ nguyên chất lượng và độ phân giải.'
    );
  }
  return file;
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

export function videoOutputDimensions(width, height, maxWidth = 1280, maxHeight = 720) {
  const dimensions = targetDimensions(width, height, maxWidth, maxHeight);
  return {
    width: Math.max(2, Math.floor(dimensions.width / 2) * 2),
    height: Math.max(2, Math.floor(dimensions.height / 2) * 2)
  };
}

function recorderMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4'
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function videoFileName(file, mimeType) {
  const baseName = (file.name || 'video').replace(/\.[^.]+$/u, '');
  const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  return `${baseName}-720p.${extension}`;
}

async function transcodeVideoTo720p(file, metadata, limits, options = {}) {
  const canRecord = typeof MediaRecorder !== 'undefined'
    && typeof MediaStream !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  if (!canRecord) {
    throw new Error(
      'Trình duyệt này không hỗ trợ nén video tự động. '
      + 'Hãy dùng Chrome, Edge hoặc Firefox phiên bản mới.'
    );
  }

  const mimeType = recorderMimeType();
  if (!mimeType) throw new Error('Trình duyệt không có bộ mã hóa video phù hợp.');

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    URL.revokeObjectURL(url);
    throw new Error('Trình duyệt không thể tạo khung hình để nén video.');
  }

  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('Không thể mở video để nén.')),
      15000
    );
    video.onloadeddata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Không thể giải mã video này để nén.'));
    };
  }).catch(error => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    throw error;
  });

  const dimensions = videoOutputDimensions(
    metadata.width,
    metadata.height,
    limits.maxWidth,
    limits.maxHeight
  );
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const canvasStream = canvas.captureStream(30);
  let audioContext;
  let audioSource;
  let audioDestination;
  let outputStream;
  let recorder;
  let animationFrame = 0;
  let frameCallback = 0;
  let transcodeTimeout = 0;
  const chunks = [];

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioTracks = [];
    if (AudioContextClass) {
      audioContext = new AudioContextClass();
      await audioContext.resume();
      audioSource = audioContext.createMediaElementSource(video);
      audioDestination = audioContext.createMediaStreamDestination();
      audioSource.connect(audioDestination);
      audioTracks.push(...audioDestination.stream.getAudioTracks());
    } else {
      const captured = video.captureStream?.() || video.mozCaptureStream?.();
      if (captured) audioTracks.push(...captured.getAudioTracks());
    }

    outputStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks
    ]);
    const durationSeconds = Math.max(1, metadata.durationSeconds || video.duration || 1);
    const targetTotalBitrate = Math.floor((limits.videoBytes * 8 * 0.88) / durationSeconds);
    const audioBitrate = Math.max(24_000, Math.min(128_000, Math.floor(targetTotalBitrate * 0.15)));
    const videoBitrate = Math.max(60_000, Math.min(4_500_000, targetTotalBitrate - audioBitrate));
    recorder = new MediaRecorder(outputStream, {
      mimeType,
      videoBitsPerSecond: videoBitrate,
      audioBitsPerSecond: audioBitrate
    });
    recorder.ondataavailable = event => {
      if (event.data?.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = event => reject(event.error || new Error('Nén video thất bại.'));
    });
    const playbackEnded = new Promise((resolve, reject) => {
      const finish = callback => value => {
        window.clearTimeout(transcodeTimeout);
        callback(value);
      };
      video.onended = finish(resolve);
      video.onerror = finish(() => reject(new Error('Video bị lỗi trong lúc nén.')));
      transcodeTimeout = window.setTimeout(
        finish(() => reject(new Error('Nén video quá thời gian cho phép. Hãy thử lại.'))),
        Math.max(45_000, ((metadata.durationSeconds || 60) + 30) * 1000)
      );
    });

    const drawFrame = () => {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (metadata.durationSeconds && typeof options.onProgress === 'function') {
        options.onProgress(Math.min(1, video.currentTime / metadata.durationSeconds));
      }
      if (!video.ended) {
        if (typeof video.requestVideoFrameCallback === 'function') {
          frameCallback = video.requestVideoFrameCallback(drawFrame);
        } else {
          animationFrame = window.requestAnimationFrame(drawFrame);
        }
      }
    };

    recorder.start(1000);
    drawFrame();
    await video.play();
    await playbackEnded;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    recorder.stop();
    await stopped;

    const outputType = mimeType.split(';')[0];
    const blob = new Blob(chunks, { type: outputType });
    if (!blob.size) throw new Error('Video sau nén không có dữ liệu.');
    if (blob.size > limits.videoBytes) {
      throw new Error(
        `Video sau nén vẫn vượt ${Math.round(limits.videoBytes / MB)} MB. `
        + 'Hãy chọn video ngắn hơn.'
      );
    }
    options.onProgress?.(1);
    return new File([blob], videoFileName(file, outputType), {
      type: outputType,
      lastModified: Date.now()
    });
  } finally {
    window.clearTimeout(transcodeTimeout);
    video.pause();
    if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(frameCallback);
    }
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    if (recorder?.state === 'recording') recorder.stop();
    outputStream?.getTracks().forEach(track => track.stop());
    canvasStream.getTracks().forEach(track => track.stop());
    audioSource?.disconnect();
    if (audioContext) await audioContext.close().catch(() => {});
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function prepareMedia(file, role = 'member', options = {}) {
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
    return file;
  }
  if (file.size > VIDEO_SOURCE_LIMIT) {
    throw new Error(
      `Video gốc phải nhỏ hơn ${Math.round(VIDEO_SOURCE_LIMIT / MB)} MB để nén.`
    );
  }
  if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) {
    throw new Error('Chỉ hỗ trợ video MP4, WebM hoặc MOV.');
  }
  const metadata = await mediaMetadata(file);
  const needsTranscode = !fitsFrame(metadata, limits) || file.size > limits.videoBytes;
  if (!needsTranscode) return file;
  return transcodeVideoTo720p(file, metadata, limits, options);
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

export async function uploadToSupabaseResumable(session, bucket, path, file) {
  const { Upload } = await import('https://cdn.jsdelivr.net/npm/tus-js-client@4/+esm');
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
