import { supabase, getProfile, profileName, roleLabel } from './supabase-client.js';

const container = document.getElementById('authControls');

function loginLink() {
  const link = document.createElement('a');
  link.className = 'account-login';
  link.href = 'auth.html';
  link.innerHTML = '<span aria-hidden="true">◉</span><span>Đăng nhập</span>';
  return link;
}

function accountLink(profile, user) {
  const wrapper = document.createElement('div');
  wrapper.className = 'account-actions';

  if (profile?.role === 'admin') {
    const admin = document.createElement('a');
    admin.className = 'admin-shortcut';
    admin.href = 'admin.html';
    admin.textContent = 'Quản trị';
    wrapper.appendChild(admin);
  }

  const link = document.createElement('a');
  link.className = 'account-pill';
  link.href = 'profile.html';
  link.title = `${profileName(profile, user)} · ${roleLabel(profile?.role)}`;

  const avatar = document.createElement('img');
  avatar.src = profile?.avatar_url || user?.user_metadata?.avatar_url || 'avatar.webp';
  avatar.alt = '';
  avatar.decoding = 'async';

  const text = document.createElement('span');
  text.textContent = profileName(profile, user);
  link.append(avatar, text);
  wrapper.appendChild(link);
  return wrapper;
}

async function render(session) {
  if (!container) return;
  if (!session) {
    container.replaceChildren(loginLink());
    return;
  }

  try {
    const profile = await getProfile(session.user.id);
    container.replaceChildren(accountLink(profile, session.user));
  } catch {
    container.replaceChildren(accountLink(null, session.user));
  }
}

async function init() {
  if (!container) return;
  const { data } = await supabase.auth.getSession();
  render(data.session);
  supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => render(session), 0);
  });
}

init();
