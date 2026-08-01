import {
  supabase,
  pageUrl,
  requireSession,
  getProfile,
  profileName,
  roleLabel,
  statusLabel,
  showMessage,
  setBusy,
  initThemeToggle,
  humanizeAuthError
} from './supabase-client.js?v=20260730-6';
import {
  r2Enabled,
  prepareMedia,
  mediaMetadata,
  mediaLimitsForRole,
  uploadToR2,
  uploadToSupabaseResumable,
  deleteFromR2
} from './media-storage.js?v=20260801-1';

initThemeToggle();

const SUBJECT_LABELS = {
  toan: 'Toán',
  'vat-ly': 'Vật lý',
  'hoa-hoc': 'Hóa học',
  'sinh-hoc': 'Sinh học',
  'ngu-van': 'Ngữ văn',
  'tieng-anh': 'Tiếng Anh',
  'tin-hoc': 'Tin học',
  khac: 'Môn khác'
};

const GRADE_LABELS = {
  10: 'Lớp 10',
  11: 'Lớp 11',
  12: 'Lớp 12',
  other: 'Khối khác'
};

const elements = {
  app: document.getElementById('forumApp'),
  denied: document.getElementById('forumDenied'),
  message: document.getElementById('forumMessage'),
  viewer: document.getElementById('viewerChip'),
  readonly: document.getElementById('readonlyBanner'),
  tabs: document.querySelectorAll('.forum-tab'),
  composerDialog: document.getElementById('composerDialog'),
  openComposer: document.getElementById('openComposerButton'),
  closeComposer: document.getElementById('closeComposerButton'),
  composer: document.getElementById('composer'),
  composerAvatar: document.getElementById('composerAvatar'),
  composerName: document.getElementById('composerName'),
  composerPrompt: document.getElementById('composerPrompt'),
  form: document.getElementById('postForm'),
  questionFields: document.getElementById('questionFields'),
  subject: document.getElementById('postSubject'),
  grade: document.getElementById('postGrade'),
  titleLabel: document.getElementById('postTitleLabel'),
  title: document.getElementById('postTitle'),
  body: document.getElementById('postBody'),
  hashtags: document.getElementById('postHashtags'),
  media: document.getElementById('postMedia'),
  mediaPreview: document.getElementById('mediaPreview'),
  mediaLimitNote: document.getElementById('mediaLimitNote'),
  publish: document.getElementById('publishButton'),
  feedTitle: document.getElementById('feedTitle'),
  feedCount: document.getElementById('feedCount'),
  search: document.getElementById('forumSearch'),
  sortButtons: document.querySelectorAll('[data-sort]'),
  gradeFilter: document.getElementById('gradeFilter'),
  statusFilter: document.getElementById('statusFilter'),
  moderationFilter: document.getElementById('moderationFilter'),
  feed: document.getElementById('postFeed'),
  template: document.getElementById('postTemplate'),
  sidebarTitle: document.getElementById('sidebarTitle'),
  sidebarTips: document.getElementById('sidebarTips'),
  mediaLightbox: document.getElementById('mediaLightbox'),
  mediaLightboxContent: document.getElementById('mediaLightboxContent'),
  closeMediaLightbox: document.getElementById('closeMediaLightbox'),
  reportDialog: document.getElementById('reportDialog'),
  reportForm: document.getElementById('reportForm'),
  reportReason: document.getElementById('reportReason'),
  reportDetails: document.getElementById('reportDetails'),
  closeReportDialog: document.getElementById('closeReportDialog'),
  submitReport: document.getElementById('submitReport')
};

let session;
let currentProfile;
let currentCategory = 'question';
let posts = [];
let previewPrepareSequence = 0;
let previewPreparePromise = Promise.resolve();
let loadSequence = 0;
let currentSort = 'latest';
let selectedPostMedia = [];
let reportingPost = null;
let postCooldownUntil = 0;
let postCooldownTimer = 0;
const commentPreviewUrls = new Map();
const commentPreparedFiles = new Map();
const commentPrepareSequences = new Map();
const commentPreparePromises = new Map();
const registeredViews = new Set();
let openReactionAction = null;

const REACTIONS = {
  like: { emoji: '👍', label: 'Thích' },
  love: { emoji: '❤️', label: 'Yêu thích' },
  haha: { emoji: '😆', label: 'Haha' },
  wow: { emoji: '😮', label: 'Wow' },
  sad: { emoji: '😢', label: 'Buồn' },
  angry: { emoji: '😡', label: 'Phẫn nộ' }
};

function canInteract() {
  return currentProfile?.account_status === 'active';
}

function cooldownSeconds() {
  return Math.max(0, Math.ceil((postCooldownUntil - Date.now()) / 1000));
}

function cooldownLabel(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updatePostCooldownUi() {
  const remaining = cooldownSeconds();
  const label = elements.openComposer.querySelector('span:last-child');
  elements.openComposer.disabled = remaining > 0;
  elements.openComposer.title = remaining > 0
    ? `Bạn có thể đăng bài tiếp theo sau ${cooldownLabel(remaining)}`
    : '';
  if (label) {
    label.textContent = remaining > 0
      ? `Đăng sau ${cooldownLabel(remaining)}`
      : 'Đăng bài';
  }
}

async function refreshPostCooldown() {
  if (!session?.user?.id || !canInteract()) return;
  const { data, error } = await supabase
    .from('forum_posts')
    .select('created_at')
    .eq('author_id', session.user.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const latestAt = data?.[0]?.created_at;
  postCooldownUntil = latestAt
    ? new Date(latestAt).getTime() + 15 * 60 * 1000
    : 0;
  updatePostCooldownUi();
}

function closeReactionPicker(action = openReactionAction) {
  if (!action) return;
  action.classList.remove('is-open');
  action.querySelector('.reaction-main')?.setAttribute('aria-expanded', 'false');
  if (openReactionAction === action) openReactionAction = null;
}

function toggleReactionPicker(action) {
  const shouldOpen = !action.classList.contains('is-open');
  if (openReactionAction && openReactionAction !== action) {
    closeReactionPicker(openReactionAction);
  }
  action.classList.toggle('is-open', shouldOpen);
  action.querySelector('.reaction-main')
    ?.setAttribute('aria-expanded', String(shouldOpen));
  openReactionAction = shouldOpen ? action : null;
}

function canModerate() {
  return canInteract() && ['moderator', 'admin'].includes(currentProfile?.role);
}

function authorOf(record) {
  return Array.isArray(record?.author) ? record.author[0] : record?.author;
}

function publicProfileUrl(profile) {
  return profile?.username
    ? `profile.html?user=${encodeURIComponent(profile.username)}`
    : 'profile.html';
}

function normalizeSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/^#+/u, '')
    .toLocaleLowerCase('vi')
    .trim();
}

function setInfo(message, type = 'info') {
  showMessage(elements.message, message, type);
  if (message) elements.message.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function relativeTime(value) {
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });
  const ranges = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60]
  ];
  for (const [unit, size] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, 'second');
}

