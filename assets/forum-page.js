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
} from './supabase-client.js?v=20260730-5';

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
let loadSequence = 0;

function canInteract() {
  return currentProfile?.account_status === 'active';
}

function canModerate() {
  return canInteract() && ['moderator', 'admin'].includes(currentProfile?.role);
}

function authorOf(record) {
  return Array.isArray(record?.author) ? record.author[0] : record?.author;
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

function resetPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  selectedMediaFile = null;
  elements.media.value = '';
  elements.mediaPreview.replaceChildren();
  elements.mediaPreview.hidden = true;
}

function showMediaPreview(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  selectedMediaFile = null;
  elements.mediaPreview.replaceChildren();
  elements.mediaPreview.hidden = true;
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    elements.media.value = '';
    setInfo('Ảnh hoặc video phải nhỏ hơn 25 MB.', 'error');
    return;
  }
  const type = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('video/')
      ? 'video'
      : '';
  if (!type) {
    elements.media.value = '';
    setInfo('Chỉ hỗ trợ ảnh JPG, PNG, WebP, GIF hoặc video MP4, WebM, MOV.', 'error');
    return;
  }

  selectedMediaFile = file;
  previewUrl = URL.createObjectURL(file);
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
  elements.feedTitle.textContent = isQuestion ? 'Bài hỏi đáp mới nhất' : 'Bảng tin giải trí';
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
  const extension = (file.name.split('.').pop() || (file.type.startsWith('video/') ? 'mp4' : 'jpg'))
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const uniqueId = crypto.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const path = `${session.user.id}/${Date.now()}-${uniqueId}.${extension}`;
  const { error } = await supabase.storage
    .from('forum-media')
    .upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from('forum-media').getPublicUrl(path);
  return {
    path,
    url: data.publicUrl,
    type: file.type.startsWith('video/') ? 'video' : 'image'
  };
}

async function publishPost(event) {
  event.preventDefault();
  if (!canInteract()) {
    setInfo('Tài khoản đang bị hạn chế nên chưa thể đăng bài.', 'error');
    return;
  }

  const title = elements.title.value.trim();
  if (title.length < 3) {
    setInfo('Nội dung chính cần ít nhất 3 ký tự.', 'error');
    elements.title.focus();
    return;
  }
  const file = selectedMediaFile;
  if (file && file.size > 25 * 1024 * 1024) {
    setInfo('Ảnh hoặc video phải nhỏ hơn 25 MB.', 'error');
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
    setInfo('Đã đăng bài thành công.', 'success');
    await loadPosts();
  } catch (error) {
    if (uploaded?.path) {
      await supabase.storage.from('forum-media').remove([uploaded.path]);
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
    .limit(50);

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
  const avatar = card.querySelector('.post-avatar');
  avatar.src = author.avatar_url || 'avatar.png';
  avatar.alt = '';
  card.querySelector('.post-author strong').textContent = profileName(author);
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
  } else if (author.role && author.role !== 'member') {
    meta.append(chip(roleLabel(author.role)));
  }

  card.querySelector('.post-title').textContent = post.title;
  card.querySelector('.post-body').textContent = post.body || '';
  const hashtags = card.querySelector('.post-hashtags');
  (post.hashtags || []).forEach(value => {
    const tag = document.createElement('span');
    tag.textContent = `#${value}`;
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
  commentForm.addEventListener('submit', event => addComment(event, post, card));
  return fragment;
}

function renderPosts() {
  elements.feed.replaceChildren();
  elements.feedCount.textContent = `${posts.length} bài viết`;
  if (!posts.length) {
    const empty = document.createElement('div');
    empty.className = 'panel feed-empty';
    empty.textContent = currentCategory === 'question'
      ? 'Chưa có câu hỏi phù hợp. Hãy là người đăng bài đầu tiên.'
      : 'Bảng tin chưa có bài viết. Hãy chia sẻ điều thú vị đầu tiên.';
    elements.feed.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  posts.forEach(post => fragment.appendChild(renderPost(post)));
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
  if (!canInteract()) return;
  setBusy(button, true, 'Đang lưu...');
  try {
    const { error } = await supabase
      .from('forum_posts')
      .update({ is_solved: true })
      .eq('id', post.id);
    if (error) throw error;
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
    avatar.alt = '';
    const bubble = document.createElement('div');
    bubble.className = 'comment-bubble';
    const name = document.createElement('strong');
    name.textContent = profileName(author);
    const body = document.createElement('p');
    body.textContent = comment.body;
    const time = document.createElement('time');
    time.dateTime = comment.created_at;
    time.textContent = relativeTime(comment.created_at);
    bubble.append(name, body, time);
    item.append(avatar, bubble);

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
  const input = form.querySelector('input');
  const button = form.querySelector('button');
  const body = input.value.trim();
  if (!body) return;
  setBusy(button, true, '...');
  try {
    const { error } = await supabase.from('forum_comments').insert({
      post_id: post.id,
      author_id: session.user.id,
      body
    });
    if (error) throw error;
    input.value = '';
    post.commentCount += 1;
    updatePostStats(card, post);
    await loadComments(post, card);
  } catch (error) {
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
    const { error } = await supabase.from('forum_posts').delete().eq('id', post.id);
    if (error) throw error;
    if (post.media_path) {
      await supabase.storage.from('forum-media').remove([post.media_path]);
    }
    posts = posts.filter(item => item.id !== post.id);
    card.remove();
    elements.feedCount.textContent = `${posts.length} bài viết`;
    if (!posts.length) renderPosts();
    setInfo('Đã xóa bài viết.', 'success');
  } catch (error) {
    setBusy(button, false);
    setInfo(`Không thể xóa bài viết: ${humanizeAuthError(error)}`, 'error');
  }
}

function configureAccount() {
  const name = profileName(currentProfile, session.user);
  elements.viewer.querySelector('span:last-child').textContent =
    `${name} · ${roleLabel(currentProfile.role)} · ${statusLabel(currentProfile.account_status)}`;
  elements.composerName.textContent = name;
  elements.composerAvatar.src =
    currentProfile.avatar_url || session.user.user_metadata?.avatar_url || 'avatar.png';
  elements.readonly.hidden = canInteract();
  elements.composer.hidden = !canInteract();
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
elements.media.addEventListener('change', () => showMediaPreview(elements.media.files[0]));
elements.gradeFilter.addEventListener('change', loadPosts);
elements.statusFilter.addEventListener('change', loadPosts);
window.addEventListener('beforeunload', () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});

init();
