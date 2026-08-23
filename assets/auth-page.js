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
  verifyResetForm: document.getElementById('verifyResetForm'),
  updatePasswordForm: document.getElementById('updatePasswordForm'),
  message: document.getElementById('authMessage'),
  googleButton: document.getElementById('googleButton'),
  forgotButton: document.getElementById('forgotButton'),
  backToLoginButton: document.getElementById('backToLoginButton'),
  requestAnotherCodeButton: document.getElementById('requestAnotherCodeButton'),
  authTabs: document.getElementById('authTabs'),
  oauthDivider: document.getElementById('oauthDivider')
};

const initialParams = new URLSearchParams(window.location.search);
let recoveryMode = initialParams.get('mode') === 'reset';
let passwordResetFlow = recoveryMode || initialParams.get('forgot') === '1';
let redirecting = false;
const recoveryEmailKey = 'chonhoctap-recovery-email';

function rememberRecoveryEmail(email) {
  try {
    sessionStorage.setItem(recoveryEmailKey, email);
  } catch {
    // Luồng vẫn hoạt động trong trang hiện tại nếu sessionStorage bị chặn.
  }
}

function getRememberedRecoveryEmail() {
  try {
    return sessionStorage.getItem(recoveryEmailKey) || '';
  } catch {
    return '';
  }
}

function forgetRecoveryEmail() {
  try {
    sessionStorage.removeItem(recoveryEmailKey);
  } catch {
    // Không cần xử lý thêm.
  }
}

function showView(view) {
  const views = {
    login: elements.loginForm,
    signup: elements.signupForm,
    reset: elements.resetForm,
    verifyReset: elements.verifyResetForm,
    updatePassword: elements.updatePasswordForm
  };

  Object.entries(views).forEach(([name, element]) => {
    if (element) element.hidden = name !== view;
  });

  const regularAuth = view === 'login' || view === 'signup';
  passwordResetFlow = !regularAuth;
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
  if (redirecting || recoveryMode || passwordResetFlow) return;
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
elements.requestAnotherCodeButton.addEventListener('click', () => {
  elements.resetForm.elements.email.value = elements.verifyResetForm.elements.email.value;
  showView('reset');
});

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
    rememberRecoveryEmail(email);
    elements.verifyResetForm.elements.email.value = email;
    elements.verifyResetForm.elements.token.value = '';
    showView('verifyReset');
    showMessage(elements.message, 'Đã gửi mã xác nhận. Hãy kiểm tra hộp thư và cả thư rác.', 'success');
  } catch (error) {
    showMessage(elements.message, humanizeAuthError(error), 'error');
  } finally {
    setBusy(button, false);
  }
});

elements.verifyResetForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = elements.verifyResetForm.querySelector('button[type="submit"]');
  const form = new FormData(elements.verifyResetForm);
  const email = String(form.get('email') || '').trim();
  const token = String(form.get('token') || '').replace(/\D/g, '');

  if (!/^\d{6}$/.test(token)) {
    showMessage(elements.message, 'Mã xác nhận phải gồm đúng 6 chữ số.', 'error');
    return;
  }

  recoveryMode = true;
  setBusy(button, true, 'Đang xác nhận...');
  showMessage(elements.message, '');
  try {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'recovery'
    });
    if (error) throw error;
    forgetRecoveryEmail();
    showView('updatePassword');
    showMessage(elements.message, 'Mã hợp lệ. Hãy đặt mật khẩu mới.', 'success');
  } catch (error) {
    recoveryMode = false;
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
    passwordResetFlow = false;
    showMessage(elements.message, 'Đã đổi mật khẩu. Đang mở hồ sơ...', 'success');
    window.setTimeout(goAfterAuth, 500);
  } catch (error) {
    showMessage(elements.message, humanizeAuthError(error), 'error');
  } finally {
    setBusy(button, false);
  }
});

supabase.auth.onAuthStateChange(event => {
  if (event === 'PASSWORD_RECOVERY') {
    recoveryMode = true;
    passwordResetFlow = true;
    window.setTimeout(() => showView('updatePassword'), 0);
  }
});

async function init() {
  const params = initialParams;
  const oauthError = params.get('error_description');
  if (oauthError) {
    showMessage(elements.message, decodeURIComponent(oauthError), 'error');
  }

  if (params.get('forgot') === '1') {
    elements.resetForm.elements.email.value = getRememberedRecoveryEmail();
    showView('reset');
    return;
  }

  if (recoveryMode) {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      showView('updatePassword');
    } else {
      const email = getRememberedRecoveryEmail();
      if (email) {
        elements.verifyResetForm.elements.email.value = email;
        showView('verifyReset');
      } else {
        showView('reset');
      }
    }
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