function parseHashtags(raw) {
  const values = String(raw || '')
    .split(/[\s,]+/u)
    .map(value => value.replace(/^#+/u, '').replace(/[^\p{L}\p{N}_-]/gu, '').toLocaleLowerCase('vi'))
    .filter(Boolean);
  return [...new Set(values)].slice(0, 8);
}

function mediaKind(file) {
  if (file?.type?.startsWith('image/')) return 'image';
  if (file?.type?.startsWith('video/')) return 'video';
  if (file?.type?.startsWith('audio/')) return 'audio';
  return '';
}

function uniqueMediaPath(file, prefix = '') {
  const fallbackExtension = mediaKind(file) === 'video'
    ? 'mp4'
    : mediaKind(file) === 'audio'
      ? 'mp3'
      : 'jpg';
  const extension = (file.name.split('.').pop() || fallbackExtension)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const uniqueId = crypto.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${session.user.id}/${prefix}${Date.now()}-${uniqueId}.${extension}`;
}

function currentMediaLimits() {
  return mediaLimitsForRole(currentProfile?.role || 'member');
}

function releasePreparedItems(items) {
  (items || []).forEach(item => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  });
}

function resetPreview() {
  previewPrepareSequence += 1;
  releasePreparedItems(selectedPostMedia);
  selectedPostMedia = [];
  elements.media.value = '';
  elements.mediaPreview.replaceChildren();
  elements.mediaPreview.hidden = true;
}

function selectionCountError(files) {
  const limits = currentMediaLimits();
  const imageCount = files.filter(file => mediaKind(file) === 'image').length;
  const videoCount = files.filter(file => mediaKind(file) === 'video').length;
  const audioCount = files.filter(file => mediaKind(file) === 'audio').length;
  if (
    imageCount > limits.maxImages
    || videoCount > limits.maxVideos
    || audioCount > limits.maxAudios
  ) {
    return `Tài khoản ${roleLabel(currentProfile?.role)} được chọn tối đa `
      + `${limits.maxImages} ảnh, ${limits.maxVideos} video và `
      + `${limits.maxAudios} tệp âm thanh.`;
  }
  return '';
}

function renderPreparedPreview(container, items, onRemove) {
  container.replaceChildren();
  [...container.classList]
    .filter(className => className.startsWith('count-'))
    .forEach(className => container.classList.remove(className));
  container.classList.add('selection-grid', `count-${Math.min(items.length, 6)}`);
  items.forEach((item, index) => {
    const tile = document.createElement('div');
    tile.className = 'selection-tile';
    const contentTag = item.type === 'video'
      ? 'video'
      : item.type === 'audio'
        ? 'audio'
        : 'img';
    const content = document.createElement(contentTag);
    content.src = item.previewUrl;
    tile.classList.toggle('is-audio', item.type === 'audio');
    if (item.type === 'video') {
      content.muted = true;
      content.preload = 'metadata';
    } else if (item.type === 'audio') {
      content.controls = true;
      content.preload = 'metadata';
    } else {
      content.alt = `Ảnh xem trước ${index + 1}`;
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Bỏ media số ${index + 1}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => onRemove(index));
    tile.append(content, remove);
    container.appendChild(tile);
  });
  container.hidden = !items.length;
}

function renderPostSelectionPreview() {
  renderPreparedPreview(elements.mediaPreview, selectedPostMedia, index => {
    const [removed] = selectedPostMedia.splice(index, 1);
    releasePreparedItems([removed]);
    renderPostSelectionPreview();
    if (!selectedPostMedia.length) elements.media.value = '';
  });
}

async function prepareSelectedFiles(fileList, sequenceCheck) {
  const sourceFiles = [...(fileList || [])];
  const unsupported = sourceFiles.find(file => !mediaKind(file));
  if (unsupported) {
    throw new Error(
      'Chỉ hỗ trợ ảnh JPG/PNG/WebP/GIF, video MP4/WebM/MOV hoặc âm thanh MP3/M4A/OGG/WebM/WAV.'
    );
  }
  const countError = selectionCountError(sourceFiles);
  if (countError) throw new Error(countError);

  const preparedItems = [];
  try {
    for (const source of sourceFiles) {
      const prepared = await prepareMedia(source, currentProfile?.role || 'member');
      if (!sequenceCheck()) {
        releasePreparedItems(preparedItems);
        return [];
      }
      const metadata = await mediaMetadata(prepared);
      const limits = currentMediaLimits();
      const landscape = (metadata.width || 0) >= (metadata.height || 0);
      const needsFrame = mediaKind(prepared) !== 'audio';
      const fitsFrame = !needsFrame || (metadata.width && metadata.height && (
        landscape
          ? metadata.width <= limits.maxWidth && metadata.height <= limits.maxHeight
          : metadata.width <= limits.maxHeight && metadata.height <= limits.maxWidth
      ));
      if (!fitsFrame) {
        throw new Error(
          `Media phải nằm trong khung ${limits.qualityLabel}. `
          + 'GIF động không thể tự giảm độ phân giải.'
        );
      }
      if (!sequenceCheck()) {
        releasePreparedItems(preparedItems);
        return [];
      }
      preparedItems.push({
        file: prepared,
        type: mediaKind(prepared),
        metadata,
        previewUrl: URL.createObjectURL(prepared)
      });
    }
    return preparedItems;
  } catch (error) {
    releasePreparedItems(preparedItems);
    throw error;
  }
}

async function showMediaPreview(fileList) {
  const sequence = ++previewPrepareSequence;
  releasePreparedItems(selectedPostMedia);
  selectedPostMedia = [];
  elements.mediaPreview.replaceChildren();
  elements.mediaPreview.hidden = true;
  if (!fileList?.length) return;

  try {
    const limits = currentMediaLimits();
    setInfo(`Đang xử lý media theo giới hạn ${limits.qualityLabel}...`, 'info');
    const preparedItems = await prepareSelectedFiles(
      fileList,
      () => sequence === previewPrepareSequence
    );
    if (sequence !== previewPrepareSequence) return;
    selectedPostMedia = preparedItems;
    renderPostSelectionPreview();
    const totalSize = selectedPostMedia.reduce((sum, item) => sum + item.file.size, 0);
    setInfo(
      `Đã chuẩn bị ${selectedPostMedia.length} tệp (${(totalSize / 1024 / 1024).toFixed(1)} MB).`,
      'success'
    );
  } catch (error) {
    if (sequence !== previewPrepareSequence) return;
    elements.media.value = '';
    setInfo(error.message, 'error');
  }
}

function openComposer() {
  if (!canInteract()) {
    setInfo('Tài khoản đang bị hạn chế nên chưa thể đăng bài.', 'error');
    return;
  }
  const remaining = cooldownSeconds();
  if (remaining > 0) {
    setInfo(
      `Bạn chỉ có thể đăng một bài sau mỗi 15 phút. Hãy đợi ${cooldownLabel(remaining)}.`,
      'error'
    );
    return;
  }
  if (typeof elements.composerDialog.showModal === 'function') {
    elements.composerDialog.showModal();
  } else {
    elements.composerDialog.setAttribute('open', '');
  }
  window.setTimeout(() => elements.title.focus(), 30);
}

function closeComposer() {
  resetPreview();
  elements.form.reset();
  if (typeof elements.composerDialog.close === 'function') {
    elements.composerDialog.close();
  } else {
    elements.composerDialog.removeAttribute('open');
  }
}

function updateCategoryUi() {
  const isQuestion = currentCategory === 'question';
  elements.tabs.forEach(tab => {
    const active = tab.dataset.category === currentCategory;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-current', active ? 'page' : 'false');
  });
  elements.questionFields.hidden = !isQuestion;
  elements.gradeFilter.hidden = !isQuestion;
  elements.statusFilter.hidden = !isQuestion;
  elements.titleLabel.textContent = isQuestion ? 'Câu hỏi chính' : 'Nội dung chính';
  elements.title.placeholder = isQuestion
    ? 'Ví dụ: Giúp mình giải câu hình học này với'
    : 'Bạn đang nghĩ gì?';
  elements.body.placeholder = isQuestion
    ? 'Mô tả đề bài, phần bạn đã làm và chỗ đang vướng...'
    : 'Kể thêm câu chuyện, cảm xúc hoặc điều thú vị bạn muốn chia sẻ...';
  elements.composerPrompt.textContent = isQuestion
    ? 'Bạn đang cần giải bài nào?'
    : 'Chia sẻ điều thú vị với mọi người';
  elements.feedTitle.textContent = currentSort === 'trending'
    ? (isQuestion ? 'Hỏi đáp xu hướng' : 'Giải trí xu hướng')
    : (isQuestion ? 'Bài hỏi đáp mới nhất' : 'Bảng tin giải trí mới nhất');
  elements.sidebarTitle.textContent = isQuestion ? 'Hỏi đáp hiệu quả' : 'Không gian tích cực';
  elements.sidebarTips.replaceChildren();
  const tips = isQuestion
    ? [
        'Chụp rõ đề bài và ghi đúng môn, khối.',
        'Nói rõ phần bạn đã làm và chỗ đang vướng.',
        'Bấm “Đã giải” khi nhận được lời giải phù hợp.'
      ]
    : [
        'Chia sẻ ảnh, video, âm thanh hoặc câu chuyện tích cực.',
        'Tôn trọng sự khác biệt của mọi thành viên.',
        'Không spam và không đăng thông tin riêng tư.'
      ];
  tips.forEach(text => {
    const item = document.createElement('li');
    item.textContent = text;
    elements.sidebarTips.appendChild(item);
  });
}

async function uploadPreparedMedia(item, { scope = 'post', postId = '' } = {}) {
  if (!item?.file) return null;
  const file = item.file;
  if (r2Enabled()) {
    const uploaded = await uploadToR2(session, file, { scope, postId });
    return {
      ...uploaded,
      size_bytes: file.size,
      width: item.metadata.width,
      height: item.metadata.height,
      duration_seconds: item.metadata.durationSeconds
    };
  }
  const bucket = scope === 'comment' ? 'forum-comment-media' : 'forum-media';
  const path = uniqueMediaPath(file, postId ? `${postId}/` : '');
  if (file.size > 6 * 1024 * 1024) {
    await uploadToSupabaseResumable(session, bucket, path, file);
  } else {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type
      });
    if (error) throw error;
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return {
    path,
    url: data.publicUrl,
    type: mediaKind(file),
    size_bytes: file.size,
    width: item.metadata.width,
    height: item.metadata.height,
    duration_seconds: item.metadata.durationSeconds
  };
}

async function uploadPreparedMediaList(items, options) {
  const uploaded = [];
  try {
    for (const item of items) {
      uploaded.push(await uploadPreparedMedia(item, options));
    }
    return uploaded;
  } catch (error) {
    await Promise.allSettled(
      uploaded.map(item => removeStoredMedia(
        item.path,
        options.scope === 'comment' ? 'forum-comment-media' : 'forum-media'
      ))
    );
    throw error;
  }
}

async function publishPost(event) {
  event.preventDefault();
  if (!canInteract()) {
    setInfo('Tài khoản đang bị hạn chế nên chưa thể đăng bài.', 'error');
    return;
  }
  const remaining = cooldownSeconds();
  if (remaining > 0) {
    setInfo(
      `Bạn chỉ có thể đăng một bài sau mỗi 15 phút. Hãy đợi ${cooldownLabel(remaining)}.`,
      'error'
    );
    return;
  }
  await previewPreparePromise;

  const title = elements.title.value.trim();
  if (title.length < 3) {
    setInfo('Nội dung chính cần ít nhất 3 ký tự.', 'error');
    elements.title.focus();
    return;
  }
  const mediaItems = [...selectedPostMedia];
  let uploaded = [];
  let createdPostId = '';
  setBusy(elements.publish, true, 'Đang đăng...');
  try {
    uploaded = await uploadPreparedMediaList(mediaItems, { scope: 'post' });
    const firstMedia = uploaded[0];
    const payload = {
      author_id: session.user.id,
      category: currentCategory,
      title,
      body: elements.body.value.trim() || null,
      hashtags: parseHashtags(elements.hashtags.value),
      subject: currentCategory === 'question' ? elements.subject.value : null,
      grade: currentCategory === 'question' ? elements.grade.value : null,
      media_url: firstMedia?.url || null,
      media_path: firstMedia?.path || null,
      media_type: firstMedia?.type || null
    };
    const { data: createdPost, error } = await supabase
      .from('forum_posts')
      .insert(payload)
      .select('id, moderation_status')
      .single();
    if (error) throw error;
    createdPostId = createdPost.id;

    if (uploaded.length) {
      const { error: mediaError } = await supabase
        .from('forum_post_media')
        .insert(uploaded.map((item, index) => ({
          post_id: createdPostId,
          uploader_id: session.user.id,
          media_url: item.url,
          media_path: item.path,
          media_type: item.type,
          sort_order: index,
          size_bytes: item.size_bytes,
          width: item.width,
          height: item.height,
          duration_seconds: item.duration_seconds
        })));
      if (mediaError) throw mediaError;
    }

    elements.form.reset();
    resetPreview();
    closeComposer();
    setInfo(
      createdPost.moderation_status === 'pending_review'
        ? 'Bài đã được gửi vào hàng chờ để quản trị viên xem xét.'
        : 'Đã đăng bài thành công.',
      createdPost.moderation_status === 'pending_review' ? 'info' : 'success'
    );
    postCooldownUntil = Date.now() + 15 * 60 * 1000;
    updatePostCooldownUi();
    await loadPosts();
  } catch (error) {
    if (createdPostId) {
      await supabase.from('forum_posts').delete().eq('id', createdPostId);
    }
    await Promise.allSettled(
      uploaded.map(item => removeStoredMedia(item.path, 'forum-media'))
    );
    if (/15\s*phút/iu.test(error?.message || '')) {
      await refreshPostCooldown().catch(() => {});
    }
    setInfo(`Không thể đăng bài: ${humanizeAuthError(error)}`, 'error');
  } finally {
    setBusy(elements.publish, false);
  }
}

function countByPost(rows) {
  return (rows || []).reduce((map, row) => {
    map.set(row.post_id, (map.get(row.post_id) || 0) + 1);
    return map;
  }, new Map());
}

function groupByPost(rows) {
  return (rows || []).reduce((map, row) => {
    const values = map.get(row.post_id) || [];
    values.push(row);
    map.set(row.post_id, values);
    return map;
  }, new Map());
}

function trendScore(post) {
  const gradeBoost = post.category === 'question'
    && currentProfile?.grade
    && post.grade === currentProfile.grade
    ? 1.18
    : 1;
  return (post.trendingScore || 0) * gradeBoost;
}

function visiblePosts() {
  const term = normalizeSearch(elements.search.value);
  const filtered = term
    ? posts.filter(post => {
        const searchable = [
          post.title,
          post.body,
          ...(post.hashtags || [])
        ].map(normalizeSearch);
        return searchable.some(value => value.includes(term));
      })
    : [...posts];

  return filtered.sort((first, second) => {
    if (currentSort === 'trending') {
      const scoreDifference = trendScore(second) - trendScore(first);
      if (scoreDifference) return scoreDifference;
    }
    return new Date(second.created_at) - new Date(first.created_at);
  });
}

async function loadPosts() {
  const sequence = ++loadSequence;
  elements.feed.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'panel feed-loading';
  loading.textContent = 'Đang tải bài viết...';
  elements.feed.appendChild(loading);
  elements.feedCount.textContent = 'Đang tải...';

  let query = supabase
    .from('forum_posts')
    .select(`
      id,
      author_id,
      category,
      title,
      body,
      hashtags,
      subject,
      grade,
      is_solved,
      media_url,
      media_path,
      media_type,
      moderation_status,
      moderation_reason,
      is_pinned,
      expires_at,
      created_at,
      updated_at,
      author:profiles!forum_posts_author_id_fkey(
        username,
        display_name,
        avatar_url,
        role
      )
    `)
    .eq('category', currentCategory)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(100);

  if (currentCategory === 'question' && elements.gradeFilter.value !== 'all') {
    query = query.eq('grade', elements.gradeFilter.value);
  }
  if (currentCategory === 'question' && elements.statusFilter.value !== 'all') {
    query = query.eq('is_solved', elements.statusFilter.value === 'solved');
  }
  if (canModerate() && elements.moderationFilter?.value !== 'all') {
    query = query.eq('moderation_status', elements.moderationFilter.value);
  }

  try {
    const { data, error } = await query;
    if (error) throw error;
    if (sequence !== loadSequence) return;
    posts = data || [];

    if (posts.length) {
      const ids = posts.map(post => post.id);
      const [
        reactionsResult,
        commentsResult,
        sharesResult,
        mediaResult,
        metricsResult
      ] = await Promise.all([
        supabase
          .from('forum_reactions')
          .select('post_id, user_id, reaction_type')
          .in('post_id', ids),
        supabase.from('forum_comments').select('post_id').in('post_id', ids),
        supabase.from('forum_shares').select('post_id').in('post_id', ids),
        supabase
          .from('forum_post_media')
          .select(`
            id,
            post_id,
            media_url,
            media_path,
            media_type,
            sort_order,
            size_bytes,
            width,
            height,
            duration_seconds
          `)
          .in('post_id', ids)
          .order('sort_order', { ascending: true }),
        supabase
          .from('forum_post_metrics')
          .select('post_id, view_count, reaction_count, comment_count, share_count, trending_score')
          .in('post_id', ids)
      ]);
      if (reactionsResult.error) throw reactionsResult.error;
      if (commentsResult.error) throw commentsResult.error;
      if (sharesResult.error) throw sharesResult.error;
      if (mediaResult.error) throw mediaResult.error;
      if (metricsResult.error) throw metricsResult.error;
      if (sequence !== loadSequence) return;

      const commentCounts = countByPost(commentsResult.data);
      const shareCounts = countByPost(sharesResult.data);
      const reactionsByPost = groupByPost(reactionsResult.data);
      const mediaByPost = groupByPost(mediaResult.data);
      const metricsByPost = new Map(
        (metricsResult.data || []).map(metric => [metric.post_id, metric])
      );
      posts.forEach(post => {
        const postReactions = reactionsByPost.get(post.id) || [];
        const metric = metricsByPost.get(post.id) || {};
        post.reactionCounts = postReactions.reduce((counts, reaction) => {
          counts[reaction.reaction_type] = (counts[reaction.reaction_type] || 0) + 1;
          return counts;
        }, {});
        post.myReaction = postReactions.find(
          reaction => reaction.user_id === session.user.id
        )?.reaction_type || '';
        post.reactionCount = Number(metric.reaction_count ?? postReactions.length);
        post.commentCount = Number(metric.comment_count ?? commentCounts.get(post.id) ?? 0);
        post.shareCount = Number(metric.share_count ?? shareCounts.get(post.id) ?? 0);
        post.viewCount = Number(metric.view_count || 0);
        post.trendingScore = Number(metric.trending_score || 0);
        post.mediaItems = mediaByPost.get(post.id) || (
          post.media_url
            ? [{
                media_url: post.media_url,
                media_path: post.media_path,
                media_type: post.media_type,
                sort_order: 0
              }]
            : []
        );
      });
    }

    renderPosts();
  } catch (error) {
    if (sequence !== loadSequence) return;
    elements.feed.replaceChildren();
    const failed = document.createElement('div');
    failed.className = 'panel feed-empty';
    failed.textContent = `Không thể tải diễn đàn: ${humanizeAuthError(error)}`;
    elements.feed.appendChild(failed);
    elements.feedCount.textContent = 'Có lỗi';
  }
}

function updatePostStats(card, post) {
  const stats = card.querySelector('.post-stats');
  const left = document.createElement('span');
  const popularReactions = Object.entries(post.reactionCounts || {})
    .filter(([, count]) => count > 0)
    .sort((first, second) => second[1] - first[1])
    .slice(0, 3)
    .map(([type]) => REACTIONS[type]?.emoji)
    .join('');
  left.textContent = `${popularReactions ? `${popularReactions} ` : ''}`
    + `${post.reactionCount || 0} cảm xúc · ${post.viewCount || 0} lượt xem`;
  const right = document.createElement('span');
  right.textContent = `${post.commentCount || 0} bình luận · ${post.shareCount || 0} lượt chia sẻ`;
  stats.replaceChildren(left, right);

  const reactionButton = card.querySelector('.reaction-main');
  const reaction = REACTIONS[post.myReaction] || REACTIONS.like;
  reactionButton.querySelector('[data-reaction-icon]').textContent =
    post.myReaction ? reaction.emoji : '♡';
  reactionButton.querySelector('[data-reaction-label]').textContent =
    post.myReaction ? reaction.label : 'Cảm xúc';
  reactionButton.classList.toggle('reacted', Boolean(post.myReaction));
  reactionButton.dataset.reaction = post.myReaction || '';
}

function chip(text, className = '') {
  const item = document.createElement('span');
  item.className = `post-chip ${className}`.trim();
  item.textContent = text;
  return item;
}

function mediaUrl(item) {
  return item?.media_url || item?.url || '';
}

function openMediaLightbox(items, startIndex = 0) {
  const item = items[startIndex];
  if (!item) return;
  elements.mediaLightboxContent.replaceChildren();
  const contentTag = item.media_type === 'video'
    ? 'video'
    : item.media_type === 'audio'
      ? 'audio'
      : 'img';
  const content = document.createElement(contentTag);
  content.src = mediaUrl(item);
  if (item.media_type === 'video' || item.media_type === 'audio') {
    content.controls = true;
    content.autoplay = true;
  } else {
    content.alt = `Ảnh ${startIndex + 1} trên ${items.length}`;
  }
  elements.mediaLightboxContent.appendChild(content);

  if (items.length > 1) {
    const navigation = document.createElement('div');
    navigation.className = 'lightbox-navigation';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.textContent = '‹';
    previous.setAttribute('aria-label', 'Media trước');
    previous.addEventListener('click', () => {
      openMediaLightbox(items, (startIndex - 1 + items.length) % items.length);
    });
    const position = document.createElement('span');
    position.textContent = `${startIndex + 1} / ${items.length}`;
    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = '›';
    next.setAttribute('aria-label', 'Media sau');
    next.addEventListener('click', () => {
      openMediaLightbox(items, (startIndex + 1) % items.length);
    });
    navigation.append(previous, position, next);
    elements.mediaLightboxContent.appendChild(navigation);
  }

  if (!elements.mediaLightbox.open) {
    if (typeof elements.mediaLightbox.showModal === 'function') {
      elements.mediaLightbox.showModal();
    } else {
      elements.mediaLightbox.setAttribute('open', '');
    }
  }
}

function closeMediaLightbox() {
  elements.mediaLightboxContent
    .querySelectorAll('video,audio')
    .forEach(media => media.pause());
  elements.mediaLightboxContent.replaceChildren();
  if (typeof elements.mediaLightbox.close === 'function') {
    elements.mediaLightbox.close();
  } else {
    elements.mediaLightbox.removeAttribute('open');
  }
}

function renderMediaGallery(container, items, label, compact = false) {
  container.replaceChildren();
  if (!items?.length) return;
  const visibleItems = items.slice(0, 5);
  [...container.classList]
    .filter(className => className.startsWith('count-'))
    .forEach(className => container.classList.remove(className));
  container.classList.add('media-gallery', `count-${Math.min(visibleItems.length, 5)}`);
  container.classList.toggle('compact', compact);
  container.classList.toggle(
    'has-audio',
    visibleItems.some(item => item.media_type === 'audio')
  );
  visibleItems.forEach((item, index) => {
    const isAudio = item.media_type === 'audio';
    const tile = document.createElement(isAudio ? 'div' : 'button');
    if (!isAudio) tile.type = 'button';
    tile.className = 'media-tile';
    tile.classList.toggle('is-audio', isAudio);
    tile.setAttribute(
      'aria-label',
      isAudio ? `Âm thanh ${index + 1} của ${label}` : `Mở media ${index + 1} của ${label}`
    );
    const contentTag = item.media_type === 'video'
      ? 'video'
      : isAudio
        ? 'audio'
        : 'img';
    const content = document.createElement(contentTag);
    content.src = mediaUrl(item);
    if (item.media_type === 'video') {
      content.muted = true;
      content.preload = 'metadata';
      content.playsInline = true;
      const play = document.createElement('span');
      play.className = 'media-play';
      play.textContent = '▶';
      tile.append(content, play);
    } else if (isAudio) {
      content.controls = true;
      content.preload = 'metadata';
      tile.appendChild(content);
    } else {
      content.alt = `Ảnh ${index + 1} của ${label}`;
      content.loading = 'lazy';
      tile.appendChild(content);
    }
    if (index === 4 && items.length > 5) {
      const more = document.createElement(isAudio ? 'button' : 'span');
      if (isAudio) {
        more.type = 'button';
        more.setAttribute('aria-label', `Mở thêm ${items.length - 5} media`);
        more.addEventListener('click', () => openMediaLightbox(items, index + 1));
      }
      more.className = 'media-more';
      more.textContent = `+${items.length - 5}`;
      tile.appendChild(more);
    }
    if (!isAudio) {
      tile.addEventListener('click', () => openMediaLightbox(items, index));
    }
    container.appendChild(tile);
  });
}

function renderPost(post) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector('.post-card');
  card.dataset.postId = post.id;
  const author = authorOf(post) || {};
  const authorUrl = publicProfileUrl(author);
  const avatar = card.querySelector('.post-avatar');
  avatar.src = author.avatar_url || 'avatar.png';
  avatar.alt = `Hồ sơ của ${profileName(author)}`;
  const avatarLink = card.querySelector('.post-avatar-link');
  const authorLink = card.querySelector('.post-author-link');
  avatarLink.href = authorUrl;
  authorLink.href = authorUrl;
  avatarLink.setAttribute('aria-label', `Xem hồ sơ của ${profileName(author)}`);
  authorLink.setAttribute('aria-label', `Xem hồ sơ của ${profileName(author)}`);
  card.querySelector('.post-author strong').textContent = profileName(author);
  card.querySelector('.post-role').textContent = roleLabel(author.role || 'member');
  card.querySelector('.post-username').textContent = `@${author.username || 'thanhvien'}`;
  const time = card.querySelector('time');
  time.dateTime = post.created_at;
  time.textContent = relativeTime(post.created_at);
  time.title = new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(post.created_at));

  const meta = card.querySelector('.post-meta');
  meta.append(chip(post.category === 'question' ? 'Hỏi đáp' : 'Giải trí'));
  if (post.is_pinned) meta.append(chip('📌 Đã ghim', 'pinned'));
  if (post.moderation_status === 'pending_review') {
    meta.append(chip('Đang chờ duyệt', 'pending'));
  } else if (post.moderation_status === 'rejected') {
    meta.append(chip('Không được duyệt', 'rejected'));
  }
  if (post.category === 'question') {
    meta.append(
      chip(SUBJECT_LABELS[post.subject] || 'Môn khác'),
      chip(GRADE_LABELS[post.grade] || 'Khối khác'),
      chip(post.is_solved ? 'Đã giải' : 'Chưa giải', post.is_solved ? 'solved' : 'unsolved')
    );
    if (
      !post.is_solved
      && canInteract()
      && (post.author_id === session.user.id || canModerate())
    ) {
      const solve = document.createElement('button');
      solve.type = 'button';
      solve.className = 'solve-button';
      solve.textContent = '✓ Đánh dấu đã giải';
      solve.addEventListener('click', () => markSolved(post, card, solve));
      meta.appendChild(solve);
    }
  }
  if (post.expires_at && !post.is_pinned) {
    const expiry = chip(`Tự xóa ${relativeTime(post.expires_at)}`, 'expiry');
    expiry.title = new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(post.expires_at));
    meta.append(expiry);
  }

  if (post.moderation_status === 'pending_review') {
    const moderationNote = document.createElement('div');
    moderationNote.className = 'moderation-note';
    moderationNote.textContent = post.moderation_reason
      || 'Bài viết đang chờ quản trị viên xem xét.';
    card.querySelector('.post-header').after(moderationNote);
    if (canModerate()) {
      const controls = document.createElement('div');
      controls.className = 'moderation-actions';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'button button-small';
      approve.textContent = 'Duyệt bài';
      approve.addEventListener('click', () => reviewPost(post, 'approve', approve));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'button button-small button-danger';
      reject.textContent = 'Từ chối';
      reject.addEventListener('click', () => reviewPost(post, 'reject', reject));
      controls.append(approve, reject);
      moderationNote.after(controls);
    }
  }

  card.querySelector('.post-title').textContent = post.title;
  card.querySelector('.post-body').textContent = post.body || '';
  const hashtags = card.querySelector('.post-hashtags');
  (post.hashtags || []).forEach(value => {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.textContent = `#${value}`;
    tag.addEventListener('click', () => {
      elements.search.value = `#${value}`;
      renderPosts();
      elements.search.focus();
      elements.search.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    hashtags.appendChild(tag);
  });

  renderMediaGallery(
    card.querySelector('.post-media'),
    post.mediaItems,
    profileName(author)
  );

  updatePostStats(card, post);
  const reactionAction = card.querySelector('.reaction-action');
  const reactionButton = card.querySelector('.reaction-main');
  reactionButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    toggleReactionPicker(reactionAction);
  });
  card.querySelectorAll('.reaction-picker [data-reaction]').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await setReaction(post, button.dataset.reaction, card, button);
      closeReactionPicker(reactionAction);
    });
  });
  card.querySelector('[data-action="comment"]')
    .addEventListener('click', () => toggleComments(post, card));
  card.querySelector('[data-action="share"]')
    .addEventListener('click', () => sharePost(post, card));
  const reportButton = card.querySelector('[data-action="report"]');
  reportButton.hidden = !canInteract() || post.author_id === session.user.id;
  reportButton.addEventListener('click', () => openReportDialog(post));

  const menu = card.querySelector('.post-menu-button');
  const mayDelete = canInteract() && (post.author_id === session.user.id || canModerate());
  menu.hidden = !mayDelete;
  if (mayDelete) {
    menu.setAttribute('aria-label', 'Xóa bài viết');
    menu.title = 'Xóa bài viết';
    menu.addEventListener('click', () => deletePost(post, card, menu));
  }

  const commentForm = card.querySelector('.comment-form');
  commentForm.querySelector('img').src = currentProfile.avatar_url || 'avatar.png';
  commentForm.hidden = !canInteract();
  const commentMediaInput = commentForm.querySelector('.comment-media-input');
  commentMediaInput.addEventListener('change', () => {
    const task = showCommentMediaPreview(commentForm, commentMediaInput.files);
    commentPreparePromises.set(commentForm, task);
  });
  const limits = currentMediaLimits();
  card.querySelector('.comment-media-note').textContent =
    `${limits.maxImages} ảnh · ${limits.maxVideos} video · ${limits.maxAudios} âm thanh · `
    + `${limits.qualityLabel} · video 3 phút · âm thanh 10 phút`;
  commentForm.addEventListener('submit', event => addComment(event, post, card));
  observePostView(card, post);
  return fragment;
}

