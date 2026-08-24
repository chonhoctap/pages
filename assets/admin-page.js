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
} from './supabase-client.js?v=20260809-1';

initThemeToggle();

const ROLE_ORDER = ['member', 'vip', 'moderator', 'admin'];
const POST_COOLDOWN_STORAGE_PREFIX = 'chonhoctap-forum-post-cooldown:';
const ROLE_DESCRIPTIONS = {
  member: 'Quyền cơ bản của thành viên thường',
  vip: 'Quyền chức năng của thành viên VIP',
  moderator: 'Staff hỗ trợ duyệt và ẩn bài viết',
  admin: 'Quản trị viên cao nhất của hệ thống'
};

const PERMISSION_DEFINITIONS = [
  {
    key: 'forum.access',
    title: 'Truy cập diễn đàn',
    description: 'Được mở và đọc nội dung trong mục Diễn đàn.',
    group: 'Diễn đàn'
  },
  {
    key: 'forum.create_post',
    title: 'Đăng bài viết',
    description: 'Được tạo bài Hỏi đáp hoặc Giải trí mới.',
    group: 'Diễn đàn'
  },
  {
    key: 'forum.create_comment',
    title: 'Gửi bình luận',
    description: 'Được bình luận, trả lời và đính kèm media theo đặc quyền.',
    group: 'Diễn đàn'
  },
  {
    key: 'forum.react',
    title: 'Thả cảm xúc',
    description: 'Được thả hoặc đổi cảm xúc trên bài viết.',
    group: 'Tương tác'
  },
  {
    key: 'forum.share',
    title: 'Chia sẻ bài viết',
    description: 'Được chia sẻ hoặc sao chép liên kết bài viết.',
    group: 'Tương tác'
  },
  {
    key: 'forum.report',
    title: 'Báo cáo bài viết',
    description: 'Được gửi báo cáo bài viết đến hộp thư admin.',
    group: 'Tương tác'
  },
  {
    key: 'forum.moderate_posts',
    title: 'Duyệt và ẩn bài viết',
    description: 'Quyền Staff: duyệt, từ chối, ẩn hoặc hiện bài; không được xóa.',
    group: 'Kiểm duyệt',
    sensitive: true
  },
  {
    key: 'forum.review_reports',
    title: 'Xử lý báo cáo',
    description: 'Xem và quyết định kết quả báo cáo. Luôn chỉ dành cho admin.',
    group: 'Quản trị',
    adminOnly: true
  },
  {
    key: 'forum.delete_any_content',
    title: 'Xóa nội dung người khác',
    description: 'Xóa bài viết hoặc bình luận của tài khoản khác. Luôn chỉ dành cho admin.',
    group: 'Quản trị',
    adminOnly: true
  },
  {
    key: 'admin.manage_users',
    title: 'Quản lý tài khoản',
    description: 'Đổi role, tạm khóa hoặc cấm tài khoản. Luôn chỉ dành cho admin.',
    group: 'Quản trị',
    adminOnly: true
  },
  {
    key: 'admin.manage_role_permissions',
    title: 'Cấu hình quyền role',
    description: 'Bật hoặc tắt quyền trong trang này. Luôn chỉ dành cho admin.',
    group: 'Quản trị',
    adminOnly: true
  }
];

