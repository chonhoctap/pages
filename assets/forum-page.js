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
  uploadToR2,
  deleteFromR2,
  IMAGE_OUTPUT_LIMIT,
  VIDEO_OUTPUT_LIMIT
} from './media-storage.js?v=20260730-1';

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
  publish: document.getElementById('publishButton'),
  feedTitle: document.getElementById('feedTitle'),
  feedCount: document.getElementById('feedCount'),
  search: document.getElementById('forumSearch'),
  sortButtons: document.querySelectorAll('[data-sort]'),
  gradeFilter: document.getElementById('gradeFilter'),
  statusFilter: document.getElementById('statusFilter'),
  feed: document.getElementById('postFeed'),
  template: document.getElementById('postTemplate'),
  sidebarTitle: document.getElementById('sidebarTitle'),
  sidebarTips: document.getElementById('sidebarTips')
};

let session;
let currentProfile;
let currentCategory = 'question';
let posts = [];
let previewUrl = '';
let selectedMediaFile = null;
let previewPrepareSequence = 0;
let previewPreparePromise = Promise.resolve();
let loadSequence = 0;
let currentSort = 'latest';
const commentPreviewUrls = new Map();
const commentPreparedFiles = new Map();
const commentPrepareSequences = new Map();
const commentPreparePromises = new Map();

function canInteract() {
  return currentProfile?.account_status === 'active';
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
  return '';
}