function renderPosts() {
  const visible = visiblePosts();
  commentPreparedFiles.forEach(items => releasePreparedItems(items));
  commentPreviewUrls.clear();
  commentPreparedFiles.clear();
  commentPreparePromises.clear();
  commentPrepareSequences.clear();
  postViewObserver?.disconnect();
  elements.feed.replaceChildren();
  elements.feedCount.textContent = `${visible.length} bài viết`;
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'panel feed-empty';
    empty.textContent = elements.search.value.trim()
      ? 'Không tìm thấy bài viết hoặc hashtag phù hợp.'
      : currentCategory === 'question'
        ? 'Chưa có câu hỏi phù hợp. Hãy là người đăng bài đầu tiên.'
        : 'Bảng tin chưa có bài viết. Hãy chia sẻ điều thú vị đầu tiên.';
    elements.feed.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  visible.forEach(post => fragment.appendChild(renderPost(post)));
  elements.feed.appendChild(fragment);

  const targetId = new URLSearchParams(window.location.search).get('post');
  if (targetId) {
    window.setTimeout(() => {
      elements.feed.querySelector(`[data-post-id="${CSS.escape(targetId)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }
}

async function markSolved(post, card, button) {
  const maySolve = canInteract()
    && (post.author_id === session.user.id || canModerate());
  if (!maySolve) {
    setInfo('Chỉ chủ bài viết hoặc quản trị viên mới được đánh dấu đã giải.', 'error');
    return;
  }
  setBusy(button, true, 'Đang lưu...');
  try {
    const { data, error } = await supabase.rpc('mark_forum_post_solved', {
      target_post_id: post.id
    });
    if (error) throw error;
    if (!data) throw new Error('Bạn không có quyền thay đổi trạng thái bài viết này.');
    post.is_solved = true;
    setInfo('Đã đánh dấu câu hỏi là đã giải.', 'success');
    await loadPosts();
  } catch (error) {
    setInfo(`Không thể cập nhật: ${humanizeAuthError(error)}`, 'error');
    setBusy(button, false);
  }
}

async function reviewPost(post, action, button) {
  if (!canModerate()) {
    setInfo('Chỉ điều hành viên hoặc quản trị viên được duyệt bài.', 'error');
    return;
  }
  const note = action === 'reject'
    ? window.prompt('Lý do từ chối bài viết:', post.moderation_reason || '')
    : '';
  if (action === 'reject' && note === null) return;
  setBusy(button, true, action === 'approve' ? 'Đang duyệt...' : 'Đang từ chối...');
  try {
    const { data, error } = await supabase.rpc('review_forum_post', {
      target_post_id: post.id,
      review_action: action,
      review_note: note || null
    });
    if (error) throw error;
    if (!data) throw new Error('Không tìm thấy bài viết cần duyệt.');
    setInfo(
      action === 'approve' ? 'Đã duyệt bài viết.' : 'Đã từ chối bài viết.',
      'success'
    );
    await loadPosts();
  } catch (error) {
    setInfo(`Không thể duyệt bài: ${humanizeAuthError(error)}`, 'error');
    setBusy(button, false);
  }
}

async function setReaction(post, type, card, button) {
  if (!canInteract()) {
    setInfo('Tài khoản đang tạm khóa nên chưa thể bày tỏ cảm xúc.', 'error');
    return;
  }
  if (!REACTIONS[type]) return;
  const previous = post.myReaction;
  const shouldRemove = previous === type;
  button.disabled = true;
  try {
    const query = shouldRemove
      ? supabase
          .from('forum_reactions')
          .delete()
          .eq('post_id', post.id)
          .eq('user_id', session.user.id)
      : supabase
          .from('forum_reactions')
          .upsert({
            post_id: post.id,
            user_id: session.user.id,
            reaction_type: type,
            updated_at: new Date().toISOString()
          }, { onConflict: 'post_id,user_id' });
    const { error } = await query;
    if (error) throw error;

    if (previous) {
      post.reactionCounts[previous] = Math.max(
        0,
        (post.reactionCounts[previous] || 0) - 1
      );
    }
    if (shouldRemove) {
      post.myReaction = '';
      post.reactionCount = Math.max(0, post.reactionCount - 1);
    } else {
      post.myReaction = type;
      post.reactionCounts[type] = (post.reactionCounts[type] || 0) + 1;
      if (!previous) post.reactionCount += 1;
    }
    updatePostStats(card, post);
  } catch (error) {
    setInfo(`Không thể cập nhật cảm xúc: ${humanizeAuthError(error)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function registerPostView(post, card) {
  if (registeredViews.has(post.id)) return;
  registeredViews.add(post.id);
  try {
    const { data, error } = await supabase.rpc('register_forum_post_view', {
      target_post_id: post.id
    });
    if (error) throw error;
    if (data) {
      post.viewCount += 1;
      updatePostStats(card, post);
    }
  } catch {
    registeredViews.delete(post.id);
  }
}

let postViewObserver;

function observePostView(card, post) {
  if (!('IntersectionObserver' in window)) {
    window.setTimeout(() => registerPostView(post, card), 800);
    return;
  }
  if (!postViewObserver) {
    postViewObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.45) return;
        const target = entry.target;
        postViewObserver.unobserve(target);
        const record = posts.find(item => item.id === target.dataset.postId);
        if (record) registerPostView(record, target);
      });
    }, { threshold: [0.45] });
  }
  postViewObserver.observe(card);
}

async function toggleComments(post, card) {
  const panel = card.querySelector('.comment-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden && !panel.dataset.loaded) {
    await loadComments(post, card);
  }
}

function resetCommentMedia(form) {
  commentPrepareSequences.set(form, (commentPrepareSequences.get(form) || 0) + 1);
  const preparedItems = commentPreparedFiles.get(form) || [];
  releasePreparedItems(preparedItems);
  commentPreviewUrls.delete(form);
  commentPreparedFiles.delete(form);
  commentPreparePromises.delete(form);
  const input = form.querySelector('.comment-media-input');
  const preview = form.querySelector('.comment-media-preview');
  input.value = '';
  preview.replaceChildren();
  preview.hidden = true;
}

function renderCommentSelectionPreview(form) {
  const items = commentPreparedFiles.get(form) || [];
  const preview = form.querySelector('.comment-media-preview');
  renderPreparedPreview(preview, items, index => {
    const [removed] = items.splice(index, 1);
    releasePreparedItems([removed]);
    commentPreparedFiles.set(form, items);
    commentPreviewUrls.set(form, items.map(item => item.previewUrl));
    renderCommentSelectionPreview(form);
    if (!items.length) form.querySelector('.comment-media-input').value = '';
  });
}

async function showCommentMediaPreview(form, fileList) {
  resetCommentMedia(form);
  if (!fileList?.length) return;
  const sequence = commentPrepareSequences.get(form);
  try {
    setInfo('Đang xử lý media bình luận...', 'info');
    const items = await prepareSelectedFiles(
      fileList,
      () => sequence === commentPrepareSequences.get(form)
    );
    if (sequence !== commentPrepareSequences.get(form)) return;
    commentPreparedFiles.set(form, items);
    commentPreviewUrls.set(form, items.map(item => item.previewUrl));
    renderCommentSelectionPreview(form);
    setInfo(`Đã chuẩn bị ${items.length} tệp cho bình luận.`, 'success');
  } catch (error) {
    if (sequence !== commentPrepareSequences.get(form)) return;
    setInfo(error.message, 'error');
  }
}

async function loadComments(post, card) {
  const list = card.querySelector('.comment-list');
  list.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'comment-empty';
  loading.textContent = 'Đang tải bình luận...';
  list.appendChild(loading);
  try {
    const { data, error } = await supabase
      .from('forum_comments')
      .select(`
        id,
        post_id,
        author_id,
        body,
        media_url,
        media_path,
        media_type,
        created_at,
        author:profiles!forum_comments_author_id_fkey(
          username,
          display_name,
          avatar_url,
          role
        )
      `)
      .eq('post_id', post.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const comments = data || [];
    if (comments.length) {
      const { data: mediaRows, error: mediaError } = await supabase
        .from('forum_comment_media')
        .select(`
          id,
          comment_id,
          media_url,
          media_path,
          media_type,
          sort_order,
          size_bytes,
          width,
          height,
          duration_seconds
        `)
        .in('comment_id', comments.map(comment => comment.id))
        .order('sort_order', { ascending: true });
      if (mediaError) throw mediaError;
      const groupedMedia = (mediaRows || []).reduce((map, row) => {
        const values = map.get(row.comment_id) || [];
        values.push(row);
        map.set(row.comment_id, values);
        return map;
      }, new Map());
      comments.forEach(comment => {
        comment.mediaItems = groupedMedia.get(comment.id) || (
          comment.media_url
            ? [{
                media_url: comment.media_url,
                media_path: comment.media_path,
                media_type: comment.media_type,
                sort_order: 0
              }]
            : []
        );
      });
    }
    renderComments(comments, post, card);
    card.querySelector('.comment-panel').dataset.loaded = 'true';
  } catch (error) {
    loading.textContent = `Không thể tải bình luận: ${humanizeAuthError(error)}`;
  }
}

function renderComments(comments, post, card) {
  const list = card.querySelector('.comment-list');
  list.replaceChildren();
  if (!comments.length) {
    const empty = document.createElement('div');
    empty.className = 'comment-empty';
    empty.textContent = 'Chưa có bình luận. Hãy bắt đầu cuộc trò chuyện.';
    list.appendChild(empty);
    return;
  }

  comments.forEach(comment => {
    const author = authorOf(comment) || {};
    const item = document.createElement('article');
    item.className = 'comment-item';
    const avatar = document.createElement('img');
    avatar.src = author.avatar_url || 'avatar.png';
    avatar.alt = `Hồ sơ của ${profileName(author)}`;
    const avatarLink = document.createElement('a');
    avatarLink.className = 'comment-profile-link';
    avatarLink.href = publicProfileUrl(author);
    avatarLink.appendChild(avatar);
    const bubble = document.createElement('div');
    bubble.className = 'comment-bubble';
    const authorLine = document.createElement('div');
    authorLine.className = 'comment-author-line';
    const name = document.createElement('strong');
    name.textContent = profileName(author);
    const nameLink = document.createElement('a');
    nameLink.className = 'comment-profile-link';
    nameLink.href = publicProfileUrl(author);
    nameLink.appendChild(name);
    const role = document.createElement('span');
    role.className = 'comment-role';
    role.textContent = roleLabel(author.role || 'member');
    authorLine.append(nameLink, role);
    const body = document.createElement('p');
    body.textContent = comment.body || '';
    const time = document.createElement('time');
    time.dateTime = comment.created_at;
    time.textContent = relativeTime(comment.created_at);
    bubble.append(authorLine, body);
    if (comment.mediaItems?.length) {
      const media = document.createElement('div');
      media.className = 'comment-media-gallery';
      renderMediaGallery(media, comment.mediaItems, profileName(author), true);
      bubble.appendChild(media);
    }
    bubble.appendChild(time);
    item.append(avatarLink, bubble);

    if (canInteract() && (comment.author_id === session.user.id || canModerate())) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comment-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Xóa bình luận');
      remove.addEventListener('click', async () => {
        if (!window.confirm('Xóa bình luận này?')) return;
        remove.disabled = true;
        const { error } = await supabase.from('forum_comments').delete().eq('id', comment.id);
        if (error) {
          remove.disabled = false;
          setInfo(`Không thể xóa bình luận: ${humanizeAuthError(error)}`, 'error');
          return;
        }
        const paths = new Set(
          [
            comment.media_path,
            ...(comment.mediaItems || []).map(item => item.media_path)
          ].filter(Boolean)
        );
        await Promise.allSettled(
          [...paths].map(path => removeStoredMedia(path, 'forum-comment-media'))
        );
        post.commentCount = Math.max(0, post.commentCount - 1);
        updatePostStats(card, post);
        await loadComments(post, card);
      });
      item.appendChild(remove);
    }
    list.appendChild(item);
  });
}

async function addComment(event, post, card) {
  event.preventDefault();
  if (!canInteract()) return;
  const form = event.currentTarget;
  await commentPreparePromises.get(form);
  const input = form.querySelector('.comment-input');
  const button = form.querySelector('.comment-submit');
  const body = input.value.trim();
  const mediaItems = commentPreparedFiles.get(form) || [];
  if (!body && !mediaItems.length) return;
  let uploaded = [];
  let createdCommentId = '';
  setBusy(button, true, '...');
  try {
    uploaded = await uploadPreparedMediaList(mediaItems, {
      scope: 'comment',
      postId: post.id
    });
    const firstMedia = uploaded[0];
    const { data: createdComment, error } = await supabase
      .from('forum_comments')
      .insert({
        post_id: post.id,
        author_id: session.user.id,
        body: body || null,
        media_url: firstMedia?.url || null,
        media_path: firstMedia?.path || null,
        media_type: firstMedia?.type || null
      })
      .select('id')
      .single();
    if (error) throw error;
    createdCommentId = createdComment.id;

    if (uploaded.length) {
      const { error: mediaError } = await supabase
        .from('forum_comment_media')
        .insert(uploaded.map((item, index) => ({
          comment_id: createdCommentId,
          uploader_id: session.user.id,
          media_url: item.url,
          media_path: item.path,
          media_type: item.type,
          sort_order: index,
          size_bytes: item.size_bytes,
          width: item.width,
          height: item.height,
          duration_seconds: item.duration_seconds
        })));
      if (mediaError) throw mediaError;
    }

    input.value = '';
    resetCommentMedia(form);
    post.commentCount += 1;
    updatePostStats(card, post);
    await loadComments(post, card);
  } catch (error) {
    if (createdCommentId) {
      await supabase.from('forum_comments').delete().eq('id', createdCommentId);
    }
    await Promise.allSettled(
      uploaded.map(item => removeStoredMedia(item.path, 'forum-comment-media'))
    );
    setInfo(`Không thể gửi bình luận: ${humanizeAuthError(error)}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function registerShare(post, card) {
  const { error } = await supabase.from('forum_shares').insert({
    post_id: post.id,
    user_id: session.user.id
  });
  if (!error) {
    post.shareCount += 1;
    updatePostStats(card, post);
  } else if (error.code !== '23505') {
    throw error;
  }
}

async function sharePost(post, card) {
  if (!canInteract()) {
    setInfo('Tài khoản đang tạm khóa nên chưa thể chia sẻ bài viết.', 'error');
    return;
  }
  const url = `${pageUrl('forum.html')}?post=${encodeURIComponent(post.id)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: post.title, text: post.title, url });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      setInfo('Đã sao chép liên kết bài viết.', 'success');
    } else {
      window.prompt('Sao chép liên kết bài viết:', url);
    }
    await registerShare(post, card);
  } catch (error) {
    if (error?.name !== 'AbortError') {
      setInfo(`Không thể chia sẻ: ${humanizeAuthError(error)}`, 'error');
    }
  }
}