const elements = {
  loading: document.getElementById('adminLoading'),
  denied: document.getElementById('adminDenied'),
  content: document.getElementById('adminContent'),
  list: document.getElementById('memberList'),
  search: document.getElementById('memberSearch'),
  message: document.getElementById('adminMessage'),
  counts: document.getElementById('roleCounts'),
  logoutButton: document.getElementById('logoutButton'),
  tabs: document.querySelectorAll('[data-admin-tab]'),
  accountsPanel: document.getElementById('accountsPanel'),
  permissionsPanel: document.getElementById('permissionsPanel'),
  permissionLoading: document.getElementById('permissionLoading'),
  permissionGrid: document.getElementById('permissionGrid'),
  consolePanel: document.getElementById('consolePanel'),
  consoleForm: document.getElementById('consoleForm'),
  consoleInput: document.getElementById('consoleInput'),
  consoleRunButton: document.getElementById('consoleRunButton'),
  consoleOutput: document.getElementById('consoleOutput'),
  consoleTargets: document.getElementById('consoleTargets'),
  consoleConfirm: document.getElementById('consoleConfirm'),
  consoleConfirmText: document.getElementById('consoleConfirmText'),
  consoleCancelButton: document.getElementById('consoleCancelButton'),
  consoleConfirmButton: document.getElementById('consoleConfirmButton'),
  consoleRefreshButton: document.getElementById('consoleRefreshButton'),
  consoleHistory: document.getElementById('consoleHistory'),
  consoleExamples: document.querySelectorAll('[data-console-command]')
};

let session;
let currentProfile;
let profiles = [];
let permissionRows = [];
let pendingDestructiveCommand = '';

function renderCounts() {
  const counts = profiles.reduce((result, item) => {
    result[item.role] = (result[item.role] || 0) + 1;
    result[item.account_status] = (result[item.account_status] || 0) + 1;
    return result;
  }, {});
  elements.counts.textContent =
    `${profiles.length} tài khoản · ${counts.admin || 0} quản trị · `
    + `${counts.moderator || 0} Staff · ${counts.vip || 0} VIP · `
    + `${counts.suspended || 0} tạm khóa · ${counts.banned || 0} bị cấm`;
}

function createSelect(options, selectedValue, label) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  options.forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = selectedValue === value;
    select.appendChild(option);
  });
  return select;
}

function createMemberCard(member) {
  const card = document.createElement('article');
  card.className = 'member-card';

  const avatar = document.createElement('img');
  avatar.className = 'member-avatar';
  avatar.src = member.avatar_url || 'avatar.webp';
  avatar.alt = '';
  avatar.loading = 'lazy';
  avatar.decoding = 'async';

  const info = document.createElement('div');
  info.className = 'member-info';
  const name = document.createElement('strong');
  name.textContent = profileName(member);
  const username = document.createElement('span');
  username.textContent = `@${member.username}`;
  const status = document.createElement('span');
  status.className = 'status-badge';
  status.dataset.status = member.account_status;
  status.textContent = statusLabel(member.account_status);
  const identity = document.createElement('div');
  identity.className = 'member-identity';
  identity.append(username, status);
  const joined = document.createElement('small');
  joined.textContent = `Tham gia ${new Intl.DateTimeFormat('vi-VN').format(new Date(member.created_at))}`;
  info.append(name, identity, joined);

  const controls = document.createElement('div');
  controls.className = 'access-controls';
  const roleSelect = createSelect([
    ['member', 'Thành viên'],
    ['vip', 'Thành viên VIP'],
    ['moderator', 'Staff'],
    ['admin', 'Quản trị viên']
  ], member.role, `Role của ${member.username}`);
  const statusSelect = createSelect([
    ['active', 'Hoạt động'],
    ['suspended', 'Tạm khóa'],
    ['banned', 'Cấm tài khoản']
  ], member.account_status, `Trạng thái của ${member.username}`);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'button button-small';
  save.textContent = 'Cập nhật';
  save.addEventListener('click', async () => {
    if (roleSelect.value === member.role && statusSelect.value === member.account_status) {
      showMessage(elements.message, 'Role và trạng thái tài khoản này chưa thay đổi.', 'info');
      return;
    }
    if (
      member.id === session.user.id
      && (roleSelect.value !== 'admin' || statusSelect.value !== 'active')
    ) {
      showMessage(
        elements.message,
        'Bạn không thể tự hạ quyền hoặc khóa tài khoản quản trị của chính mình.',
        'error'
      );
      roleSelect.value = member.role;
      statusSelect.value = member.account_status;
      return;
    }

    const sensitiveChange =
      roleSelect.value === 'admin'
      || member.role === 'admin'
      || statusSelect.value !== 'active';
    if (
      sensitiveChange
      && !window.confirm(
        `Xác nhận cập nhật @${member.username} thành `
        + `${roleLabel(roleSelect.value)} · ${statusLabel(statusSelect.value)}?`
      )
    ) {
      roleSelect.value = member.role;
      statusSelect.value = member.account_status;
      return;
    }

    roleSelect.disabled = true;
    statusSelect.disabled = true;
    setBusy(save, true, 'Đang lưu...');
    try {
      const { error } = await supabase.rpc('admin_update_user_access', {
        target_user_id: member.id,
        target_role: roleSelect.value,
        target_status: statusSelect.value
      });
      if (error) throw error;
      member.role = roleSelect.value;
      member.account_status = statusSelect.value;
      status.dataset.status = member.account_status;
      status.textContent = statusLabel(member.account_status);
      renderCounts();
      showMessage(
        elements.message,
        `Đã cập nhật @${member.username}: ${roleLabel(member.role)} · `
        + `${statusLabel(member.account_status)}.`,
        'success'
      );
    } catch (error) {
      roleSelect.value = member.role;
      statusSelect.value = member.account_status;
      showMessage(elements.message, humanizeAuthError(error), 'error');
    } finally {
      roleSelect.disabled = false;
      statusSelect.disabled = false;
      setBusy(save, false);
    }
  });

  controls.append(roleSelect, statusSelect, save);
  card.append(avatar, info, controls);
  return card;
}

