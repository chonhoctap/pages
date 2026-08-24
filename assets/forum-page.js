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
} from './supabase-client.js?v=20260801-7';
import {
  r2Enabled,
  prepareMedia,
  mediaMetadata,
  mediaLimitsForRole,
  uploadToR2,
  uploadToSupabaseResumable,
  deleteFromR2
} from './media-storage.js?v=20260824-4';

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
  postProgress: document.getElementById('postProgress'),
  postProgressTitle: document.getElementById('postProgressTitle'),
  postProgressStage: document.getElementById('postProgressStage'),
  postProgressBar: document.getElementById('postProgressBar'),
  postProgressPercent: document.getElementById('postProgressPercent'),
  postProgressEta: document.getElementById('postProgressEta'),
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
  submitReport: document.getElementById('submitReport'),
  notificationButton: document.getElementById('notificationButton'),
  notificationBadge: document.getElementById('notificationBadge'),
  notificationPanel: document.getElementById('notificationPanel'),
  notificationList: document.getElementById('notificationList'),
  markAllRead: document.getElementById('markAllReadButton'),
  reactionListDialog: document.getElementById('reactionListDialog'),
  reactionListSummary: document.getElementById('reactionListSummary'),
  reactionListFilters: document.getElementById('reactionListFilters'),
  reactionList: document.getElementById('reactionList'),
  closeReactionList: document.getElementById('closeReactionList')
};

let session;
let currentProfile;
let forumPermissions = new Set();
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
let postCooldownSyncTimer = 0;
let postCooldownRefreshPromise = null;
let commentCooldownUntil = 0;
let commentCooldownTimer = 0;
let notificationTimer = 0;
let notificationRealtimeTimer = 0;
let realtimeChannel = null;
let realtimeReloadTimer = 0;
const commentPreviewUrls = new Map();
const commentPreparedFiles = new Map();
const commentPrepareSequences = new Map();
const commentPreparePromises = new Map();
const registeredViews = new Set();
let openReactionAction = null;
let editingPost = null;
const replyingToByForm = new Map();
const reactionPendingPosts = new Set();
let reactionListRows = [];
let activeReactionListFilter = 'all';
let activeLightboxItems = [];
let activeLightboxIndex = 0;
let activeLightboxZoomControls = null;
let activeLightboxCleanup = null;
let postProgressState = null;
let postProgressTimer = 0;
let postProgressHideTimer = 0;

const REACTIONS = {
  like: { emoji: '👍', label: 'Thích' },
  love: { emoji: '❤️', label: 'Yêu thích' },
  haha: { emoji: '😆', label: 'Haha' },
  wow: { emoji: '😮', label: 'Wow' },
  sad: { emoji: '😢', label: 'Buồn' },
  angry: { emoji: '😡', label: 'Phẫn nộ' }
};

const POST_COOLDOWN_STORAGE_PREFIX = 'chonhoctap-forum-post-cooldown:';

const FALLBACK_ROLE_PERMISSIONS = {
  member: [
    'forum.access', 'forum.create_post', 'forum.create_comment',
    'forum.react', 'forum.share', 'forum.report'
  ],
  vip: [
    'forum.access', 'forum.create_post', 'forum.create_comment',
    'forum.react', 'forum.share', 'forum.report'
  ],
  moderator: [
    'forum.access', 'forum.create_post', 'forum.create_comment',
    'forum.react', 'forum.share', 'forum.report', 'forum.moderate_posts'
  ],
  admin: [
    'forum.access', 'forum.create_post', 'forum.create_comment',
    'forum.react', 'forum.share', 'forum.report', 'forum.moderate_posts',
    'forum.review_reports', 'forum.delete_any_content'
  ]
};

function hasForumPermission(permissionKey) {
  return forumPermissions.has(permissionKey);
}

async function loadForumPermissions() {
  const { data, error } = await supabase.rpc('get_my_role_permissions');
  if (error) {
    // Giữ website tương thích trong khoảng thời gian code mới vừa lên nhưng
    // migration quyền chưa được chạy. Database vẫn là lớp bảo vệ chính.
    console.warn('Dynamic role permissions unavailable; using role defaults', error);
    forumPermissions = new Set(FALLBACK_ROLE_PERMISSIONS[currentProfile?.role] || []);
    return;
  }
  forumPermissions = new Set(
    (data || []).filter(item => item.allowed).map(item => item.permission_key)
  );
}

function canInteract() {
  return currentProfile?.account_status === 'active';
}

function hasUnlimitedVipPosting() {
  return currentProfile?.role === 'vip';
}

function cooldownSeconds() {
  if (hasUnlimitedVipPosting()) return 0;
  return Math.max(0, Math.ceil((postCooldownUntil - Date.now()) / 1000));
}

function postCooldownStorageKey() {
  return session?.user?.id
    ? `${POST_COOLDOWN_STORAGE_PREFIX}${session.user.id}`
    : '';
}

function storedPostCooldown() {
  const key = postCooldownStorageKey();
  if (!key) return 0;
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > Date.now() ? value : 0;
  } catch {
    return 0;
  }
}