function openReportDialog(post) {
  if (!canInteract() || post.author_id === session.user.id) return;
  reportingPost = post;
  elements.reportForm.reset();
  if (typeof elements.reportDialog.showModal === 'function') {
    elements.reportDialog.showModal();
  } else {
    elements.reportDialog.setAttribute('open', '');
  }
  window.setTimeout(() => elements.reportReason.focus(), 30);
}

function closeReportDialog() {
  reportingPost = null;
  if (typeof elements.reportDialog.close === 'function') {
    elements.reportDialog.close();
  } else {
    elements.reportDialog.removeAttribute('open');
  }
}

async function submitReport(event) {
  event.preventDefault();
  if (!reportingPost) return;
  setBusy(elements.submitReport, true, 'Đang gửi...');
  try {
    const { error } = await supabase.from('forum_reports').insert({
      post_id: reportingPost.id,
      reporter_id: session.user.id,
      reason: elements.reportReason.value,
      details: elements.reportDetails.value.trim() || null
    });
    if (error) {
      if (error.code === '23505') {
        throw new Error('Bạn đã báo cáo bài viết này trước đó.');
      }
      throw error;
    }
    closeReportDialog();
    setInfo(
      'Đã gửi báo cáo. Khi bài nhận đủ báo cáo, hệ thống sẽ chuyển bài vào hàng chờ duyệt.',
      'success'
    );
  } catch (error) {
    setInfo(`Không thể gửi báo cáo: ${humanizeAuthError(error)}`, 'error');
  } finally {
    setBusy(elements.submitReport, false);
  }
}