function renderMembers() {
  const keyword = elements.search.value.trim().toLocaleLowerCase('vi');
  const filtered = profiles.filter(member =>
    (
      `${member.username} ${member.display_name || ''} ${member.role} ${member.account_status} `
      + `${roleLabel(member.role)} ${statusLabel(member.account_status)}`
    )
      .toLocaleLowerCase('vi')
      .includes(keyword)
  );
  const fragment = document.createDocumentFragment();
  filtered.forEach(member => fragment.appendChild(createMemberCard(member)));
  elements.list.replaceChildren(fragment);
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Không tìm thấy tài khoản phù hợp.';
    elements.list.appendChild(empty);
  }
}

function renderConsoleTargets() {
  const fragment = document.createDocumentFragment();
  profiles.forEach(member => {
    const option = document.createElement('option');
    option.value = `@${member.username}`;
    option.label = `${profileName(member)} · ${roleLabel(member.role)}`;
    fragment.appendChild(option);
  });
  elements.consoleTargets.replaceChildren(fragment);
}

function permissionRow(role, permissionKey) {
  return permissionRows.find(item =>
    item.role_name === role && item.permission_key === permissionKey
  );
}

function refreshPermissionCount(role) {
  const card = elements.permissionGrid.querySelector(
    `.role-permission-card[data-role="${CSS.escape(role)}"]`
  );
  if (!card) return;
  const enabledCount = PERMISSION_DEFINITIONS.filter(definition =>
    permissionRow(role, definition.key)?.allowed
  ).length;
  card.querySelector('.permission-count').textContent =
    `${enabledCount}/${PERMISSION_DEFINITIONS.length} quyền`;
}

function permissionIsLocked(role, definition) {
  if (definition.adminOnly) return true;
  if (definition.key === 'forum.moderate_posts') return role !== 'moderator';
  return false;
}

function lockedPermissionLabel(role, definition) {
  if (definition.key === 'forum.moderate_posts') {
    if (role === 'admin') return 'Admin luôn có quyền';
    if (role !== 'moderator') return 'Chỉ Staff hoặc admin';
  }
  if (definition.adminOnly) {
    return role === 'admin' ? 'Quyền admin bắt buộc' : 'Chỉ dành cho admin';
  }
  return '';
}

