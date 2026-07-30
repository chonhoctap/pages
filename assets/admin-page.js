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
} from './supabase-client.js?v=20260730-4';

initThemeToggle();

const elements = {
  loading: document.getElementById('adminLoading'),
  denied: document.getElementById('adminDenied'),
  content: document.getElementById('adminContent'),
  list: document.getElementById('memberList'),
  search: document.getElementById('memberSearch'),
  message: document.getElementById('adminMessage'),
  counts: document.getElementById('roleCounts'),
  logoutButton: document.getElementById('logoutButton')
};

let session;
let currentProfile;
let profiles = [];

function renderCounts() {
  const counts = profiles.reduce((result, item) => {
    result[item.role] = (result[item.role] || 0) + 1;
    result[item.account_status] = (result[item.account_status] || 0) + 1;
    return result;
  }, {});
  elements.counts.textContent =
    `${profiles.length} tài khoản · ${counts.admin || 0} quản trị · `
    + `${counts.moderator || 0} điều hành · ${counts.suspended || 0} tạm khóa · `
    + `${counts.banned || 0} bị cấm`;
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
  avatar.src = member.avatar_url || 'avatar.png';
  avatar.alt = '';

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
    ['moderator', 'Điều hành viên'],
    ['admin', 'Quản trị viên']
  ], member.role, `Quyền của ${member.username}`);
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
    if (
      roleSelect.value === member.role
      && statusSelect.value === member.account_status
    ) {
      showMessage(elements.message, 'Quyền và trạng thái tài khoản này chưa thay đổi.', 'info');
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

elements.search.addEventListener('input', renderMembers);

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

    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, role, account_status, created_at')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;
    profiles = data || [];
    renderCounts();
    renderMembers();
    elements.content.hidden = false;
  } catch (error) {
    elements.loading.hidden = true;
    showMessage(elements.message, `Không thể tải trang quản trị: ${humanizeAuthError(error)}`, 'error');
  }
}

init();