async function deletePost(post, card, button) {
  if (!window.confirm('Bạn chắc chắn muốn xóa bài viết này?')) return;
  setBusy(button, true, '...');
  try {
    const { data: commentMedia, error: commentMediaError } = await supabase
      .from('forum_comments')
      .select('id, media_path')
      .eq('post_id', post.id)
      .limit(1000);
    if (commentMediaError) throw commentMediaError;

    const commentIds = (commentMedia || []).map(item => item.id);
    let commentMediaRows = [];
    if (commentIds.length) {
      const { data, error } = await supabase
        .from('forum_comment_media')
        .select('media_path')
        .in('comment_id', commentIds);
      if (error) throw error;
      commentMediaRows = data || [];
    }

    const { data: postMediaRows, error: postMediaError } = await supabase
      .from('forum_post_media')
      .select('media_path')
      .eq('post_id', post.id);
    if (postMediaError) throw postMediaError;

    const commentPaths = new Set([
      ...(commentMedia || []).map(item => item.media_path),
      ...commentMediaRows.map(item => item.media_path)
    ].filter(Boolean));
    const postPaths = new Set([
      post.media_path,
      ...(postMediaRows || []).map(item => item.media_path)
    ].filter(Boolean));

    await Promise.allSettled([
      ...[...commentPaths].map(path => removeStoredMedia(path, 'forum-comment-media')),
      ...[...postPaths].map(path => removeStoredMedia(path, 'forum-media'))
    ]);

    const { error } = await supabase.from('forum_posts').delete().eq('id', post.id);
    if (error) throw error;
    posts = posts.filter(item => item.id !== post.id);
    card.remove();
    renderPosts();
    setInfo('Đã xóa bài viết.', 'success');
  } catch (error) {
    setBusy(button, false);
    setInfo(`Không thể xóa bài viết: ${humanizeAuthError(error)}`, 'error');
  }
}