async function updatePermission(role, definition, input, rowElement) {
  const row = permissionRow(role, definition.key);
  if (!row || permissionIsLocked(role, definition)) return;
  const nextAllowed = input.checked;

  const confirmation = definition.key === 'forum.access' && !nextAllowed
    ? `Tắt quyền truy cập diễn đàn của role ${roleLabel(role)}? Các quyền diễn đàn khác sẽ không hoạt động.`
    : definition.sensitive
      ? `${nextAllowed ? 'Cấp' : 'Thu hồi'} quyền duyệt và ẩn bài của role ${roleLabel(role)}?`
      : '';
  if (confirmation && !window.confirm(confirmation)) {
    input.checked = row.allowed;
    return;
  }

  input.disabled = true;
  rowElement.classList.add('saving');
  try {
    const { data, error } = await supabase.rpc('admin_update_role_permission', {
      target_role_name: role,
      target_permission_key: definition.key,
      target_allowed: nextAllowed
    });
    if (error) throw error;
    if (!data) throw new Error('Database không xác nhận thay đổi quyền.');
    row.allowed = nextAllowed;
    rowElement.classList.toggle('enabled', nextAllowed);
    rowElement.querySelector('.permission-state').textContent = nextAllowed ? 'Đang bật' : 'Đang tắt';
    refreshPermissionCount(role);
    showMessage(
      elements.message,
      `Đã ${nextAllowed ? 'bật' : 'tắt'} “${definition.title}” cho role ${roleLabel(role)}.`,
      'success'
    );
  } catch (error) {
    input.checked = row.allowed;
    showMessage(elements.message, humanizeAuthError(error), 'error');
  } finally {
    input.disabled = false;
    rowElement.classList.remove('saving');
  }
}

function createPermissionItem(role, definition) {
  const row = permissionRow(role, definition.key) || { allowed: false };
  const locked = permissionIsLocked(role, definition);
  const item = document.createElement('div');
  item.className = 'permission-item';
  item.classList.toggle('enabled', row.allowed);
  item.classList.toggle('locked', locked);

  const copy = document.createElement('div');
  copy.className = 'permission-copy';
  const titleLine = document.createElement('div');
  titleLine.className = 'permission-title-line';
  const title = document.createElement('strong');
  title.textContent = definition.title;
  const group = document.createElement('span');
  group.textContent = definition.group;
  titleLine.append(title, group);
  const description = document.createElement('p');
  description.textContent = definition.description;
  copy.append(titleLine, description);

  const control = document.createElement('div');
  control.className = 'permission-control';
  const state = document.createElement('span');
  state.className = 'permission-state';
  state.textContent = locked
    ? lockedPermissionLabel(role, definition)
    : row.allowed ? 'Đang bật' : 'Đang tắt';
  const label = document.createElement('label');
  label.className = 'permission-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(row.allowed);
  input.disabled = locked;
  input.setAttribute('aria-label', `${definition.title} của ${roleLabel(role)}`);
  const slider = document.createElement('span');
  slider.setAttribute('aria-hidden', 'true');
  label.append(input, slider);
  control.append(state, label);
  item.append(copy, control);

  input.addEventListener('change', () => updatePermission(role, definition, input, item));
  return item;
}

function renderPermissions() {
  const fragment = document.createDocumentFragment();
  ROLE_ORDER.forEach(role => {
    const card = document.createElement('article');
    card.className = 'role-permission-card';
    card.dataset.role = role;

    const header = document.createElement('header');
    const heading = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = 'role-permission-badge';
    badge.textContent = roleLabel(role);
    const description = document.createElement('p');
    description.textContent = ROLE_DESCRIPTIONS[role];
    heading.append(badge, description);
    const enabledCount = PERMISSION_DEFINITIONS.filter(definition =>
      permissionRow(role, definition.key)?.allowed
    ).length;
    const count = document.createElement('span');
    count.className = 'permission-count';
    count.textContent = `${enabledCount}/${PERMISSION_DEFINITIONS.length} quyền`;
    header.append(heading, count);

    const list = document.createElement('div');
    list.className = 'permission-list';
    PERMISSION_DEFINITIONS.forEach(definition => {
      list.appendChild(createPermissionItem(role, definition));
    });
    card.append(header, list);
    fragment.appendChild(card);
  });
  elements.permissionGrid.replaceChildren(fragment);
  elements.permissionLoading.hidden = true;
  elements.permissionGrid.hidden = false;
}

