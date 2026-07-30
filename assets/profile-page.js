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
  loading: document.getElementById('profileLoading'),
  content: document.getElementById('profileContent'),
  form: document.getElementById('profileForm'),
  message: document.getElementById('profileMessage'),
  avatar: document.getElementById('profileAvatar'),
  avatarInput: document.getElementById('avatarInput'),
  email: document.getElementById('profileEmail'),
  role: document.getElementById('profileRole'),
  heading: document.getElementById('profileHeading'),
  adminLink: document.getElementById('adminLink'),
  logoutButton: document.getElementById('logoutButton'),
  changePasswordForm: document.getElementById('changePasswordForm'),
  passwordMessage: document.getElementById('passwordMessage')
};

let session;
let profile;

function fillProfile() {
  const { user } = session;
  elements.heading.textContent = profileName(profile, user);
  elements.email.value = user.email || '';
  elements.form.elements.username.value = profile.username || '';
  elements.form.elements.display_name.value = profile.display_name || '';
  elements.form.elements.bio.value = profile.bio || '';
  elements.form.elements.grade.value = profile.grade || '';
  elements.role.textContent = roleLabel(profile.role);
  elements.role.dataset.role = profile.role;
  elements.avatar.src = profile.avatar_url || user.user_metadata?.avatar_url || 'avatar.png';
  elements.adminLink.hidden = profile.role !== 'admin';
}

async function uploadAvatar(file) {
  if (!file) return profile.avatar_url || '';
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('Ảnh đại diện chỉ hỗ trợ JPG, PNG, WEBP hoặc GIF.');
  }
  if (file.size > 2 * 1024 * 1024) {
    throw new Error('Ảnh đại diện không được vượt quá 2 MB.');
  }

  const extension = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${session.user.id}/avatar-${Date.now()}.${extension}`;
  const { error } = await supabase.storage.from('avatars').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type
  });
  if (error) throw error;
  return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

elements.avatarInput.addEventListener('change', () => {
  const file = elements.avatarInput.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showMessage(elements.message, 'Ảnh đại diện không được vượt quá 2 MB.', 'error');
    elements.avatarInput.value = '';
    return;
  }
  const previewUrl = URL.createObjectURL(file);
  elements.avatar.src = previewUrl;
  elements.avatar.onload = () => URL.revokeObjectURL(previewUrl);
});

elements.form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = elements.form.querySelector('button[type="submit"]');
  const form = new FormData(elements.form);
  const username = String(form.get('username') || '').trim().toLowerCase();
  const displayName = String(form.get('display_name') || '').trim();
  const bio = String(form.get('bio') || '').trim();
  const grade = String(form.get('grade') || '');

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    showMessage(elements.message, 'Username gồm 3–24 ký tự: chữ thường, số hoặc dấu gạch dưới.', 'error');
    return;
  }
  if (displayName.length < 2 || displayName.length > 60) {
    showMessage(elements.message, 'Tên hiển thị cần từ 2 đến 60 ký tự.', 'error');
    return;
  }
  if (bio.length > 280) {
    showMessage(elements.message, 'Giới thiệu không được vượt quá 280 ký tự.', 'error');
    return;
  }

  setBusy(button, true, 'Đang lưu...');
  showMessage(elements.message, '');
  try {
    const avatarUrl = await uploadAvatar(elements.avatarInput.files?.[0]);
    const payload = {
      username,
      display_name: displayName,
      bio: bio || null,
      grade: grade || null,
      avatar_url: avatarUrl || null
    };
    const { data, error } = await supabase
      .from('profiles')
      .update(payload)
      .eq('id', session.user.id)
      .select('id, username, display_name, avatar_url, bio, grade, role, created_at, updated_at')
      .single();
    if (error) throw error;
    profile = data;
    elements.avatarInput.value = '';
    fillProfile();
    showMessage(elements.message, 'Đã lưu thông tin cá nhân.', 'success');
  } catch (error) {
    const message = error?.code === '23505'
      ? 'Username này đã được sử dụng.'
      : humanizeAuthError(error);
    showMessage(elements.message, message, 'error');
  } finally {
    setBusy(button, false);
  }
});

elements.logoutButton.addEventListener('click', async () => {
  setBusy(elements.logoutButton, true, 'Đang đăng xuất...');
  await supabase.auth.signOut();
  window.location.replace(pageUrl());
});

elements.changePasswordForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = elements.changePasswordForm.querySelector('button[type="submit"]');
  const form = new FormData(elements.changePasswordForm);
  const password = String(form.get('password') || '');
  const confirmPassword = String(form.get('confirm_password') || '');

  if (password.length < 8) {
    showMessage(elements.passwordMessage, 'Mật khẩu cần ít nhất 8 ký tự.', 'error');
    return;
  }
  if (password !== confirmPassword) {
    showMessage(elements.passwordMessage, 'Hai mật khẩu chưa trùng nhau.', 'error');
    return;
  }

  setBusy(button, true, 'Đang cập nhật...');
  showMessage(elements.passwordMessage, '');
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    elements.changePasswordForm.reset();
    showMessage(
      elements.passwordMessage,
      'Đã cập nhật mật khẩu. Bạn có thể đăng nhập bằng Google hoặc email và mật khẩu.',
      'success'
    );
  } catch (error) {
    showMessage(elements.passwordMessage, humanizeAuthError(error), 'error');
  } finally {
    setBusy(button, false);
  }
});

async function init() {
  try {
    session = await requireSession();
    if (!session) return;
    profile = await getProfile(session.user.id);
    fillProfile();
    elements.loading.hidden = true;
    elements.content.hidden = false;
  } catch (error) {
    elements.loading.hidden = true;
    showMessage(
      elements.message,
      `Không thể tải hồ sơ: ${humanizeAuthError(error)}`,
      'error'
    );
  }
}

init();