async function removeStoredMedia(path, legacyBucket) {
  if (!path) return;
  const r2Path = /^(post|comment)\//u.test(path);
  if (r2Path && r2Enabled()) {
    await deleteFromR2(session, path);
    return;
  }
  const { error } = await supabase.storage.from(legacyBucket).remove([path]);
  if (error) throw error;
}

function configureAccount() {
  const name = profileName(currentProfile, session.user);
  const limits = currentMediaLimits();
  elements.viewer.querySelector('span:last-child').textContent =
    `${name} · ${roleLabel(currentProfile.role)} · ${statusLabel(currentProfile.account_status)}`;
  elements.composerName.textContent = name;
  elements.composerAvatar.src =
    currentProfile.avatar_url || session.user.user_metadata?.avatar_url || 'avatar.png';
  elements.readonly.hidden = canInteract();
  elements.openComposer.hidden = !canInteract();
  elements.moderationFilter.hidden = !canModerate();
  elements.mediaLimitNote.textContent =
    `${limits.maxImages} ảnh · ${limits.maxVideos} video · ${limits.maxAudios} âm thanh · `
    + `${limits.qualityLabel} · `
    + `ảnh ${(limits.imageBytes / 1024 / 1024).toFixed(1)} MB · `
    + `video ${Math.round(limits.videoBytes / 1024 / 1024)} MB · `
    + `âm thanh ${Math.round(limits.audioBytes / 1024 / 1024)} MB`;
}