function switchAdminTab(tabName) {
  const selected = ['accounts', 'permissions', 'console'].includes(tabName)
    ? tabName
    : 'accounts';
  elements.accountsPanel.hidden = selected !== 'accounts';
  elements.permissionsPanel.hidden = selected !== 'permissions';
  elements.consolePanel.hidden = selected !== 'console';
  elements.tabs.forEach(tab => {
    const active = tab.dataset.adminTab === selected;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  window.history.replaceState(null, '', `#${selected}`);
  if (selected === 'console') {
    requestAnimationFrame(() => elements.consoleInput.focus({ preventScroll: true }));
  }
}

async function loadMembers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, role, account_status, created_at')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  profiles = data || [];
  renderCounts();
  renderMembers();
  renderConsoleTargets();
}

async function loadPermissions() {
  const { data, error } = await supabase.rpc('admin_list_role_permissions');
  if (error) throw error;
  permissionRows = data || [];
  renderPermissions();
}

function commandIsDestructive(command) {
  const normalized = command.trim();
  return /^(?:(posts|comments|content)\s+delete-all|delete-all\s+(posts|comments|content))\s+\S+$/iu.test(normalized)
    || /^(?:(role|status)\s+set|set\s+(role|status))\s+\S+\s+\S+$/iu.test(normalized);
}

function consoleDateTime(value) {
  if (!value) return 'Không còn thời gian chờ';
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date(value));
}

function cooldownDisplayValue(result, type) {
  const value = result.cooldowns?.[type];
  if (!value || result.cooldownFormat === 'available_at') return value;
  const delayMinutes = type === 'post' ? 15 : 2;
  return new Date(new Date(value).getTime() + delayMinutes * 60 * 1000).toISOString();
}

function formatConsoleResult(data) {
  const result = data?.result || {};
  if (data?.action === 'help') {
    return (result.commands || [])
      .map(item => `${item.syntax}\n  ${item.description}`)
      .join('\n\n');
  }
  if (data?.action === 'user.info') {
    return [
      `Tài khoản: @${result.user?.username || data.target?.username || '—'}`,
      `Role: ${roleLabel(result.user?.role || 'member')}`,
      `Trạng thái: ${statusLabel(result.user?.account_status || 'active')}`,
      `Bài viết: ${result.counts?.posts || 0} · Bình luận: ${result.counts?.comments || 0}`,
      `Được đăng bài lúc: ${consoleDateTime(cooldownDisplayValue(result, 'post'))}`,
      `Được bình luận lúc: ${consoleDateTime(cooldownDisplayValue(result, 'comment'))}`
    ].join('\n');
  }
  if (['cooldown.clear', 'post_cooldown.clear', 'comment_cooldown.clear'].includes(data?.action)) {
    return `${result.message || 'Đã xử lý thời gian chờ.'}\nĐã xác minh lại trong database.`;
  }
  if (['role.set', 'status.set'].includes(data?.action)) {
    return [
      `Đã cập nhật @${data.target?.username || '—'}.`,
      `${roleLabel(result.before?.role)} · ${statusLabel(result.before?.status)}`,
      `→ ${roleLabel(result.after?.role)} · ${statusLabel(result.after?.status)}`,
      'Database đã xác nhận trạng thái mới.'
    ].join('\n');
  }
  if (['posts.delete_all', 'comments.delete_all', 'content.delete_all'].includes(data?.action)) {
    return [
      `Đã xóa ${result.deleted?.posts || 0} bài viết và ${result.deleted?.comments || 0} bình luận trực tiếp.`,
      result.cascadedComments ? `${result.cascadedComments} bình luận liên quan được xóa theo bài viết.` : '',
      `Đã xóa ${result.media?.r2 || 0} tệp R2 và ${result.media?.supabase || 0} tệp Supabase Storage.`,
      result.verified ? 'Đã kiểm tra lại: không còn nội dung thuộc phạm vi lệnh.' : ''
    ].filter(Boolean).join('\n');
  }
  return result;
}

