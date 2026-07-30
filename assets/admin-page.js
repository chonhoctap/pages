import {
  supabase,
  pageUrl,
  requireSession,
  getProfile,
  profileName,
  roleLabel,
  showMessage,
  setBusy,
  initThemeToggle,
  humanizeAuthError
} from './supabase-client.js';

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
    return result;
  }, {});
  elements.counts.textContent =
    `${profiles.length} tài khoản · ${counts.admin || 0} quản trị · ${counts.moderator || 0} điều hành`;
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
  const joined = document.createElement('small');
  joined.textContent = `Tham gia ${new Intl.DateTimeFormat('vi-VN').format(new Date(member.created_at))}`;
  info.append(name, username, joined);

  const controls = document.createElement('div');
  controls.className = 'role-controls';
  const select = document.createElement('select');
  select.setAttribute('aria-label', `Quyền của ${member.username}`);
  [
    ['member', 'Thành viên'],
    ['moderator', 'Điều hành viên'],
    ['admin', 'Quản trị viên']
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = member.role === value;
    select.appendChild(option);
  });

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'button button-small';
  save.textContent = 'Cập nhật';
  save.addEventListener('click', async () => {
    if (select.value === member.role) {
      showMessage(elements.message, 'Quyền của tài khoản này chưa thay đổi.', 'info');
      return;
    }
    if (member.id === session.user.id && select.value !== 'admin') {
      showMessage(elements.message, 'Bạn không thể tự hạ quyền quản trị của chính mình.', 'error');
      select.value = member.role;
      return;
    }

    setBusy(save, true, 'Đang lưu...');
    try {
      const { error } = await supabase.rpc('set_user_role', {
        target_user_id: member.id,
        target_role: select.value
      });
      if (error) throw error;
      member.role = select.value;
      renderCounts();
      showMessage(
        elements.message,
        `Đã đổi quyền @${member.username} thành ${roleLabel(member.role)}.`,
        'success'
      );
    } catch (error) {
      select.value = member.role;
      showMessage(elements.message, humanizeAuthError(error), 'error');
    } finally {
      setBusy(save, false);
    }
  });

  controls.append(select, save);
  card.append(avatar, info, controls);
  return card;
}

function renderMembers() {
  const keyword = elements.search.value.trim().toLocaleLowerCase('vi');
  const filtered = profiles.filter(member =>
    `${member.username} ${member.display_name || ''} ${member.role}`
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

    if (currentProfile.role !== 'admin') {
      elements.denied.hidden = false;
      return;
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, role, created_at')
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