async function init() {
  try {
    session = await requireSession();
    if (!session) return;
    currentProfile = await getProfile(session.user.id);
    if (currentProfile.account_status === 'banned') {
      elements.viewer.querySelector('span:last-child').textContent = 'Tài khoản bị cấm';
      elements.denied.hidden = false;
      return;
    }

    configureAccount();
    await refreshPostCooldown();
    postCooldownTimer = window.setInterval(updatePostCooldownUi, 1000);
    updateCategoryUi();
    elements.app.hidden = false;
    await loadPosts();
  } catch (error) {
    setInfo(`Không thể mở diễn đàn: ${humanizeAuthError(error)}`, 'error');
  }
}

elements.tabs.forEach(tab => {
  tab.addEventListener('click', async () => {
    if (tab.dataset.category === currentCategory) return;
    currentCategory = tab.dataset.category;
    updateCategoryUi();
    await loadPosts();
  });
});
elements.form.addEventListener('submit', publishPost);
elements.media.addEventListener('change', () => {
  previewPreparePromise = showMediaPreview(elements.media.files);
});
elements.openComposer.addEventListener('click', openComposer);
elements.closeComposer.addEventListener('click', closeComposer);
elements.composerDialog.addEventListener('click', event => {
  if (event.target === elements.composerDialog) closeComposer();
});
elements.composerDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeComposer();
});
elements.search.addEventListener('input', renderPosts);
elements.sortButtons.forEach(button => {
  button.addEventListener('click', () => {
    currentSort = button.dataset.sort;
    elements.sortButtons.forEach(item => item.classList.toggle('active', item === button));
    updateCategoryUi();
    renderPosts();
  });
});
elements.gradeFilter.addEventListener('change', loadPosts);
elements.statusFilter.addEventListener('change', loadPosts);
elements.moderationFilter.addEventListener('change', loadPosts);
elements.closeMediaLightbox.addEventListener('click', closeMediaLightbox);
elements.mediaLightbox.addEventListener('click', event => {
  if (event.target === elements.mediaLightbox) closeMediaLightbox();
});
elements.mediaLightbox.addEventListener('cancel', event => {
  event.preventDefault();
  closeMediaLightbox();
});
elements.reportForm.addEventListener('submit', submitReport);
elements.closeReportDialog.addEventListener('click', closeReportDialog);
elements.reportDialog.addEventListener('click', event => {
  if (event.target === elements.reportDialog) closeReportDialog();
});
elements.reportDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeReportDialog();
});
document.addEventListener('click', event => {
  if (openReactionAction && !openReactionAction.contains(event.target)) {
    closeReactionPicker();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeReactionPicker();
});
window.addEventListener('beforeunload', () => {
  window.clearInterval(postCooldownTimer);
  releasePreparedItems(selectedPostMedia);
  commentPreviewUrls.forEach(urls => urls.forEach(url => URL.revokeObjectURL(url)));
});

init();