function consoleTimestamp() {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date());
}

function appendConsoleOutput(title, payload, type = 'info') {
  const block = document.createElement('div');
  block.className = `console-output-block ${type}`;
  const heading = document.createElement('strong');
  heading.textContent = `[${consoleTimestamp()}] ${title}`;
  const content = document.createElement('pre');
  content.textContent = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload, null, 2);
  block.append(heading, content);
  if (elements.consoleOutput.childNodes.length === 1
    && elements.consoleOutput.firstChild?.nodeType === Node.TEXT_NODE) {
    elements.consoleOutput.replaceChildren(block);
  } else {
    elements.consoleOutput.appendChild(block);
  }
  while (elements.consoleOutput.children.length > 30) {
    elements.consoleOutput.firstElementChild?.remove();
  }
  elements.consoleOutput.scrollTop = elements.consoleOutput.scrollHeight;
}

async function edgeFunctionError(error) {
  const fallback = humanizeAuthError(error);
  const response = error?.context;
  if (!response || typeof response.clone !== 'function') return fallback;
  try {
    const payload = await response.clone().json();
    return payload?.error || fallback;
  } catch {
    return fallback;
  }
}

function commandTargetName(targetId) {
  const target = profiles.find(member => member.id === targetId);
  return target ? `@${target.username}` : targetId ? targetId.slice(0, 8) : '—';
}

function renderConsoleHistory(rows) {
  const fragment = document.createDocumentFragment();
  (rows || []).forEach(row => {
    const item = document.createElement('article');
    item.className = 'console-history-item';
    item.dataset.status = row.status;
    const top = document.createElement('div');
    const command = document.createElement('code');
    command.textContent = row.command_text;
    const status = document.createElement('span');
    status.textContent = row.status === 'succeeded'
      ? 'Thành công'
      : row.status === 'failed' ? 'Thất bại' : 'Đang chạy';
    top.append(command, status);
    const meta = document.createElement('small');
    const created = new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'short',
      timeStyle: 'medium'
    }).format(new Date(row.created_at));
    meta.textContent = `${created} · ${commandTargetName(row.target_user_id)}`;
    item.append(top, meta);
    if (row.error_message) {
      const error = document.createElement('p');
      error.textContent = row.error_message;
      item.appendChild(error);
    }
    fragment.appendChild(item);
  });
  elements.consoleHistory.replaceChildren(fragment);
  if (!rows?.length) {
    const empty = document.createElement('div');
    empty.className = 'console-history-empty';
    empty.textContent = 'Chưa có lệnh nào trong nhật ký.';
    elements.consoleHistory.appendChild(empty);
  }
}

