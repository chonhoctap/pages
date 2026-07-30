import {
  supabase,
  pageUrl,
  safeNext,
  showMessage,
  setBusy,
  initThemeToggle,
  humanizeAuthError
} from './supabase-client.js';

initThemeToggle();

const elements = {
  tabs: document.querySelectorAll('[data-auth-tab]'),
  loginForm: document.getElementById('loginForm'),
  signupForm: document.getElementById('signupForm'),
  resetForm: document.getElementById('resetForm'),
  updatePasswordForm: document.getElementById('updatePasswordForm'),
  message: document.getElementById('authMessage'),
  googleButton: document.getElementById('googleButton'),
  forgotButton: document.getElementById('forgotButton'),
  backToLoginButton: document.getElementById('backToLoginButton'),
  authTabs: document.getElementById('authTabs'),
  oauthDivider: document.getElementById('oauthDivider')
};

let recoveryMode = new URLSearchParams(window.location.search).get('mode') === 'reset';
let redirecting = false;

function showView(view) {
  const views = {
    login: elements.loginForm,
    signup: elements.signupForm,
    reset: elements.resetForm,
    updatePassword: elements.updatePasswordForm
  };

  Object.entries(views).forEach(([name, element]) => {
    if (element) element.hidden = name !== view;
  });

  const regularAuth = view === 'login' || view === 'signup';
  elements.authTabs.hidden = !regularAuth;
  elements.googleButton.hidden = !regularAuth;
  elements.oauthDivider.hidden = !regularAuth;
  elements.tabs.forEach(tab => {
    const active = tab.dataset.authTab === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  showMessage(elements.message, '');
}

function goAfterAuth() {
  if (redirecting || recoveryMode) return;
  redirecting = true;
  window.location.replace(safeNext());
}

elements.tabs.forEach(tab => {
  tab.addEventListener('click', () => showView(tab.dataset.authTab));
});

elements.loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = elements.loginForm.querySelector('button[type="submit"]');
  const form = new FormData(elements.loginForm);
  setBusy(button, true, 'Đang đăng nhập...');
  showMessage(elements.message, '');

  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: String(form.get('email') || '').trim(),
      password: String(form.get('password') || '')
    });
    if (error) throw error;
    showMessage(elements.message, 'Đăng nhập thành công. Đang chuyển trang...', 'success');
    goAfterAuth();
  } catch (error) {
    showMessage(elements.message, humanizeAuthError(error), 'error');
  } finally {
    setBusy(button, false);
  }
});

elements.signupForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = elements.signupForm.querySelector('button[type="submit"]');
  const form = new FormData(elements.signupForm);
  const username = String(form.get('username') || '').trim().toLowerCase();
  const displayName = String(form.get('display_name') || '').trim();
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  const confirmPassword = String(form.get('confirm_password') || '');

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    showMessage(elements.message, 'Username gồm 3–24 ký tự: chữ thường, số hoặc dấu gạch dưới.', 'error');
    return;
  }
  if (displayName.length < 2 || displayName.length > 60) {
    showMessage(elements.message, 'Tên hiển thị cần từ 2 đến 60 ký tự.', 'error');
    return;
  }
  if (password.length < 8) {
    showMessage(elements.message, 'Mật khẩu cần ít nhất 8 ký tự.', 'error');
    return;
  }
  if (password !== confirmPassword) {
    showMessage(elements.message, 'Hai mật khẩu chưa trùng nhau.', 'error');
    return;
  }

  setBusy(button, true, 'Đang tạo tài khoản...');
  showMessage(elements.message, '');
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username,
          display_name: displayName
        },
        emailRedirectTo: `${pageUrl('auth.html')}?confirmed=1`
      }
    });
    if (error) throw error;

    if (data.session) {
      showMessage(elements.message, 'Tạo tài khoản thành công. Đang chuyển trang...', 'success');
      goAfterAuth();
    } else {
      elements.signupForm.reset();
      showMessage(
        elements.message,
        'Đã tạo tài khoản. Hãy mở email và nhấn liên kết xác nhận trước khi đăng nhập.',
        'success'
      );
    }
  } catch (error) {
    showMessage(elements.message, humanizeAuthError(error), 'error');
  } finally {
    setBusy(button, false);
  }
});

elements.googleButton.addEventListener('click', async () => {
  setBusy(elements.googleButton, true, 'Đang mở Google...');
  showMessage(elements.message, '');
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${pageUrl('auth.html')}?oauth=1`,
        queryParams: {
          access_type: 'offline',
          prompt: 'select_account'
        }
      }
    });
    if (error) throw error;
  } catch (error) {
    showMessage(elements.message, humanizeAuthError(error), 'error');
    setBusy(elements.googleButton, false);
  }
});

elements.forgotButton.addEventListener('click', () => {
  const loginEmail = elements.loginForm.elements.email.value;
  elements.resetForm.elements.email.value = loginEmail;
  showView('reset');
});

elements.backToLoginButton.addEventListener('click', () => showView('login'));

elements.resetForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = elements.resetForm.querySelector('button[type="submit"]');
  const email = String(new FormData(elements.resetForm).get('email') || '').trim();
  setBusy(button, true, 'Đang gửi...');
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${pageUrl('auth.html')}?mode=reset`
    });
    if (error) throw error;
    showMessage(elements.message, 'Đã gửi liên kết đặt lại mật khẩu vào email của bạn.', 'success');
  } catch (error) {
    showMessage(elements.message, humanizeAuthError(error), 'error');
  } finally {
    setBusy(button, false);
  }
});

elements.updatePasswordForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = elements.updatePasswordForm.querySelector('button[type="submit"]');
  const form = new FormData(elements.updatePasswordForm);
  const password = String(form.get('password') || '');
  const confirmPassword = String(form.get('confirm_password') || '');

  if (password.length < 8) {
    showMessage(elements.message, 'Mật khẩu cần ít nhất 8 ký tự.', 'error');
    return;
  }
  if (password !== confirmPassword) {
    showMessage(elements.message, 'Hai mật khẩu chưa trùng nhau.', 'error');
    return;
  }

  setBusy(button, true, 'Đang cập nhật...');
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    recoveryMode = false;
    showMessage(elements.message, 'Đã đổi mật khẩu. Đang mở hồ sơ...', 'success');
    window.setTimeout(goAfterAuth, 500);
  } catch (error) {
    showMessage(elements.message, humanizeAuthError(error), 'error');
  } finally {
    setBusy(button, false);
  }
});

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    recoveryMode = true;
    window.setTimeout(() => showView('updatePassword'), 0);
  } else if (event === 'SIGNED_IN' && session && !recoveryMode) {
    window.setTimeout(goAfterAuth, 0);
  }
});

async function init() {
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get('error_description');
  if (oauthError) {
    showMessage(elements.message, decodeURIComponent(oauthError), 'error');
  }

  if (recoveryMode) {
    showView('updatePassword');
    return;
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    goAfterAuth();
    return;
  }
  showView(params.get('tab') === 'signup' ? 'signup' : 'login');
}

init();