function uniqueMediaPath(file, prefix = '') {
  const extension = (file.name.split('.').pop() || (mediaKind(file) === 'video' ? 'mp4' : 'jpg'))
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const uniqueId = crypto.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${session.user.id}/${prefix}${Date.now()}-${uniqueId}.${extension}`;
}

function resetPreview() {
  previewPrepareSequence += 1;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  selectedMediaFile = null;
  elements.media.value = '';
  elements.mediaPreview.replaceChildren();
  elements.mediaPreview.hidden = true;
}

async function showMediaPreview(file) {
  const sequence = ++previewPrepareSequence;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  selectedMediaFile = null;
  elements.mediaPreview.replaceChildren();
  elements.mediaPreview.hidden = true;
  if (!file) return;
  const type = mediaKind(file);
  if (!type) {
    elements.media.value = '';
    setInfo('Chỉ hỗ trợ ảnh JPG, PNG, WebP, GIF hoặc video MP4, WebM, MOV.', 'error');
    return;
  }

  try {
    if (type === 'image') setInfo('Đang tối ưu ảnh về chất lượng 720p...', 'info');
    const prepared = await prepareMedia(file);
    if (sequence !== previewPrepareSequence) return;
    selectedMediaFile = prepared;
    previewUrl = URL.createObjectURL(prepared);
    if (type === 'image') {
      const saved = Math.max(0, file.size - prepared.size);
      const savedText = saved > 0
        ? `, giảm ${(saved / 1024 / 1024).toFixed(1)} MB`
        : '';
      setInfo(`Ảnh đã được tối ưu còn ${(prepared.size / 1024 / 1024).toFixed(2)} MB${savedText}.`, 'success');
    }
  } catch (error) {
    if (sequence !== previewPrepareSequence) return;
    elements.media.value = '';
    setInfo(error.message, 'error');
    return;
  }

  const preview = document.createElement(type === 'image' ? 'img' : 'video');
  preview.src = previewUrl;
  preview.alt = type === 'image' ? 'Ảnh xem trước' : '';
  if (type === 'video') preview.controls = true;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Bỏ ảnh hoặc video');
  remove.textContent = '×';
  remove.addEventListener('click', resetPreview);
  elements.mediaPreview.append(preview, remove);
  elements.mediaPreview.hidden = false;
}

function openComposer() {
  if (!canInteract()) {
    setInfo('Tài khoản đang bị hạn chế nên chưa thể đăng bài.', 'error');
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
        'Chia sẻ ảnh, video hoặc câu chuyện tích cực.',
        'Tôn trọng sự khác biệt của mọi thành viên.',
        'Không spam và không đăng thông tin riêng tư.'
      ];
  tips.forEach(text => {
    const item = document.createElement('li');
    item.textContent = text;
    elements.sidebarTips.appendChild(item);
  });
}

async function uploadMedia(file) {
  if (!file) return null;
  if (r2Enabled()) {
    return uploadToR2(session, file, { scope: 'post' });
  }
  const path = uniqueMediaPath(file);
  const { error } = await supabase.storage
    .from('forum-media')
    .upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from('forum-media').getPublicUrl(path);
  return {
    path,
    url: data.publicUrl,
    type: mediaKind(file)
  };
}

async function publishPost(event) {
  event.preventDefault();
  if (!canInteract()) {
    setInfo('Tài khoản đang bị hạn chế nên chưa thể đăng bài.', 'error');
    return;
  }
  await previewPreparePromise;

  const title = elements.title.value.trim();
  if (title.length < 3) {
    setInfo('Nội dung chính cần ít nhất 3 ký tự.', 'error');
    elements.title.focus();
    return;
  }
  const file = selectedMediaFile;
  const fileLimit = mediaKind(file) === 'image' ? IMAGE_OUTPUT_LIMIT : VIDEO_OUTPUT_LIMIT;
  if (file && file.size > fileLimit) {
    setInfo(
      mediaKind(file) === 'image'
        ? 'Ảnh sau khi tối ưu phải nhỏ hơn 2 MB.'
        : 'Video phải nhỏ hơn 25 MB.',
      'error'
    );
    return;
  }

  let uploaded;
  setBusy(elements.publish, true, 'Đang đăng...');
  try {
    uploaded = await uploadMedia(file);
    const payload = {
      author_id: session.user.id,
      category: currentCategory,
      title,
      body: elements.body.value.trim() || null,
      hashtags: parseHashtags(elements.hashtags.value),
      subject: currentCategory === 'question' ? elements.subject.value : null,
      grade: currentCategory === 'question' ? elements.grade.value : null,
      is_solved: false,
      media_url: uploaded?.url || null,
      media_path: uploaded?.path || null,
      media_type: uploaded?.type || null
    };
    const { error } = await supabase.from('forum_posts').insert(payload);
    if (error) throw error;

    elements.form.reset();
    resetPreview();
    closeComposer();
    setInfo('Đã đăng bài thành công.', 'success');
    await loadPosts();
  } catch (error) {
    if (uploaded?.path) {
      await removeStoredMedia(uploaded.path, 'forum-media');
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

function trendScore(post) {
  const engagement =
    (post.likeCount || 0) * 3
    + (post.commentCount || 0) * 2
    + (post.shareCount || 0) * 4;
  const ageHours = Math.max(0, (Date.now() - new Date(post.created_at).getTime()) / 3600000);
  return (engagement + 1) / (1 + ageHours / 36);
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
    .order('created_at', { ascending: false })
    .limit(100);

  if (currentCategory === 'question' && elements.gradeFilter.value !== 'all') {
    query = query.eq('grade', elements.gradeFilter.value);
  }
  if (currentCategory === 'question' && elements.statusFilter.value !== 'all') {
    query = query.eq('is_solved', elements.statusFilter.value === 'solved');
  }

  try {
    const { data, error } = await query;
    if (error) throw error;
    if (sequence !== loadSequence) return;
    posts = data || [];

    if (posts.length) {
      const ids = posts.map(post => post.id);
      const [likesResult, commentsResult, sharesResult] = await Promise.all([
        supabase.from('forum_likes').select('post_id, user_id').in('post_id', ids),
        supabase.from('forum_comments').select('post_id').in('post_id', ids),
        supabase.from('forum_shares').select('post_id').in('post_id', ids)
      ]);
      if (likesResult.error) throw likesResult.error;
      if (commentsResult.error) throw commentsResult.error;
      if (sharesResult.error) throw sharesResult.error;
      if (sequence !== loadSequence) return;

      const likeCounts = countByPost(likesResult.data);
      const commentCounts = countByPost(commentsResult.data);
      const shareCounts = countByPost(sharesResult.data);
      const liked = new Set(
        (likesResult.data || [])
          .filter(row => row.user_id === session.user.id)
          .map(row => row.post_id)
      );
      posts.forEach(post => {
        post.likeCount = likeCounts.get(post.id) || 0;
        post.commentCount = commentCounts.get(post.id) || 0;
        post.shareCount = shareCounts.get(post.id) || 0;
        post.liked = liked.has(post.id);
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
  left.textContent = `${post.likeCount || 0} lượt thích`;
  const right = document.createElement('span');
  right.textContent = `${post.commentCount || 0} bình luận · ${post.shareCount || 0} lượt chia sẻ`;
  stats.replaceChildren(left, right);
  card.querySelector('[data-action="like"]').classList.toggle('liked', Boolean(post.liked));
}

function chip(text, className = '') {
  const item = document.createElement('span');
  item.className = `post-chip ${className}`.trim();
  item.textContent = text;
  return item;
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

  const media = card.querySelector('.post-media');
  if (post.media_url) {
    const content = document.createElement(post.media_type === 'video' ? 'video' : 'img');
    content.src = post.media_url;
    if (post.media_type === 'video') {
      content.controls = true;
      content.preload = 'metadata';
    } else {
      content.alt = `Ảnh trong bài của ${profileName(author)}`;
      content.loading = 'lazy';
    }
    media.appendChild(content);
  }

  updatePostStats(card, post);
  const likeButton = card.querySelector('[data-action="like"]');
  likeButton.addEventListener('click', () => toggleLike(post, card, likeButton));
  card.querySelector('[data-action="comment"]')
    .addEventListener('click', () => toggleComments(post, card));
  card.querySelector('[data-action="share"]')
    .addEventListener('click', () => sharePost(post, card));

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
    const task = showCommentMediaPreview(commentForm, commentMediaInput.files?.[0]);
    commentPreparePromises.set(commentForm, task);
  });
  commentForm.addEventListener('submit', event => addComment(event, post, card));
  return fragment;
}

function renderPosts() {
  const visible = visiblePosts();
  commentPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  commentPreviewUrls.clear();
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

async function toggleLike(post, card, button) {
  if (!canInteract()) {
    setInfo('Tài khoản đang tạm khóa nên chưa thể thích bài viết.', 'error');
    return;
  }
  button.disabled = true;
  try {
    const query = post.liked
      ? supabase
          .from('forum_likes')
          .delete()
          .eq('post_id', post.id)
          .eq('user_id', session.user.id)
      : supabase
          .from('forum_likes')
          .insert({ post_id: post.id, user_id: session.user.id });
    const { error } = await query;
    if (error) throw error;
    post.liked = !post.liked;
    post.likeCount += post.liked ? 1 : -1;
    updatePostStats(card, post);
  } catch (error) {
    setInfo(`Không thể cập nhật lượt thích: ${humanizeAuthError(error)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function toggleComments(post, card) {
  const panel = card.querySelector('.comment-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden && !panel.dataset.loaded) {
    await loadComments(post, card);
  }
}

function commentMediaError(file) {
  const type = mediaKind(file);
  if (!type) return 'Chỉ hỗ trợ ảnh JPG, PNG, WebP, GIF hoặc video MP4, WebM, MOV.';
  const limit = type === 'image'
    ? IMAGE_OUTPUT_LIMIT
    : r2Enabled()
      ? VIDEO_OUTPUT_LIMIT
      : 8 * 1024 * 1024;
  if (file.size > limit) {
    return type === 'image'
      ? 'Ảnh bình luận phải nhỏ hơn 2 MB.'
      : `Video bình luận phải nhỏ hơn ${r2Enabled() ? 25 : 8} MB.`;
  }
  return '';
}

function resetCommentMedia(form) {
  commentPrepareSequences.set(form, (commentPrepareSequences.get(form) || 0) + 1);
  const currentUrl = commentPreviewUrls.get(form);
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  commentPreviewUrls.delete(form);
  commentPreparedFiles.delete(form);
  commentPreparePromises.delete(form);
  const input = form.querySelector('.comment-media-input');
  const preview = form.querySelector('.comment-media-preview');
  input.value = '';
  preview.replaceChildren();
  preview.hidden = true;
}

async function showCommentMediaPreview(form, file) {
  resetCommentMedia(form);
  if (!file) return;
  const sequence = commentPrepareSequences.get(form);
  let prepared;
  try {
    if (mediaKind(file) === 'image') setInfo('Đang tối ưu ảnh bình luận...', 'info');
    prepared = await prepareMedia(file);
    if (sequence !== commentPrepareSequences.get(form)) return;
  } catch (error) {
    if (sequence !== commentPrepareSequences.get(form)) return;
    setInfo(error.message, 'error');
    return;
  }
  const invalid = commentMediaError(prepared);
  if (invalid) return setInfo(invalid, 'error');

  commentPreparedFiles.set(form, prepared);
  const previewUrl = URL.createObjectURL(prepared);
  commentPreviewUrls.set(form, previewUrl);
  const preview = form.querySelector('.comment-media-preview');
  const content = document.createElement(mediaKind(prepared) === 'video' ? 'video' : 'img');
  content.src = previewUrl;
  if (mediaKind(prepared) === 'video') content.controls = true;
  else content.alt = 'Ảnh đính kèm bình luận';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Bỏ ảnh hoặc video khỏi bình luận');
  remove.addEventListener('click', () => resetCommentMedia(form));
  preview.append(content, remove);
  preview.hidden = false;
}

async function uploadCommentMedia(file, postId) {
  if (!file) return null;
  const invalid = commentMediaError(file);
  if (invalid) throw new Error(invalid);
  if (r2Enabled()) {
    return uploadToR2(session, file, { scope: 'comment', postId });
  }
  const path = uniqueMediaPath(file, `${postId}/`);
  const { error } = await supabase.storage
    .from('forum-comment-media')
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type
    });
  if (error) throw error;
  const { data } = supabase.storage.from('forum-comment-media').getPublicUrl(path);
  return {
    path,
    url: data.publicUrl,
    type: mediaKind(file)
  };
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
    renderComments(data || [], post, card);
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
    if (comment.media_url) {
      const media = document.createElement(comment.media_type === 'video' ? 'video' : 'img');
      media.className = 'comment-media';
      media.src = comment.media_url;
      if (comment.media_type === 'video') {
        media.controls = true;
        media.preload = 'metadata';
      } else {
        media.alt = `Ảnh trong bình luận của ${profileName(author)}`;
        media.loading = 'lazy';
      }
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
        if (comment.media_path) {
          await removeStoredMedia(comment.media_path, 'forum-comment-media');
        }
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
  const mediaInput = form.querySelector('.comment-media-input');
  const button = form.querySelector('.comment-submit');
  const body = input.value.trim();
  const file = commentPreparedFiles.get(form) || mediaInput.files?.[0];
  if (!body && !file) return;
  const invalid = file ? commentMediaError(file) : '';
  if (invalid) {
    setInfo(invalid, 'error');
    return;
  }
  let uploaded;
  setBusy(button, true, '...');
  try {
    uploaded = await uploadCommentMedia(file, post.id);
    const { error } = await supabase.from('forum_comments').insert({
      post_id: post.id,
      author_id: session.user.id,
      body: body || null,
      media_url: uploaded?.url || null,
      media_path: uploaded?.path || null,
      media_type: uploaded?.type || null
    });
    if (error) throw error;
    input.value = '';
    resetCommentMedia(form);
    post.commentCount += 1;
    updatePostStats(card, post);
    await loadComments(post, card);
  } catch (error) {
    if (uploaded?.path) {
      await removeStoredMedia(uploaded.path, 'forum-comment-media');
    }
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

async function deletePost(post, card, button) {
  if (!window.confirm('Bạn chắc chắn muốn xóa bài viết này?')) return;
  setBusy(button, true, '...');
  try {
    const { data: commentMedia, error: commentMediaError } = await supabase
      .from('forum_comments')
      .select('media_path')
      .eq('post_id', post.id)
      .not('media_path', 'is', null);
    if (commentMediaError) throw commentMediaError;
    const commentPaths = (commentMedia || []).map(item => item.media_path).filter(Boolean);
    if (commentPaths.length) {
      await Promise.all(
        commentPaths.map(path => removeStoredMedia(path, 'forum-comment-media'))
      );
    }
    const { error } = await supabase.from('forum_posts').delete().eq('id', post.id);
    if (error) throw error;
    if (post.media_path) {
      await removeStoredMedia(post.media_path, 'forum-media');
    }
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
  elements.viewer.querySelector('span:last-child').textContent =
    `${name} · ${roleLabel(currentProfile.role)} · ${statusLabel(currentProfile.account_status)}`;
  elements.composerName.textContent = name;
  elements.composerAvatar.src =
    currentProfile.avatar_url || session.user.user_metadata?.avatar_url || 'avatar.png';
  elements.readonly.hidden = canInteract();
  elements.openComposer.hidden = !canInteract();
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
  previewPreparePromise = showMediaPreview(elements.media.files[0]);
});
elements.openComposer.addEventListener('click', openComposer);
elements.closeComposer.addEventListener('click', closeComposer);
elements.composerDialog.addEventListener('click', event => {
  if (event.target === elements.composerDialog) closeComposer();
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
window.addEventListener('beforeunload', () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  commentPreviewUrls.forEach(url => URL.revokeObjectURL(url));
});

init();