async function loadConsoleHistory() {
  elements.consoleRefreshButton.disabled = true;
  try {
    const { data, error } = await supabase
      .from('admin_console_logs')
      .select('id, actor_id, target_user_id, command_text, action, status, result, error_message, created_at, finished_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    renderConsoleHistory(data || []);
  } catch (error) {
    elements.consoleHistory.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'console-history-empty error';
    empty.textContent = `${humanizeAuthError(error)} Hãy chạy admin_console_migration.sql.`;
    elements.consoleHistory.appendChild(empty);
  } finally {
    elements.consoleRefreshButton.disabled = false;
  }
}

async function runConsoleCommand(command, confirm = false) {
  setBusy(elements.consoleRunButton, true, 'Đang chạy...');
  elements.consoleInput.disabled = true;
  appendConsoleOutput(`admin $ ${command}`, 'Đang gửi lệnh đến máy chủ...', 'pending');
  try {
    const { data, error } = await supabase.functions.invoke('admin-console', {
      body: { command, confirm }
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Máy chủ không xác nhận kết quả.');
    appendConsoleOutput('Hoàn tất', formatConsoleResult(data), 'success');
    if (
      ['cooldown.clear', 'post_cooldown.clear'].includes(data.action)
      && data.target?.id
    ) {
      try {
        window.localStorage.removeItem(
          `${POST_COOLDOWN_STORAGE_PREFIX}${data.target.id}`
        );
      } catch {
        // Forum vẫn tự hỏi lại Supabase khi localStorage bị chặn.
      }
    }
    if (['role.set', 'status.set'].includes(data.action)) await loadMembers();
    await loadConsoleHistory();
  } catch (error) {
    const message = await edgeFunctionError(error);
    appendConsoleOutput('Lệnh thất bại', message, 'error');
    showMessage(elements.message, message, 'error');
  } finally {
    elements.consoleInput.disabled = false;
    setBusy(elements.consoleRunButton, false);
    elements.consoleInput.focus();
  }
}

function requestConsoleExecution(command) {
  const normalized = command.trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    appendConsoleOutput('Chưa có lệnh', 'Nhập lệnh hoặc chọn một gợi ý bên dưới.', 'error');
    return;
  }
  if (commandIsDestructive(normalized)) {
    pendingDestructiveCommand = normalized;
    elements.consoleConfirmText.textContent = normalized;
    elements.consoleConfirm.hidden = false;
    elements.consoleConfirmButton.focus();
    return;
  }
  void runConsoleCommand(normalized, false);
}

elements.search.addEventListener('input', renderMembers);
elements.tabs.forEach(tab => {
  tab.addEventListener('click', () => switchAdminTab(tab.dataset.adminTab));
});

elements.consoleForm.addEventListener('submit', event => {
  event.preventDefault();
  requestConsoleExecution(elements.consoleInput.value);
});

elements.consoleExamples.forEach(button => {
  button.addEventListener('click', () => {
    const command = button.dataset.consoleCommand || '';
    elements.consoleInput.value = command;
    elements.consoleInput.focus();
    elements.consoleInput.setSelectionRange(command.length, command.length);
    if (command.trim() === 'help') requestConsoleExecution(command);
  });
});

elements.consoleCancelButton.addEventListener('click', () => {
  pendingDestructiveCommand = '';
  elements.consoleConfirm.hidden = true;
  elements.consoleInput.focus();
});

elements.consoleConfirmButton.addEventListener('click', () => {
  if (!pendingDestructiveCommand) return;
  const command = pendingDestructiveCommand;
  pendingDestructiveCommand = '';
  elements.consoleConfirm.hidden = true;
  void runConsoleCommand(command, true);
});

elements.consoleRefreshButton.addEventListener('click', () => void loadConsoleHistory());

elements.logoutButton.addEventListener('click', async () => {
  setBusy(elements.logoutButton, true, 'Đang đăng xuất...');
  await supabase.auth.signOut();
  window.location.replace(pageUrl());
});

async function init() {
  try {
    session = await requireSession();
    if (!session) return;
    currentProfile = await getProfile(session.user.id);
    elements.loading.hidden = true;

    if (currentProfile.role !== 'admin' || currentProfile.account_status !== 'active') {
      elements.denied.hidden = false;
      return;
    }

    await loadMembers();
    try {
      await loadPermissions();
    } catch (permissionError) {
      elements.permissionLoading.textContent =
        `Chưa tải được quyền theo role: ${humanizeAuthError(permissionError)}. `
        + 'Hãy chạy role_permissions_migration.sql trong Supabase.';
      elements.permissionLoading.classList.add('permission-load-error');
    }
    elements.content.hidden = false;
    await loadConsoleHistory();
    const requestedTab = window.location.hash.replace(/^#/u, '');
    switchAdminTab(['accounts', 'permissions', 'console'].includes(requestedTab)
      ? requestedTab
      : 'accounts');
  } catch (error) {
    elements.loading.hidden = true;
    showMessage(
      elements.message,
      `Không thể tải trang quản trị: ${humanizeAuthError(error)}`,
      'error'
    );
  }
}

init();