function rememberPostCooldown(until) {
  const key = postCooldownStorageKey();
  if (!key) return;
  try {
    if (until > Date.now()) window.localStorage.setItem(key, String(until));
    else window.localStorage.removeItem(key);
  } catch {
    // Database vẫn là lớp chống spam chính khi trình duyệt chặn localStorage.
  }
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

function commentCooldownSeconds() {
  return Math.max(0, Math.ceil((commentCooldownUntil - Date.now()) / 1000));
}

function updateCommentCooldownUi() {
  const remaining = commentCooldownSeconds();
  document.querySelectorAll('.comment-submit').forEach(button => {
    if (button.getAttribute('aria-busy') === 'true') return;
    if (remaining > 0) {
      if (!button.dataset.cooldownOriginalText) {
        button.dataset.cooldownOriginalText = button.textContent;
      }
      button.textContent = `Gửi sau ${cooldownLabel(remaining)}`;
      button.disabled = true;
      button.dataset.cooldownDisabled = 'true';
    } else if (button.dataset.cooldownDisabled === 'true') {
      button.textContent = button.dataset.cooldownOriginalText || 'Gửi';
      button.disabled = false;
      delete button.dataset.cooldownDisabled;
      delete button.dataset.cooldownOriginalText;
    }
  });
}

async function refreshCommentCooldown() {
  if (!session?.user?.id || !canInteract()) return;
  const { data, error } = await supabase
    .from('forum_comments')
    .select('created_at')
    .eq('author_id', session.user.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const latestAt = data?.[0]?.created_at;
  commentCooldownUntil = latestAt
    ? new Date(latestAt).getTime() + 2 * 60 * 1000
    : 0;
  updateCommentCooldownUi();
}

function refreshPostCooldown() {
  if (!session?.user?.id || !canInteract()) return Promise.resolve();
  if (hasUnlimitedVipPosting()) {
    postCooldownUntil = 0;
    rememberPostCooldown(0);
    updatePostCooldownUi();
    return Promise.resolve();
  }
  if (postCooldownRefreshPromise) return postCooldownRefreshPromise;

  postCooldownRefreshPromise = (async () => {
    const { data: nextPostAt, error: rpcError } = await supabase
      .rpc('get_forum_post_cooldown');

    if (!rpcError) {
      // Supabase là nguồn chính. Khi admin xóa mốc chờ, giá trị NULL phải
      // thắng cache cũ trong localStorage thay vì tiếp tục đếm hết 15 phút.
      postCooldownUntil = nextPostAt ? new Date(nextPostAt).getTime() : 0;
      rememberPostCooldown(postCooldownUntil);
      updatePostCooldownUi();
      return;
    }

    // Chỉ dùng bài mới nhất và localStorage làm phương án dự phòng nếu RPC
    // chưa tồn tại hoặc tạm thời không truy cập được.
    const { data, error } = await supabase
      .from('forum_posts')
      .select('created_at')
      .eq('author_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const latestAt = data?.[0]?.created_at;
    const fallbackCooldownUntil = latestAt
      ? new Date(latestAt).getTime() + 15 * 60 * 1000
      : 0;
    postCooldownUntil = Math.max(fallbackCooldownUntil, storedPostCooldown());
    rememberPostCooldown(postCooldownUntil);
    updatePostCooldownUi();
  })().finally(() => {
    postCooldownRefreshPromise = null;
  });

  return postCooldownRefreshPromise;
}

function syncPostCooldown() {
  if (document.visibilityState === 'hidden') return;
  void refreshPostCooldown().catch(error => {
    console.warn('Không thể đồng bộ thời gian chờ đăng bài', error);
  });
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
  return canInteract() && hasForumPermission('forum.moderate_posts');
}

function isForumAdmin() {
  return canInteract() && currentProfile?.role === 'admin';
}

function canReviewContent() {
  return canModerate();
}

function canReviewComment() {
  return canModerate();
}

function userFacingModerationReason(value, fallback) {
  return String(value || fallback).replace(/Gemini/giu, 'Hệ thống');
}

async function queueHumanReview(targetType, targetId) {
  const { error } = await supabase.rpc('queue_forum_human_review_v13', {
    target_type: targetType,
    target_id: targetId,
    review_reason: 'Không thể hoàn tất kiểm tra tự động; cần Staff hoặc quản trị viên xem xét.'
  });
  if (error) console.warn('Could not queue human review', error);
}

function moderateInBackground(targetType, targetId, onSettled = null, onDecision = null) {
  void (async () => {
    let decision = 'review';
    try {
      const { data, error } = await supabase.functions.invoke('moderate-forum', {
        body: { targetType, targetId }
      });
      if (error) throw error;
      if (data?.decision === 'safe') {
        decision = 'safe';
        setInfo(
          targetType === 'post'
            ? 'Hệ thống đã kiểm tra và công khai bài viết.'
            : 'Hệ thống đã kiểm tra và công khai bình luận.',
          'success'
        );
      } else if (data?.decision === 'violation') {
        decision = 'violation';
        setInfo(
          targetType === 'post'
            ? 'Bài viết vi phạm tiêu chuẩn cộng đồng nên đã bị xóa.'
            : 'Bình luận vi phạm tiêu chuẩn cộng đồng nên đã bị xóa.',
          'error'
        );
      } else if (data?.decision === 'manual') {
        decision = 'manual';
        setInfo('Hệ thống chưa đủ chắc chắn; nội dung đã chuyển cho Staff hoặc quản trị viên.', 'info');
      } else {
        setInfo('Hệ thống chưa đủ chắc chắn; nội dung đã chuyển cho Staff hoặc quản trị viên.', 'info');
      }
    } catch (error) {
      decision = 'manual';
      console.warn('Automatic forum moderation unavailable', error);
      await queueHumanReview(targetType, targetId);
      setInfo(
        'Kiểm tra tự động tạm thời chưa hoàn tất; nội dung đã chuyển cho Staff hoặc quản trị viên.',
        'info'
      );
    } finally {
      if (typeof onDecision === 'function') onDecision(decision);
      if (typeof onSettled === 'function') {
        await onSettled().catch(error => console.warn('Moderation UI refresh failed', error));
      }
    }
  })();
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

function isPostCooldownNotice(value) {
  return /(?:một bài sau mỗi 15\s*phút|15\s*minutes?|one post.*15)/iu
    .test(String(value || ''));
}

function setInfo(message, type = 'info') {
  if (isPostCooldownNotice(message)) {
    showMessage(elements.message, '', 'info');
    return;
  }
  showMessage(elements.message, message, type);
  if (message) elements.message.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function durationLabel(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} phút ${remainder} giây` : `${minutes} phút`;
}

function clearPostProgressTimers() {
  window.clearInterval(postProgressTimer);
  window.clearTimeout(postProgressHideTimer);
  postProgressTimer = 0;
  postProgressHideTimer = 0;
}

function beginPostProgress(title, stage, expectedSeconds = 0) {
  clearPostProgressTimers();
  postProgressState = {
    title,
    stage,
    startedAt: performance.now(),
    expectedSeconds: Math.max(0, expectedSeconds),
    progress: 0
  };
  if (!elements.postProgress) return;
  elements.postProgress.hidden = false;
  elements.postProgress.dataset.status = 'active';
  elements.postProgressTitle.textContent = title;
  elements.postProgressStage.textContent = stage;
  elements.postProgressBar.style.width = '0%';
  elements.postProgressBar.parentElement.setAttribute('aria-valuenow', '0');
  elements.postProgressPercent.textContent = '0%';
  elements.postProgressEta.textContent = expectedSeconds
    ? `Ước tính còn ${durationLabel(expectedSeconds)}`
    : 'Đang tính thời gian còn lại...';
  window.requestAnimationFrame(() => {
    elements.postProgress.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function updatePostProgress(progress, stage = '') {
  if (!postProgressState || !elements.postProgress) return;
  const value = Math.max(0, Math.min(1, Number(progress) || 0));
  postProgressState.progress = value;
  if (stage) {
    postProgressState.stage = stage;
    elements.postProgressStage.textContent = stage;
  }
  const percent = Math.round(value * 100);
  elements.postProgressBar.style.width = `${percent}%`;
  elements.postProgressBar.parentElement.setAttribute('aria-valuenow', String(percent));
  elements.postProgressPercent.textContent = `${percent}%`;
  const elapsedSeconds = (performance.now() - postProgressState.startedAt) / 1000;
  let remaining = 0;
  if (value >= 0.02 && value < 1) {
    remaining = elapsedSeconds * (1 - value) / value;
  } else if (postProgressState.expectedSeconds) {
    remaining = Math.max(0, postProgressState.expectedSeconds - elapsedSeconds);
  }
  elements.postProgressEta.textContent = value >= 1
    ? 'Đang chuyển sang bước tiếp theo...'
    : remaining > 0
      ? `Ước tính còn ${durationLabel(remaining)}`
      : 'Đang tính thời gian còn lại...';
}

function startModerationProgress(mediaItems = []) {
  const videoSeconds = mediaItems
    .filter(item => item.type === 'video')
    .reduce((sum, item) => sum + (Number(item.duration_seconds) || 0), 0);
  const imageCount = mediaItems.filter(item => item.type === 'image').length;
  const hasAudio = mediaItems.some(item => item.type === 'audio');
  const expectedSeconds = hasAudio
    ? 30
    : Math.max(12, Math.min(300, 14 + imageCount * 4 + videoSeconds * 0.45));
  beginPostProgress('Đang kiểm duyệt bài viết', 'Hệ thống đang kiểm tra nội dung...', expectedSeconds);
  postProgressTimer = window.setInterval(() => {
    if (!postProgressState) return;
    const elapsedSeconds = (performance.now() - postProgressState.startedAt) / 1000;
    const progress = Math.min(0.94, elapsedSeconds / expectedSeconds);
    updatePostProgress(progress);
    if (elapsedSeconds > expectedSeconds) {
      elements.postProgressEta.textContent = 'Đang chờ hệ thống phản hồi...';
    }
  }, 1000);
}

function finishPostProgress(message, status = 'success') {
  clearPostProgressTimers();
  if (status === 'error' && isPostCooldownNotice(message)) {
    postProgressState = null;
    if (elements.postProgress) elements.postProgress.hidden = true;
    return;
  }
  if (!elements.postProgress) return;
  if (!postProgressState) beginPostProgress('Tiến trình đăng bài', message);
  postProgressState.progress = 1;
  elements.postProgress.dataset.status = status;
  elements.postProgressStage.textContent = message;
  elements.postProgressBar.style.width = '100%';
  elements.postProgressBar.parentElement.setAttribute('aria-valuenow', '100');
  elements.postProgressPercent.textContent = status === 'error' ? 'Lỗi' : '100%';
  elements.postProgressEta.textContent = status === 'error' ? 'Vui lòng kiểm tra thông báo lỗi.' : 'Đã hoàn tất';
  postProgressHideTimer = window.setTimeout(() => {
    elements.postProgress.hidden = true;
    postProgressState = null;
  }, status === 'error' ? 12000 : 7000);
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

function parseMentions(...values) {
  const matches = values.join(' ').matchAll(/(?:^|\s)@([a-z0-9_]{3,24})\b/giu);
  return [...new Set([...matches].map(match => match[1].toLowerCase()))].slice(0, 20);
}

function renderTextWithMentions(element, value) {
  element.replaceChildren();
  const text = String(value || '');
  let cursor = 0;
  for (const match of text.matchAll(/@([a-z0-9_]{3,24})\b/giu)) {
    element.append(document.createTextNode(text.slice(cursor, match.index)));
    const link = document.createElement('a');
    link.className = 'mention-link';
    link.href = `profile.html?user=${encodeURIComponent(match[1].toLowerCase())}`;
    link.textContent = match[0];
    element.appendChild(link);
    cursor = match.index + match[0].length;
  }
  element.append(document.createTextNode(text.slice(cursor)));
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

function currentMediaLimits(scope = 'post') {
  return mediaLimitsForRole(currentProfile?.role || 'member', scope);
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

function selectionCountError(files, scope = 'post') {
  const limits = currentMediaLimits(scope);
  const imageCount = files.filter(file => mediaKind(file) === 'image').length;
  const videoCount = files.filter(file => mediaKind(file) === 'video').length;
  const audioCount = files.filter(file => mediaKind(file) === 'audio').length;
  if (
    imageCount > limits.maxImages
    || videoCount > limits.maxVideos
    || audioCount > limits.maxAudios
  ) {
    const label = value => Number.isFinite(value) ? value : 'không giới hạn';
    return `Tài khoản ${roleLabel(currentProfile?.role)} được chọn tối đa `
      + `${label(limits.maxImages)} ảnh, ${label(limits.maxVideos)} video và `
      + `${label(limits.maxAudios)} tệp âm thanh.`;
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

async function prepareSelectedFiles(fileList, sequenceCheck, scope = 'post') {
  const sourceFiles = [...(fileList || [])];
  const unsupported = sourceFiles.find(file => !mediaKind(file));
  if (unsupported) {
    throw new Error(
      'Chỉ hỗ trợ ảnh JPG/PNG/WebP/GIF, video MP4/WebM/MOV hoặc âm thanh MP3/M4A/OGG/WebM/WAV.'
    );
  }
  const countError = selectionCountError(sourceFiles, scope);
  if (countError) throw new Error(countError);

  const preparedItems = [];
  try {
    for (const source of sourceFiles) {
      const prepared = await prepareMedia(
        source,
        currentProfile?.role || 'member',
        {
          scope,
          onProgress: progress => {
            if (sequenceCheck()) {
              const compressionStage = `Nén ${source.name} xuống 720p...`;
              if (
                postProgressState?.title !== 'Đang nén video'
                || postProgressState?.stage !== compressionStage
              ) {
                beginPostProgress('Đang nén video', compressionStage);
              }
              updatePostProgress(progress, compressionStage);
            }
          }
        }
      );
      if (!sequenceCheck()) {
        releasePreparedItems(preparedItems);
        return [];
      }
      const metadata = await mediaMetadata(prepared);
      if (
        ['video', 'audio'].includes(mediaKind(prepared))
        && !metadata.durationSeconds
      ) {
        const sourceMetadata = await mediaMetadata(source);
        metadata.durationSeconds = sourceMetadata.durationSeconds;
      }
      const limits = currentMediaLimits(scope);
      const landscape = (metadata.width || 0) >= (metadata.height || 0);
      const needsFrame = mediaKind(prepared) === 'video';
      const fitsFrame = !needsFrame || (metadata.width && metadata.height && (
        landscape
          ? metadata.width <= limits.maxWidth && metadata.height <= limits.maxHeight
          : metadata.width <= limits.maxHeight && metadata.height <= limits.maxWidth
      ));
      if (!fitsFrame) {
        throw new Error(
          `Video sau nén phải nằm trong khung ${limits.qualityLabel}.`
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
    const limits = currentMediaLimits(scope);
    const preparedMediaBytes = preparedItems
      .reduce((sum, item) => sum + item.file.size, 0);
    if (
      Number.isFinite(limits.totalMediaBytes)
      && preparedMediaBytes > limits.totalMediaBytes
    ) {
      throw new Error(
        `Tổng dung lượng ảnh, video và âm thanh tối đa `
        + `${Math.round(limits.totalMediaBytes / 1024 / 1024)} MB.`
      );
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
      () => sequence === previewPrepareSequence,
      'post'
    );
    if (sequence !== previewPrepareSequence) return;
    selectedPostMedia = preparedItems;
    renderPostSelectionPreview();
    const totalSize = selectedPostMedia.reduce((sum, item) => sum + item.file.size, 0);
    setInfo(
      `Đã chuẩn bị ${selectedPostMedia.length} tệp (${(totalSize / 1024 / 1024).toFixed(1)} MB).`,
      'success'
    );
    if (postProgressState?.title === 'Đang nén video') {
      finishPostProgress('Đã nén video xuống 720p.');
    }
  } catch (error) {
    if (sequence !== previewPrepareSequence) return;
    elements.media.value = '';
    setInfo(error.message, 'error');
    if (postProgressState?.title === 'Đang nén video') {
      finishPostProgress(error.message, 'error');
    }
  }
}

function openComposer() {
  if (!canInteract() || !hasForumPermission('forum.create_post')) {
    setInfo('Role của bạn hiện không có quyền đăng bài.', 'error');
    return;
  }
  const remaining = editingPost ? 0 : cooldownSeconds();
  if (remaining > 0) {
    updatePostCooldownUi();
    setInfo('');
    return;
  }
  if (typeof elements.composerDialog.showModal === 'function') {
    elements.composerDialog.showModal();
  } else {
    elements.composerDialog.setAttribute('open', '');
  }
  window.setTimeout(() => elements.title.focus(), 30);
}

function openEditComposer(post) {
  if (
    post.author_id !== session.user.id
    || !canInteract()
    || !hasForumPermission('forum.create_post')
  ) return;
  editingPost = post;
  currentCategory = post.category;
  updateCategoryUi();
  elements.subject.value = post.subject || 'khac';
  elements.grade.value = post.grade || 'other';
  elements.title.value = post.title || '';
  elements.body.value = post.body || '';
  elements.hashtags.value = (post.hashtags || []).map(tag => `#${tag}`).join(' ');
  elements.media.disabled = true;
  elements.mediaLimitNote.textContent = 'Giữ nguyên media hiện có khi chỉnh sửa.';
  elements.publish.textContent = 'Lưu thay đổi';
  elements.composerPrompt.textContent = 'Chỉnh sửa bài viết';
  openComposer();
}

function closeComposer() {
  resetPreview();
  elements.form.reset();
  editingPost = null;
  elements.media.disabled = false;
  elements.publish.textContent = 'Đăng bài';
  delete elements.publish.dataset.originalText;
  configureAccount();
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

async function uploadPreparedMedia(
  item,
  { scope = 'post', postId = '', onProgress = null } = {}
) {
  if (!item?.file) return null;
  const file = item.file;
  if (r2Enabled()) {
    const uploaded = await uploadToR2(session, file, {
      scope,
      postId,
      role: currentProfile?.role || 'member',
      onProgress
    });
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
    await uploadToSupabaseResumable(session, bucket, path, file, {
      onProgress
    });
  } else {
    onProgress?.(0, file.size);
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type
      });
    if (error) throw error;
    onProgress?.(file.size, file.size);
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
  const totalBytes = Math.max(1, items.reduce((sum, item) => sum + item.file.size, 0));
  let completedBytes = 0;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      uploaded.push(await uploadPreparedMedia(item, {
        ...options,
        onProgress: loadedBytes => {
          const overall = (completedBytes + Math.min(item.file.size, loadedBytes)) / totalBytes;
          options?.onProgress?.(overall, `Đang tải tệp ${index + 1}/${items.length}: ${item.file.name}`);
        }
      }));
      completedBytes += item.file.size;
      options?.onProgress?.(
        completedBytes / totalBytes,
        `Đã tải ${index + 1}/${items.length} tệp`
      );
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
  if (!canInteract() || !hasForumPermission('forum.create_post')) {
    setInfo('Role của bạn hiện không có quyền đăng bài.', 'error');
    return;
  }
  const editing = editingPost;
  const remaining = editing ? 0 : cooldownSeconds();
  if (remaining > 0) {
    updatePostCooldownUi();
    setInfo('');
    closeComposer();
    return;
  }
  await previewPreparePromise;

  const title = elements.title.value.trim();
  if (title.length < 3) {
    setInfo('Nội dung chính cần ít nhất 3 ký tự.', 'error');
    elements.title.focus();
    return;
  }
  const mediaItems = editing ? [] : [...selectedPostMedia];
  let uploaded = [];
  let createdPostId = '';
  setBusy(elements.publish, true, 'Đang đăng...');
  beginPostProgress(
    'Đang đăng bài viết',
    mediaItems.length ? `Chuẩn bị tải ${mediaItems.length} tệp lên R2...` : 'Đang lưu nội dung bài viết...'
  );
  try {
    uploaded = await uploadPreparedMediaList(mediaItems, {
      scope: 'post',
      onProgress: (progress, stage) => updatePostProgress(progress, stage)
    });
    beginPostProgress('Đang hoàn tất bài viết', 'Đang lưu nội dung và thông tin tệp...', 5);
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
    const request = editing
      ? supabase.from('forum_posts').update({
          title: payload.title,
          body: payload.body,
          hashtags: payload.hashtags,
          subject: payload.subject,
          grade: payload.grade
        }).eq('id', editing.id)
      : supabase.from('forum_posts').insert(payload);
    const { data: createdPost, error } = await request
      .select('id, moderation_status, created_at')
      .single();
    if (error) throw error;
    createdPostId = createdPost.id;

    if (!editing && uploaded.length) {
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

    const mentions = parseMentions(title, elements.body.value);
    const { error: mentionError } = await supabase.rpc('sync_forum_post_mentions', {
      target_post_id: createdPostId,
      usernames: mentions
    });
    if (mentionError) throw mentionError;

    elements.form.reset();
    resetPreview();
    editingPost = null;
    elements.media.disabled = false;
    elements.publish.textContent = 'Đăng bài';
    delete elements.publish.dataset.originalText;
    configureAccount();
    setInfo(
      editing
        ? 'Đã lưu thay đổi. Hệ thống đang kiểm tra lại bài viết.'
        : 'Đã gửi bài viết. Hệ thống đang kiểm tra trước khi công khai.',
      'info'
    );
    if (!editing && !hasUnlimitedVipPosting()) {
      postCooldownUntil = new Date(createdPost.created_at).getTime() + 15 * 60 * 1000;
      rememberPostCooldown(postCooldownUntil);
    }
    updatePostCooldownUi();
    if (!editing) closeComposer();
    await loadPosts();
    startModerationProgress(uploaded);
    moderateInBackground('post', createdPostId, loadPosts, decision => {
      if (decision === 'safe') {
        finishPostProgress('Bài viết đã được hệ thống duyệt và công khai.');
      } else if (decision === 'violation') {
        finishPostProgress('Bài viết vi phạm và đã bị xóa.', 'error');
      } else {
        finishPostProgress('Đã chuyển bài viết cho Staff/Quản trị viên xem xét.');
      }
    });
  } catch (error) {
    if (createdPostId && !editing) {
      await supabase.from('forum_posts').delete().eq('id', createdPostId);
    }
    await Promise.allSettled(
      uploaded.map(item => removeStoredMedia(item.path, 'forum-media'))
    );
    const readableError = humanizeAuthError(error);
    const cooldownDiagnostic = [
      error?.message,
      error?.details,
      error?.hint,
      readableError
    ].filter(Boolean).join(' ');
    const cooldownRejected = isPostCooldownNotice(cooldownDiagnostic);
    if (cooldownRejected) {
      await refreshPostCooldown().catch(() => {});
      updatePostCooldownUi();
      clearPostProgressTimers();
      postProgressState = null;
      if (elements.postProgress) elements.postProgress.hidden = true;
      setInfo('');
      if (elements.composerDialog.open || elements.composerDialog.hasAttribute('open')) {
        closeComposer();
      }
      return;
    }
    setInfo(`Không thể đăng bài: ${readableError}`, 'error');
    finishPostProgress(`Không thể đăng bài: ${readableError}`, 'error');
  } finally {
    setBusy(elements.publish, false);
  }
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
      visibility,
      edited_at,
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
        mediaResult,
        metricsResult,
        reportsResult
      ] = await Promise.all([
        supabase
          .from('forum_reactions')
          .select('post_id, user_id, reaction_type')
          .in('post_id', ids),
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
          .in('post_id', ids),
        currentProfile?.role === 'admin'
          ? supabase
              .from('forum_reports')
              .select('id, post_id, reason, details, created_at')
              .eq('status', 'open')
              .in('post_id', ids)
          : Promise.resolve({ data: [], error: null })
      ]);
      if (reactionsResult.error) throw reactionsResult.error;
      if (mediaResult.error) throw mediaResult.error;
      if (metricsResult.error) throw metricsResult.error;
      if (reportsResult.error) throw reportsResult.error;
      if (sequence !== loadSequence) return;

      const reactionsByPost = groupByPost(reactionsResult.data);
      const mediaByPost = groupByPost(mediaResult.data);
      const metricsByPost = new Map(
        (metricsResult.data || []).map(metric => [metric.post_id, metric])
      );
      const reportsByPost = groupByPost(reportsResult.data);
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
        post.commentCount = Number(metric.comment_count || 0);
        post.shareCount = Number(metric.share_count || 0);
        post.viewCount = Number(metric.view_count || 0);
        post.trendingScore = Number(metric.trending_score || 0);
        post.openReports = reportsByPost.get(post.id) || [];
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

async function refreshPostEngagement(postId, refreshComments = false) {
  if (!postId) return;
  const post = posts.find(item => item.id === postId);
  if (!post) return;
  const [reactionsResult, metricsResult] = await Promise.all([
    supabase
      .from('forum_reactions')
      .select('user_id, reaction_type')
      .eq('post_id', postId),
    supabase
      .from('forum_post_metrics')
      .select('view_count, reaction_count, comment_count, share_count, trending_score')
      .eq('post_id', postId)
      .maybeSingle()
  ]);
  if (reactionsResult.error) throw reactionsResult.error;
  if (metricsResult.error) throw metricsResult.error;

  const reactions = reactionsResult.data || [];
  const metric = metricsResult.data || {};
  post.reactionCounts = reactions.reduce((counts, reaction) => {
    counts[reaction.reaction_type] = (counts[reaction.reaction_type] || 0) + 1;
    return counts;
  }, {});
  post.myReaction = reactions.find(reaction => reaction.user_id === session.user.id)
    ?.reaction_type || '';
  post.reactionCount = Number(metric.reaction_count ?? reactions.length);
  post.commentCount = Number(metric.comment_count ?? post.commentCount ?? 0);
  post.shareCount = Number(metric.share_count ?? post.shareCount ?? 0);
  post.viewCount = Number(metric.view_count ?? post.viewCount ?? 0);
  post.trendingScore = Number(metric.trending_score ?? post.trendingScore ?? 0);

  const card = elements.feed.querySelector(`[data-post-id="${CSS.escape(postId)}"]`);
  if (!card) return;
  updatePostStats(card, post);
  const commentPanel = card.querySelector('.comment-panel');
  if (refreshComments && commentPanel && !commentPanel.hidden) {
    await loadComments(post, card);
  }
}

function scheduleRealtimeFeedReload() {
  window.clearTimeout(realtimeReloadTimer);
  realtimeReloadTimer = window.setTimeout(() => {
    loadPosts().catch(error => console.warn('Realtime feed refresh failed', error));
  }, 180);
}

function postIdFromRealtime(payload) {
  return payload?.new?.post_id || payload?.old?.post_id || '';
}

function handleEngagementRealtime(payload, refreshComments = false) {
  const postId = postIdFromRealtime(payload);
  if (!postId) return;
  refreshPostEngagement(postId, refreshComments)
    .catch(error => console.warn('Realtime engagement refresh failed', error));
}

function scheduleRealtimeNotifications() {
  window.clearTimeout(notificationRealtimeTimer);
  notificationRealtimeTimer = window.setTimeout(() => {
    loadNotifications().catch(error => console.warn('Realtime notification refresh failed', error));
  }, 120);
}

async function handleCommentMediaRealtime(payload) {
  const commentId = payload?.new?.comment_id || payload?.old?.comment_id;
  if (!commentId) return;
  const { data, error } = await supabase
    .from('forum_comments')
    .select('post_id')
    .eq('id', commentId)
    .maybeSingle();
  if (error || !data?.post_id) return;
  await refreshPostEngagement(data.post_id, true);
}

function setupForumRealtime() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase
    .channel(`forum-v6-${session.user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_posts' },
      scheduleRealtimeFeedReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_post_media' },
      scheduleRealtimeFeedReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_comments' },
      payload => handleEngagementRealtime(payload, true))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_comment_media' },
      payload => handleCommentMediaRealtime(payload)
        .catch(error => console.warn('Realtime comment media refresh failed', error)))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_reactions' },
      payload => handleEngagementRealtime(payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_shares' },
      payload => handleEngagementRealtime(payload))
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'forum_notifications',
      filter: `recipient_id=eq.${session.user.id}`
    }, scheduleRealtimeNotifications)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_reports' }, () => {
      if (currentProfile?.role === 'admin') {
        scheduleRealtimeNotifications();
        scheduleRealtimeFeedReload();
      }
    })
    .subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`Forum Realtime status: ${status}`);
      }
    });
}

function updatePostStats(card, post) {
  const stats = card.querySelector('.post-stats');
  const left = document.createElement('button');
  left.type = 'button';
  left.className = 'reaction-summary-button';
  const popularReactions = Object.entries(post.reactionCounts || {})
    .filter(([, count]) => count > 0)
    .sort((first, second) => second[1] - first[1])
    .slice(0, 3)
    .map(([type]) => REACTIONS[type]?.emoji)
    .join('');
  left.textContent = `${popularReactions ? `${popularReactions} ` : ''}`
    + `${post.reactionCount || 0} cảm xúc · ${post.viewCount || 0} lượt xem`;
  left.disabled = !post.reactionCount;
  left.title = post.reactionCount ? 'Xem những người đã thả cảm xúc' : '';
  left.setAttribute('aria-label', post.reactionCount
    ? `Xem ${post.reactionCount} người đã thả cảm xúc`
    : 'Chưa có cảm xúc');
  left.addEventListener('click', () => openReactionList(post));
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
  reactionButton.setAttribute('aria-pressed', String(Boolean(post.myReaction)));
  reactionButton.title = post.myReaction
    ? `Bấm để bỏ ${reaction.label.toLocaleLowerCase('vi')}; nhấn giữ để đổi cảm xúc`
    : 'Bấm để Thích; nhấn giữ hoặc rê chuột để chọn cảm xúc khác';
  card.querySelectorAll('.reaction-picker [data-reaction]').forEach(button => {
    const selected = button.dataset.reaction === post.myReaction;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function renderReactionList(filter = activeReactionListFilter) {
  activeReactionListFilter = filter;
  const visible = filter === 'all'
    ? reactionListRows
    : reactionListRows.filter(item => item.reaction_type === filter);
  elements.reactionList.replaceChildren();
  elements.reactionListFilters.querySelectorAll('button').forEach(button => {
    const selected = button.dataset.filter === filter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'reaction-list-empty';
    empty.textContent = reactionListRows.length
      ? 'Chưa có cảm xúc thuộc loại này.'
      : 'Chưa có ai thả cảm xúc.';
    elements.reactionList.appendChild(empty);
    return;
  }
  visible.forEach(item => {
    const profile = Array.isArray(item.user) ? item.user[0] || {} : item.user || {};
    const link = document.createElement('a');
    link.className = 'reaction-list-item';
    link.href = publicProfileUrl(profile);
    const avatar = document.createElement('img');
    avatar.src = profile.avatar_url || 'avatar.webp';
    avatar.alt = '';
    avatar.loading = 'lazy';
    avatar.decoding = 'async';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = profileName(profile);
    const role = document.createElement('small');
    role.textContent = roleLabel(profile.role || 'member');
    copy.append(name, role);
    const emoji = document.createElement('span');
    emoji.className = 'reaction-list-emoji';
    emoji.textContent = REACTIONS[item.reaction_type]?.emoji || '♡';
    emoji.title = REACTIONS[item.reaction_type]?.label || 'Cảm xúc';
    link.append(avatar, copy, emoji);
    elements.reactionList.appendChild(link);
  });
}

function renderReactionListFilters() {
  elements.reactionListFilters.replaceChildren();
  const counts = reactionListRows.reduce((result, item) => {
    result[item.reaction_type] = (result[item.reaction_type] || 0) + 1;
    return result;
  }, {});
  const filters = [
    ['all', `Tất cả ${reactionListRows.length}`],
    ...Object.entries(REACTIONS)
      .filter(([type]) => counts[type])
      .map(([type, reaction]) => [type, `${reaction.emoji} ${counts[type]}`])
  ];
  filters.forEach(([type, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.dataset.filter = type;
    button.textContent = label;
    button.addEventListener('click', () => renderReactionList(type));
    elements.reactionListFilters.appendChild(button);
  });
}

async function openReactionList(post) {
  if (!post?.id) return;
  reactionListRows = [];
  activeReactionListFilter = 'all';
  elements.reactionListFilters.replaceChildren();
  elements.reactionList.replaceChildren();
  elements.reactionListSummary.textContent = 'Đang tải...';
  const loading = document.createElement('p');
  loading.className = 'reaction-list-empty';
  loading.textContent = 'Đang tải danh sách...';
  elements.reactionList.appendChild(loading);
  elements.reactionListDialog.showModal();

  try {
    const { data, error } = await supabase
      .from('forum_reactions')
      .select(`
        reaction_type,
        created_at,
        user:profiles!forum_reactions_user_id_fkey(
          username,
          display_name,
          avatar_url,
          role
        )
      `)
      .eq('post_id', post.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    reactionListRows = data || [];
    elements.reactionListSummary.textContent = `${reactionListRows.length} người`;
    renderReactionListFilters();
    renderReactionList();
  } catch (error) {
    elements.reactionListSummary.textContent = 'Có lỗi';
    elements.reactionList.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'reaction-list-empty';
    failed.textContent = `Không thể tải danh sách: ${humanizeAuthError(error)}`;
    elements.reactionList.appendChild(failed);
  }
}

function closeReactionList() {
  if (elements.reactionListDialog.open) elements.reactionListDialog.close();
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

function lightboxControl(label, text, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function createImageLightbox(item, positionLabel) {
  const stage = document.createElement('div');
  stage.className = 'lightbox-image-stage';
  stage.tabIndex = 0;
  stage.setAttribute('aria-label', `${positionLabel}. Cuộn để phóng to, kéo để xem vùng khác, dùng nút xoay để đổi hướng ảnh.`);

  const canvas = document.createElement('div');
  canvas.className = 'lightbox-image-canvas';
  const image = document.createElement('img');
  image.className = 'lightbox-image';
  image.src = mediaUrl(item);
  image.alt = positionLabel;
  image.draggable = false;
  canvas.appendChild(image);
  stage.appendChild(canvas);

  const tools = document.createElement('div');
  tools.className = 'lightbox-tools';
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Điều khiển ảnh');
  const zoomOut = lightboxControl('Thu nhỏ ảnh', '−');
  const zoomLevel = document.createElement('output');
  zoomLevel.setAttribute('aria-live', 'polite');
  zoomLevel.textContent = '100%';
  const zoomIn = lightboxControl('Phóng to ảnh', '+');
  const rotateLeft = lightboxControl('Xoay ảnh sang trái 90 độ', '↶90°', 'rotate-image');
  const rotateRight = lightboxControl('Xoay ảnh sang phải 90 độ', '90°↷', 'rotate-image');
  const fitImage = lightboxControl('Hiện toàn bộ ảnh', 'Vừa ảnh', 'fit-image');
  tools.append(zoomOut, zoomLevel, zoomIn, rotateLeft, rotateRight, fitImage);

  let zoom = 1;
  let rotation = 0;
  let dragging = null;
  let resizeObserver = null;

  const renderZoom = (preserveCenter = true) => {
    if (!image.naturalWidth || !image.naturalHeight || !stage.clientWidth || !stage.clientHeight) return;
    const previousCenterX = stage.scrollLeft + stage.clientWidth / 2;
    const previousCenterY = stage.scrollTop + stage.clientHeight / 2;
    const previousWidth = Math.max(1, stage.scrollWidth);
    const previousHeight = Math.max(1, stage.scrollHeight);
    const availableWidth = Math.max(1, stage.clientWidth - 20);
    const availableHeight = Math.max(1, stage.clientHeight - 20);
    const sideways = Math.abs(rotation % 180) === 90;
    const fittedWidth = sideways ? image.naturalHeight : image.naturalWidth;
    const fittedHeight = sideways ? image.naturalWidth : image.naturalHeight;
    const fitScale = Math.min(
      availableWidth / fittedWidth,
      availableHeight / fittedHeight,
      1
    );
    const width = Math.max(1, Math.round(image.naturalWidth * fitScale * zoom));
    const height = Math.max(1, Math.round(image.naturalHeight * fitScale * zoom));
    const visualWidth = sideways ? height : width;
    const visualHeight = sideways ? width : height;
    canvas.style.width = `${Math.max(stage.clientWidth, visualWidth + 20)}px`;
    canvas.style.height = `${Math.max(stage.clientHeight, visualHeight + 20)}px`;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.transform = `translate(-50%,-50%) rotate(${rotation}deg)`;
    stage.classList.toggle('can-pan', zoom > 1);
    zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
    zoomOut.disabled = zoom <= 1;
    zoomIn.disabled = zoom >= 5;

    window.requestAnimationFrame(() => {
      const targetCenterX = preserveCenter
        ? previousCenterX / previousWidth * stage.scrollWidth
        : stage.scrollWidth / 2;
      const targetCenterY = preserveCenter
        ? previousCenterY / previousHeight * stage.scrollHeight
        : stage.scrollHeight / 2;
      stage.scrollLeft = Math.max(0, targetCenterX - stage.clientWidth / 2);
      stage.scrollTop = Math.max(0, targetCenterY - stage.clientHeight / 2);
    });
  };

  const setZoom = value => {
    zoom = Math.min(5, Math.max(1, Math.round(value * 100) / 100));
    renderZoom();
  };
  const zoomInImage = () => setZoom(zoom * 1.25);
  const zoomOutImage = () => setZoom(zoom / 1.25);
  const rotateImage = direction => {
    rotation = (rotation + direction * 90 + 360) % 360;
    renderZoom(false);
  };
  const resetImage = () => {
    zoom = 1;
    renderZoom(false);
  };

  zoomIn.addEventListener('click', zoomInImage);
  zoomOut.addEventListener('click', zoomOutImage);
  rotateLeft.addEventListener('click', () => rotateImage(-1));
  rotateRight.addEventListener('click', () => rotateImage(1));
  fitImage.addEventListener('click', resetImage);
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });
  stage.addEventListener('dblclick', () => {
    if (zoom > 1) resetImage();
    else setZoom(2);
  });
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || zoom <= 1) return;
    event.preventDefault();
    dragging = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: stage.scrollLeft,
      scrollTop: stage.scrollTop
    };
    stage.classList.add('dragging');
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!dragging) return;
    stage.scrollLeft = dragging.scrollLeft - (event.clientX - dragging.x);
    stage.scrollTop = dragging.scrollTop - (event.clientY - dragging.y);
  });
  const stopDragging = event => {
    if (!dragging) return;
    dragging = null;
    stage.classList.remove('dragging');
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };
  stage.addEventListener('pointerup', stopDragging);
  stage.addEventListener('pointercancel', stopDragging);
  image.addEventListener('load', () => renderZoom(false), { once: true });

  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => renderZoom());
    resizeObserver.observe(stage);
  } else {
    window.addEventListener('resize', renderZoom);
  }

  activeLightboxZoomControls = {
    zoomIn: zoomInImage,
    zoomOut: zoomOutImage,
    rotateLeft: () => rotateImage(-1),
    rotateRight: () => rotateImage(1),
    reset: resetImage
  };
  activeLightboxCleanup = () => {
    resizeObserver?.disconnect();
    if (!resizeObserver) window.removeEventListener('resize', renderZoom);
  };
  return { stage, tools };
}

function openMediaLightbox(items, startIndex = 0) {
  const item = items[startIndex];
  if (!item) return;
  activeLightboxCleanup?.();
  activeLightboxCleanup = null;
  activeLightboxZoomControls = null;
  activeLightboxItems = items;
  activeLightboxIndex = startIndex;
  elements.mediaLightboxContent.replaceChildren();
  const contentTag = item.media_type === 'video'
    ? 'video'
    : item.media_type === 'audio'
      ? 'audio'
      : 'img';
  if (contentTag === 'img') {
    const viewer = createImageLightbox(item, `Ảnh ${startIndex + 1} trên ${items.length}`);
    elements.mediaLightboxContent.append(viewer.stage, viewer.tools);
  } else {
    const content = document.createElement(contentTag);
    content.className = 'lightbox-media';
    content.src = mediaUrl(item);
    content.controls = true;
    content.autoplay = true;
    elements.mediaLightboxContent.appendChild(content);
  }

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
  activeLightboxCleanup?.();
  activeLightboxCleanup = null;
  activeLightboxZoomControls = null;
  activeLightboxItems = [];
  activeLightboxIndex = 0;
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
      content.decoding = 'async';
      content.fetchPriority = 'low';
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
  avatar.src = author.avatar_url || 'avatar.webp';
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
  if (post.edited_at) time.textContent += ' · đã chỉnh sửa';

  const meta = card.querySelector('.post-meta');
  meta.append(chip(post.category === 'question' ? 'Hỏi đáp' : 'Giải trí'));
  if (post.is_pinned) meta.append(chip('📌 Đã ghim', 'pinned'));
  if (post.moderation_status === 'pending_review') {
    meta.append(chip('Đang chờ duyệt', 'pending'));
  } else if (post.moderation_status === 'rejected') {
    meta.append(chip('Không được duyệt', 'rejected'));
  }
  if (post.visibility === 'hidden') meta.append(chip('Đang ẩn', 'rejected'));
  if (currentProfile?.role === 'admin' && post.openReports?.length) {
    meta.append(chip(`⚑ ${post.openReports.length} báo cáo`, 'reported'));
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
      && (post.author_id === session.user.id || isForumAdmin())
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
    moderationNote.textContent = userFacingModerationReason(
      post.moderation_reason,
      'Bài viết đang chờ Staff hoặc quản trị viên xem xét.'
    );
    card.querySelector('.post-header').after(moderationNote);
    if (canReviewContent(post.mediaItems)) {
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
  if (currentProfile?.role === 'admin' && post.openReports?.length) {
    const reportNote = document.createElement('div');
    reportNote.className = 'report-admin-note';
    const reasonLabels = {
      spam: 'Spam',
      harassment: 'Nói xấu hoặc quấy rối',
      adult: 'Nội dung nhạy cảm',
      off_topic: 'Không đúng nội dung diễn đàn',
      other: 'Lý do khác'
    };
    const descriptions = post.openReports.map((report, index) => {
      const detail = report.details ? ` — ${report.details}` : '';
      return `${index + 1}. ${reasonLabels[report.reason] || report.reason}${detail}`;
    });
    reportNote.textContent = `Báo cáo đang chờ admin quyết định:\n${descriptions.join('\n')}`;
    card.querySelector('.post-header').after(reportNote);
  }

  card.querySelector('.post-title').textContent = post.title;
  renderTextWithMentions(card.querySelector('.post-body'), post.body || '');
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
  reactionAction.hidden = !canInteract() || !hasForumPermission('forum.react');
  configureReactionInteraction(post, card, reactionAction, reactionButton);
  card.querySelectorAll('.reaction-picker [data-reaction]').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await setReaction(post, button.dataset.reaction, card);
      closeReactionPicker(reactionAction);
    });
  });
  card.querySelector('[data-action="comment"]')
    .addEventListener('click', () => toggleComments(post, card));
  const shareButton = card.querySelector('[data-action="share"]');
  shareButton.hidden = !canInteract() || !hasForumPermission('forum.share');
  shareButton.addEventListener('click', () => sharePost(post, card));
  const reportButton = card.querySelector('[data-action="report"]');
  reportButton.hidden = !canInteract()
    || !hasForumPermission('forum.report')
    || post.author_id === session.user.id;
  reportButton.addEventListener('click', () => openReportDialog(post));

  configurePostMenu(post, card);

  const commentForm = card.querySelector('.comment-form');
  commentForm.querySelector('img').src = currentProfile.avatar_url || 'avatar.webp';
  commentForm.hidden = !canInteract() || !hasForumPermission('forum.create_comment');
  const commentMediaInput = commentForm.querySelector('.comment-media-input');
  commentMediaInput.addEventListener('change', () => {
    const task = showCommentMediaPreview(commentForm, commentMediaInput.files);
    commentPreparePromises.set(commentForm, task);
  });
  const limits = currentMediaLimits('comment');
  card.querySelector('.comment-media-note').textContent = mediaLimitDescription(limits);
  commentForm.addEventListener('submit', event => addComment(event, post, card));
  card.querySelector('.replying-indicator button')
    .addEventListener('click', () => setReplyingTo(commentForm));
  observePostView(card, post);
  return fragment;
}

function appendPostMenuItem(container, label, action, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.role = 'menuitem';
  button.textContent = label;
  button.classList.toggle('danger', danger);
  button.addEventListener('click', action);
  container.appendChild(button);
  return button;
}

function configurePostMenu(post, card) {
  const shell = card.querySelector('.post-menu-shell');
  const toggle = card.querySelector('.post-menu-button');
  const menu = card.querySelector('.post-menu');
  const owner = canInteract() && post.author_id === session.user.id;
  const staff = canModerate();
  shell.hidden = !owner && !staff;
  if (shell.hidden) return;

  if (owner) {
    appendPostMenuItem(menu, 'Chỉnh sửa bài viết', () => openEditComposer(post));
    appendPostMenuItem(
      menu,
      post.visibility === 'hidden' ? 'Hiện bài viết' : 'Ẩn bài viết',
      () => setPostVisibility(post, post.visibility !== 'hidden')
    );
  }
  if (staff && post.moderation_status !== 'published' && canReviewContent(post.mediaItems)) {
    appendPostMenuItem(menu, 'Duyệt bài viết', () => reviewPost(post, 'approve', toggle));
  }
  if (currentProfile?.role === 'admin' && post.openReports?.length) {
    appendPostMenuItem(menu, 'Duyệt báo cáo · Giữ bài', () => approveReportedPost(post));
  }
  if (staff && !owner) {
    appendPostMenuItem(
      menu,
      post.visibility === 'hidden' ? 'Hiện bài viết' : 'Ẩn bài viết',
      () => setPostVisibility(post, post.visibility !== 'hidden')
    );
  }
  if (owner || isForumAdmin()) {
    appendPostMenuItem(menu, 'Xóa bài viết', () => deletePost(post, card, toggle), true);
  }

  toggle.addEventListener('click', event => {
    event.stopPropagation();
    document.querySelectorAll('.post-menu:not([hidden])').forEach(open => {
      if (open !== menu) open.hidden = true;
    });
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
  });
}

async function setPostVisibility(post, shouldHide) {
  try {
    const { data, error } = await supabase.rpc('set_forum_post_visibility', {
      target_post_id: post.id,
      should_hide: shouldHide
    });
    if (error) throw error;
    if (!data) throw new Error('Bạn không có quyền thay đổi bài viết này.');
    if (shouldHide && currentProfile?.role === 'admin' && post.openReports?.length) {
      await resolvePostReports(post, 'resolved');
    }
    setInfo(shouldHide ? 'Đã ẩn bài viết.' : 'Đã hiện bài viết.', 'success');
    await loadPosts();
  } catch (error) {
    setInfo(`Không thể đổi trạng thái bài: ${humanizeAuthError(error)}`, 'error');
  }
}

async function resolvePostReports(post, status) {
  const reports = [...(post.openReports || [])];
  for (const report of reports) {
    const { data, error } = await supabase.rpc('review_forum_report', {
      target_report_id: report.id,
      review_status: status
    });
    if (error) throw error;
    if (!data) throw new Error('Báo cáo đã được tài khoản khác xử lý.');
  }
  post.openReports = [];
}

async function approveReportedPost(post) {
  try {
    await resolvePostReports(post, 'dismissed');
    setInfo('Admin đã duyệt báo cáo và quyết định giữ bài viết công khai.', 'success');
    await loadPosts();
  } catch (error) {
    setInfo(`Không thể xử lý báo cáo: ${humanizeAuthError(error)}`, 'error');
  }
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
    updateCommentCooldownUi();
    return;
  }
  const fragment = document.createDocumentFragment();
  visible.forEach(post => fragment.appendChild(renderPost(post)));
  elements.feed.appendChild(fragment);
  updateCommentCooldownUi();

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
    && (post.author_id === session.user.id || isForumAdmin());
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
  if (!canReviewContent(post.mediaItems)) {
    setInfo('Chỉ Staff hoặc quản trị viên được duyệt bài.', 'error');
    return;
  }
  const note = action === 'reject'
    ? window.prompt('Lý do từ chối bài viết:', userFacingModerationReason(post.moderation_reason, ''))
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

async function reviewComment(comment, post, card, action, button) {
  if (!canReviewComment(comment)) {
    setInfo('Chỉ Staff hoặc quản trị viên được duyệt bình luận này.', 'error');
    return;
  }
  const note = action === 'reject'
    ? window.prompt('Lý do từ chối bình luận:', userFacingModerationReason(comment.moderation_reason, ''))
    : '';
  if (action === 'reject' && note === null) return;
  setBusy(button, true, action === 'approve' ? 'Đang duyệt...' : 'Đang từ chối...');
  try {
    const { data, error } = await supabase.rpc('review_forum_comment', {
      target_comment_id: comment.id,
      review_action: action,
      review_note: note || null
    });
    if (error) throw error;
    if (!data) throw new Error('Không tìm thấy bình luận cần duyệt.');
    setInfo(
      action === 'approve'
        ? 'Đã duyệt bình luận.'
        : 'Đã từ chối bình luận.',
      'success'
    );
    await Promise.all([
      loadComments(post, card),
      refreshPostEngagement(post.id, true)
    ]);
  } catch (error) {
    setBusy(button, false);
    setInfo(`Không thể duyệt bình luận: ${humanizeAuthError(error)}`, 'error');
  }
}

async function setReaction(post, type, card) {
  if (!canInteract() || !hasForumPermission('forum.react')) {
    setInfo('Role của bạn hiện không có quyền thả cảm xúc.', 'error');
    return;
  }
  if (!REACTIONS[type] || reactionPendingPosts.has(post.id)) return;
  const previous = post.myReaction;
  const shouldRemove = previous === type;
  const previousCounts = { ...(post.reactionCounts || {}) };
  const previousTotal = post.reactionCount || 0;
  reactionPendingPosts.add(post.id);

  if (previous) {
    post.reactionCounts[previous] = Math.max(
      0,
      (post.reactionCounts[previous] || 0) - 1
    );
  }
  if (shouldRemove) {
    post.myReaction = '';
    post.reactionCount = Math.max(0, previousTotal - 1);
  } else {
    post.myReaction = type;
    post.reactionCounts[type] = (post.reactionCounts[type] || 0) + 1;
    post.reactionCount = previous ? previousTotal : previousTotal + 1;
  }
  updatePostStats(card, post);

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
  } catch (error) {
    post.myReaction = previous;
    post.reactionCounts = previousCounts;
    post.reactionCount = previousTotal;
    updatePostStats(card, post);
    setInfo(`Không thể cập nhật cảm xúc: ${humanizeAuthError(error)}`, 'error');
  } finally {
    reactionPendingPosts.delete(post.id);
  }
}

function configureReactionInteraction(post, card, action, mainButton) {
  let holdTimer = 0;
  let heldOpen = false;
  let suppressNextClick = false;
  let startX = 0;
  let startY = 0;

  const cancelHold = () => {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  };
  mainButton.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') return;
    heldOpen = false;
    startX = event.clientX;
    startY = event.clientY;
    cancelHold();
    holdTimer = window.setTimeout(() => {
      heldOpen = true;
      suppressNextClick = true;
      if (!action.classList.contains('is-open')) toggleReactionPicker(action);
      navigator.vibrate?.(18);
    }, 420);
  });
  mainButton.addEventListener('pointermove', event => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) cancelHold();
  });
  mainButton.addEventListener('pointerup', event => {
    cancelHold();
    if (!heldOpen) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest?.('.reaction-picker [data-reaction]');
    if (target && action.contains(target)) {
      void setReaction(post, target.dataset.reaction, card);
      closeReactionPicker(action);
      heldOpen = false;
    }
  });
  mainButton.addEventListener('pointercancel', cancelHold);
  mainButton.addEventListener('contextmenu', event => {
    if (heldOpen) event.preventDefault();
  });
  mainButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      heldOpen = false;
      return;
    }
    closeReactionPicker(action);
    void setReaction(post, post.myReaction || 'like', card);
  });
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
  form.querySelector('.comment-attach')?.classList.remove('has-media');
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
  form.querySelector('.comment-attach')?.classList.toggle('has-media', Boolean(items.length));
}

async function showCommentMediaPreview(form, fileList) {
  // FileList thay đổi ngay khi input bị reset, vì vậy phải chụp lại danh sách
  // trước khi dọn lựa chọn cũ.
  const selectedFiles = [...(fileList || [])];
  resetCommentMedia(form);
  if (!selectedFiles.length) return;
  const sequence = commentPrepareSequences.get(form);
  try {
    setInfo('Đang xử lý media bình luận...', 'info');
    const items = await prepareSelectedFiles(
      selectedFiles,
      () => sequence === commentPrepareSequences.get(form),
      'comment'
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
        parent_comment_id,
        moderation_status,
        moderation_reason,
        edited_at,
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
    item.classList.toggle('comment-reply', Boolean(comment.parent_comment_id));
    const avatar = document.createElement('img');
    avatar.src = author.avatar_url || 'avatar.webp';
    avatar.alt = `Hồ sơ của ${profileName(author)}`;
    avatar.loading = 'lazy';
    avatar.decoding = 'async';
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
    renderTextWithMentions(body, comment.body || '');
    const time = document.createElement('time');
    time.dateTime = comment.created_at;
    time.textContent = relativeTime(comment.created_at);
    if (comment.edited_at) time.textContent += ' · đã sửa';
    bubble.append(authorLine, body);
    if (comment.mediaItems?.length) {
      const media = document.createElement('div');
      media.className = 'comment-media-gallery';
      renderMediaGallery(media, comment.mediaItems, profileName(author), true);
      bubble.appendChild(media);
    }
    const footer = document.createElement('div');
    footer.className = 'comment-footer';
    footer.appendChild(time);
    if (canInteract() && hasForumPermission('forum.create_comment')) {
      const reply = document.createElement('button');
      reply.type = 'button';
      reply.textContent = 'Trả lời';
      reply.addEventListener('click', () => {
        const form = card.querySelector('.comment-form');
        setReplyingTo(form, comment, author);
      });
      footer.appendChild(reply);
    }
    if (comment.moderation_status === 'pending_review') {
      const pending = document.createElement('span');
      pending.className = 'comment-pending';
      pending.textContent = userFacingModerationReason(
        comment.moderation_reason,
        'Hệ thống đang kiểm tra bình luận'
      );
      footer.appendChild(pending);
      if (canReviewComment(comment)) {
        const controls = document.createElement('div');
        controls.className = 'moderation-actions comment-moderation-actions';
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'button button-small';
        approve.textContent = 'Duyệt';
        approve.addEventListener('click', () => {
          void reviewComment(comment, post, card, 'approve', approve);
        });
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'button button-small button-danger';
        reject.textContent = 'Từ chối';
        reject.addEventListener('click', () => {
          void reviewComment(comment, post, card, 'reject', reject);
        });
        controls.append(approve, reject);
        bubble.appendChild(controls);
      }
    } else if (comment.moderation_status === 'rejected') {
      const rejected = document.createElement('span');
      rejected.className = 'comment-rejected';
      rejected.textContent = 'Đã bị ẩn';
      footer.appendChild(rejected);
    }
    bubble.appendChild(footer);
    item.append(avatarLink, bubble);

    if (canInteract() && (comment.author_id === session.user.id || isForumAdmin())) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comment-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Xóa bình luận');
      remove.addEventListener('click', async () => {
        if (!window.confirm('Xóa bình luận này?')) return;
        remove.disabled = true;
        const paths = new Set(
          [
            comment.media_path,
            ...(comment.mediaItems || []).map(item => item.media_path)
          ].filter(Boolean)
        );
        try {
          await Promise.all(
            [...paths].map(path => removeStoredMedia(path, 'forum-comment-media'))
          );
          const { error } = await supabase.from('forum_comments').delete().eq('id', comment.id);
          if (error) throw error;
          post.commentCount = Math.max(0, post.commentCount - 1);
          updatePostStats(card, post);
          await loadComments(post, card);
        } catch (error) {
          remove.disabled = false;
          setInfo(`Không thể xóa bình luận: ${humanizeAuthError(error)}`, 'error');
        }
      });
      item.appendChild(remove);
    }
    list.appendChild(item);
  });
}

function setReplyingTo(form, comment = null, author = null) {
  const indicator = form.parentElement.querySelector('.replying-indicator');
  if (!comment) {
    replyingToByForm.delete(form);
    indicator.hidden = true;
    indicator.querySelector('span').textContent = '';
    form.querySelector('.comment-input').placeholder = 'Viết bình luận...';
    return;
  }
  replyingToByForm.set(form, comment);
  indicator.hidden = false;
  indicator.querySelector('span').textContent = `Đang trả lời ${profileName(author)}`;
  const input = form.querySelector('.comment-input');
  input.placeholder = `Trả lời ${profileName(author)}...`;
  input.focus();
}

async function addComment(event, post, card) {
  event.preventDefault();
  if (!canInteract() || !hasForumPermission('forum.create_comment')) {
    setInfo('Role của bạn hiện không có quyền gửi bình luận.', 'error');
    return;
  }
  if (commentCooldownSeconds() > 0) {
    setInfo(`Bạn có thể bình luận tiếp sau ${cooldownLabel(commentCooldownSeconds())}.`, 'info');
    updateCommentCooldownUi();
    return;
  }
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
        media_type: firstMedia?.type || null,
        parent_comment_id: replyingToByForm.get(form)?.id || null
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
    setReplyingTo(form);
    resetCommentMedia(form);
    commentCooldownUntil = Date.now() + 2 * 60 * 1000;
    setInfo('Đã gửi bình luận. Hệ thống đang kiểm tra trước khi công khai.', 'info');
    void loadComments(post, card);
    void refreshPostEngagement(post.id, true);
    moderateInBackground('comment', createdCommentId, async () => {
      await Promise.all([
        loadComments(post, card),
        refreshPostEngagement(post.id, true)
      ]);
    });
  } catch (error) {
    if (createdCommentId) {
      await supabase.from('forum_comments').delete().eq('id', createdCommentId);
    }
    await Promise.allSettled(
      uploaded.map(item => removeStoredMedia(item.path, 'forum-comment-media'))
    );
    const rawMessage = String(error?.message || error || '');
    const remaining = rawMessage.match(/sau\s+(\d+)\s+giây/iu)?.[1];
    if (remaining) {
      commentCooldownUntil = Date.now() + Number(remaining) * 1000;
      setInfo(`Bạn có thể bình luận tiếp sau ${cooldownLabel(Number(remaining))}.`, 'info');
    } else {
      setInfo(`Không thể gửi bình luận: ${humanizeAuthError(error)}`, 'error');
    }
  } finally {
    setBusy(button, false);
    updateCommentCooldownUi();
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
  if (!canInteract() || !hasForumPermission('forum.share')) {
    setInfo('Role của bạn hiện không có quyền chia sẻ bài viết.', 'error');
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
  if (
    !canInteract()
    || !hasForumPermission('forum.report')
    || post.author_id === session.user.id
  ) return;
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
  if (!reportingPost || !hasForumPermission('forum.report')) return;
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
      'Đã gửi báo cáo đến quản trị viên. Bài viết vẫn hiển thị trong lúc chờ xem xét.',
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

    await Promise.all([
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

async function loadNotifications() {
  const { data, error } = await supabase
    .from('forum_notifications')
    .select(`
      id, type, message, post_id, comment_id, read_at, created_at,
      actor:profiles!forum_notifications_actor_id_fkey(username, display_name, avatar_url)
    `)
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) throw error;
  const notifications = data || [];
  const unread = notifications.filter(item => !item.read_at).length;
  elements.notificationBadge.hidden = unread === 0;
  elements.notificationBadge.textContent = unread > 99 ? '99+' : String(unread);
  elements.notificationList.replaceChildren();
  if (!notifications.length) {
    const empty = document.createElement('p');
    empty.className = 'notification-empty';
    empty.textContent = 'Chưa có thông báo.';
    elements.notificationList.appendChild(empty);
    return;
  }
  notifications.forEach(item => {
    const actor = Array.isArray(item.actor) ? item.actor[0] || {} : item.actor || {};
    const link = document.createElement('a');
    link.className = 'notification-item';
    link.classList.toggle('unread', !item.read_at);
    link.href = item.post_id
      ? `forum.html?post=${encodeURIComponent(item.post_id)}`
      : 'forum.html';
    const avatar = document.createElement('img');
    avatar.src = actor.avatar_url || 'avatar.webp';
    avatar.alt = '';
    avatar.loading = 'lazy';
    avatar.decoding = 'async';
    const copy = document.createElement('span');
    const message = document.createElement('strong');
    message.textContent = item.message;
    const time = document.createElement('small');
    time.textContent = relativeTime(item.created_at);
    copy.append(message, time);
    link.append(avatar, copy);
    link.addEventListener('click', () => {
      if (!item.read_at) supabase.from('forum_notifications')
        .update({ read_at: new Date().toISOString() }).eq('id', item.id);
    });
    elements.notificationList.appendChild(link);
  });
}

async function markAllNotificationsRead() {
  const { error } = await supabase.from('forum_notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);
  if (error) {
    setInfo(`Không thể cập nhật thông báo: ${humanizeAuthError(error)}`, 'error');
    return;
  }
  await loadNotifications();
}

function configureAccount() {
  const name = profileName(currentProfile, session.user);
  const limits = currentMediaLimits();
  elements.viewer.querySelector('span:last-child').textContent =
    `${name} · ${roleLabel(currentProfile.role)} · ${statusLabel(currentProfile.account_status)}`;
  elements.composerName.textContent = name;
  elements.composerAvatar.src =
    currentProfile.avatar_url || session.user.user_metadata?.avatar_url || 'avatar.webp';
  const mayCreatePost = canInteract() && hasForumPermission('forum.create_post');
  const standardInteractionPermissions = [
    'forum.create_comment', 'forum.react', 'forum.share', 'forum.report'
  ];
  const hasEveryStandardPermission = [
    'forum.create_post', ...standardInteractionPermissions
  ].every(permission => hasForumPermission(permission));
  elements.readonly.hidden = canInteract() && hasEveryStandardPermission;
  const readonlyCopy = elements.readonly.querySelector('span:last-child');
  if (readonlyCopy && canInteract()) {
    readonlyCopy.textContent = 'Role của bạn đang bị giới hạn một số hoạt động trên diễn đàn.';
  }
  elements.openComposer.hidden = !mayCreatePost;
  elements.moderationFilter.hidden = !canModerate();
  elements.mediaLimitNote.textContent = mediaLimitDescription(limits);
  if (limits.maxVideos === 0) {
    elements.media.accept = elements.media.accept
      .split(',')
      .filter(type => !type.startsWith('video/'))
      .join(',');
  }
}

function mediaLimitDescription(limits) {
  if (limits.unlimitedVipPost) {
    return 'Đặc quyền VIP: không giới hạn số lượng hoặc dung lượng tệp · '
      + 'video/âm thanh không giới hạn thời lượng · giữ nguyên độ phân giải video';
  }
  if (limits.admin) {
    return 'Không giới hạn số lượng · tổng tất cả tệp 50 MB · video/âm thanh không giới hạn thời lượng · video tự nén về 720p';
  }
  const video = limits.maxVideos
    ? `${limits.maxVideos} video không giới hạn thời lượng`
    : 'không hỗ trợ video';
  return `${limits.maxImages} ảnh · `
    + `${video} · ${limits.maxAudios} âm thanh không giới hạn thời lượng · `
    + `tổng tất cả tệp ${Math.round(limits.totalMediaBytes / 1024 / 1024)} MB · ${limits.qualityLabel}`;
}

async function init() {
  try {
    session = await requireSession();
    if (!session) return;
    currentProfile = await getProfile(session.user.id);
    await loadForumPermissions();
    if (currentProfile.account_status === 'banned') {
      elements.viewer.querySelector('span:last-child').textContent = 'Tài khoản bị cấm';
      elements.denied.hidden = false;
      return;
    }
    if (!hasForumPermission('forum.access')) {
      elements.viewer.querySelector('span:last-child').textContent =
        `${profileName(currentProfile, session.user)} · Không có quyền diễn đàn`;
      elements.denied.querySelector('h2').textContent = 'Role chưa được phép truy cập diễn đàn';
      elements.denied.querySelector('p').textContent =
        'Quản trị viên đã tắt quyền truy cập diễn đàn đối với role hiện tại của bạn.';
      elements.denied.hidden = false;
      return;
    }

    configureAccount();
    await Promise.all([refreshPostCooldown(), refreshCommentCooldown()]);
    postCooldownTimer = window.setInterval(updatePostCooldownUi, 1000);
    postCooldownSyncTimer = window.setInterval(() => {
      if (cooldownSeconds() > 0) syncPostCooldown();
    }, 10000);
    commentCooldownTimer = window.setInterval(updateCommentCooldownUi, 1000);
    notificationTimer = window.setInterval(() => loadNotifications().catch(() => {}), 45000);
    const editId = new URLSearchParams(window.location.search).get('edit');
    if (editId) {
      const { data: editTarget } = await supabase.from('forum_posts')
        .select('category').eq('id', editId).eq('author_id', session.user.id).maybeSingle();
      if (editTarget?.category) currentCategory = editTarget.category;
    }
    updateCategoryUi();
    elements.app.hidden = false;
    await Promise.all([loadPosts(), loadNotifications()]);
    setupForumRealtime();
    if (editId) {
      const post = posts.find(item => item.id === editId && item.author_id === session.user.id);
      if (post) openEditComposer(post);
    }
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
elements.composerDialog.addEventListener('cancel', event => {
  event.preventDefault();
});
window.addEventListener('focus', syncPostCooldown);
document.addEventListener('visibilitychange', syncPostCooldown);
window.addEventListener('storage', event => {
  if (event.key === postCooldownStorageKey()) syncPostCooldown();
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
elements.closeReactionList.addEventListener('click', closeReactionList);
elements.reactionListDialog.addEventListener('click', event => {
  if (event.target === elements.reactionListDialog) closeReactionList();
});
elements.reactionListDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeReactionList();
});
elements.notificationButton.addEventListener('click', event => {
  event.stopPropagation();
  elements.notificationPanel.hidden = !elements.notificationPanel.hidden;
  elements.notificationButton.setAttribute('aria-expanded', String(!elements.notificationPanel.hidden));
});
elements.notificationPanel.addEventListener('click', event => event.stopPropagation());
elements.markAllRead.addEventListener('click', markAllNotificationsRead);
document.addEventListener('click', event => {
  if (!elements.notificationPanel.hidden) {
    elements.notificationPanel.hidden = true;
    elements.notificationButton.setAttribute('aria-expanded', 'false');
  }
  document.querySelectorAll('.post-menu:not([hidden])').forEach(menu => {
    if (!menu.contains(event.target)) menu.hidden = true;
  });
  if (openReactionAction && !openReactionAction.contains(event.target)) {
    closeReactionPicker();
  }
});
document.addEventListener('keydown', event => {
  if (elements.mediaLightbox.open) {
    if (event.key === 'ArrowLeft' && activeLightboxItems.length > 1) {
      event.preventDefault();
      openMediaLightbox(
        activeLightboxItems,
        (activeLightboxIndex - 1 + activeLightboxItems.length) % activeLightboxItems.length
      );
      return;
    }
    if (event.key === 'ArrowRight' && activeLightboxItems.length > 1) {
      event.preventDefault();
      openMediaLightbox(activeLightboxItems, (activeLightboxIndex + 1) % activeLightboxItems.length);
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      activeLightboxZoomControls?.zoomIn();
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      activeLightboxZoomControls?.zoomOut();
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      activeLightboxZoomControls?.reset();
      return;
    }
    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      if (event.shiftKey) activeLightboxZoomControls?.rotateLeft();
      else activeLightboxZoomControls?.rotateRight();
      return;
    }
  }
  if (event.key === 'Escape') closeReactionPicker();
});
window.addEventListener('beforeunload', () => {
  window.clearInterval(postCooldownTimer);
  window.clearInterval(commentCooldownTimer);
  window.clearInterval(notificationTimer);
  window.clearTimeout(realtimeReloadTimer);
  window.clearTimeout(notificationRealtimeTimer);
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  releasePreparedItems(selectedPostMedia);
  commentPreviewUrls.forEach(urls => urls.forEach(url => URL.revokeObjectURL(url)));
});

init();
