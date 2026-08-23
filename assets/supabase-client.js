import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://qartstnodgujgqkczzml.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Qy5-L4zd8xAPbVKHE6xUqA_BqKdEuvR';

export const SITE_ROOT = new URL('../', import.meta.url);
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce'
  },
  global: {
    headers: {
      'X-Client-Info': 'chon-hoc-tap-web'
    }
  }
});

export function pageUrl(path = '') {
  return new URL(path, SITE_ROOT).href;
}

export function safeNext(fallback = 'profile.html') {
  const raw = new URLSearchParams(window.location.search).get('next');
  if (!raw) return pageUrl(fallback);

  try {
    const candidate = new URL(raw, SITE_ROOT);
    const rootPath = SITE_ROOT.pathname.endsWith('/') ? SITE_ROOT.pathname : `${SITE_ROOT.pathname}/`;
    if (candidate.origin === SITE_ROOT.origin && candidate.pathname.startsWith(rootPath)) {
      return candidate.href;
    }
  } catch {
    // Dùng trang mặc định nếu next không phải URL hợp lệ.
  }
  return pageUrl(fallback);
}

export async function requireSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`${pageUrl('auth.html')}?next=${encodeURIComponent(next)}`);
    return null;
  }
  return data.session;
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, bio, grade, role, account_status, address, phone, facebook_url, tiktok_url, instagram_url, created_at, updated_at')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export function profileName(profile, user) {
  return profile?.display_name?.trim()
    || profile?.username?.trim()
    || user?.user_metadata?.full_name
    || user?.email?.split('@')[0]
    || 'Thành viên';
}

export function roleLabel(role) {
  return {
    member: 'Thành viên',
    vip: 'Thành viên VIP',
    moderator: 'Điều hành viên',
    admin: 'Quản trị viên'
  }[role] || 'Thành viên';
}

export function statusLabel(status) {
  return {
    active: 'Hoạt động',
    suspended: 'Tạm khóa',
    banned: 'Bị cấm'
  }[status] || 'Không xác định';
}

export function showMessage(element, message, type = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.type = type;
  element.hidden = !message;
}

export function setBusy(button, busy, busyText = 'Đang xử lý...') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

export function initThemeToggle() {
  const button = document.querySelector('[data-theme-toggle]');
  const icon = button?.querySelector('[data-theme-icon]');
  const label = button?.querySelector('[data-theme-label]');
  const key = 'chonhoctap-theme';

  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    const dark = theme === 'dark';
    if (icon) icon.textContent = dark ? '☀️' : '🌙';
    if (label) label.textContent = dark ? 'Giao diện sáng' : 'Giao diện tối';
    button?.setAttribute('aria-pressed', String(dark));
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#07111f' : '#f4f8ff');
  };

  let current = 'light';
  try {
    current = localStorage.getItem(key) || 'light';
  } catch {
    current = 'light';
  }
  apply(current);

  button?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(key, next);
    } catch {
      // Giao diện vẫn đổi trong phiên hiện tại nếu localStorage bị chặn.
    }
    apply(next);
  });
}


export const PASSWORD_POLICY_MESSAGE = 'Mật khẩu phải có ít nhất 8 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.';

const PASSWORD_RULES = [
  { key: 'length', label: 'Ít nhất 8 ký tự', test: value => value.length >= 8 },
  { key: 'lower', label: 'Có chữ thường', test: value => /[a-z]/.test(value) },
  { key: 'upper', label: 'Có chữ in hoa', test: value => /[A-Z]/.test(value) },
  { key: 'number', label: 'Có chữ số', test: value => /\d/.test(value) },
  { key: 'special', label: 'Có ký tự đặc biệt', test: value => /[^A-Za-z0-9\s]/.test(value) }
];

export function assessPassword(password = '') {
  const value = String(password);
  const rules = Object.fromEntries(PASSWORD_RULES.map(rule => [rule.key, rule.test(value)]));
  const score = Object.values(rules).filter(Boolean).length;
  const valid = score === PASSWORD_RULES.length;
  const level = !value ? 'empty' : valid ? 'strong' : score >= 3 ? 'medium' : 'weak';
  const label = {
    empty: 'Chưa nhập mật khẩu',
    weak: 'Yếu',
    medium: 'Trung bình',
    strong: 'Mạnh · Đủ điều kiện'
  }[level];

  return { rules, score, valid, level, label };
}

export function isStrongPassword(password) {
  return assessPassword(password).valid;
}

export function initPasswordStrength(inputId) {
  const input = document.getElementById(inputId);
  const container = document.querySelector(`[data-password-strength-for="${inputId}"]`);
  if (!input || !container) return;

  const statusId = `${inputId}StrengthStatus`;
  container.id = `${inputId}Strength`;
  container.innerHTML = `
    <div class="password-strength-head">
      <strong id="${statusId}" data-password-strength-label>Chưa nhập mật khẩu</strong>
      <span data-password-strength-score>0/5</span>
    </div>
    <div class="password-strength-bars" aria-hidden="true"><span></span><span></span><span></span></div>
    <ul class="password-rules">
      ${PASSWORD_RULES.map(rule => `<li data-password-rule="${rule.key}"><span aria-hidden="true">○</span>${rule.label}</li>`).join('')}
    </ul>
  `;
  input.setAttribute('aria-describedby', statusId);

  const render = () => {
    const result = assessPassword(input.value);
    container.dataset.level = result.level;
    container.querySelector('[data-password-strength-label]').textContent = result.label;
    container.querySelector('[data-password-strength-score]').textContent = `${result.score}/5`;
    PASSWORD_RULES.forEach(rule => {
      const item = container.querySelector(`[data-password-rule="${rule.key}"]`);
      const met = result.rules[rule.key];
      item.classList.toggle('met', met);
      item.querySelector('span').textContent = met ? '✓' : '○';
    });
  };

  input.addEventListener('input', render);
  render();
}

export function humanizeAuthError(error) {
  const message = String(error?.message || error || '');
  if (/invalid login credentials/i.test(message)) return 'Email hoặc mật khẩu chưa đúng.';
  if (/email not confirmed/i.test(message)) return 'Bạn cần xác nhận email trước khi đăng nhập.';
  if (/user already registered/i.test(message)) return 'Email này đã được đăng ký.';
  if (/password should be at least/i.test(message)) return 'Mật khẩu chưa đủ độ dài yêu cầu.';
  if (/same password|different from the old password/i.test(message)) return 'Mật khẩu mới cần khác mật khẩu hiện tại.';
  if (/token has expired|otp expired/i.test(message)) return 'Mã xác nhận đã hết hạn. Hãy yêu cầu mã mới.';
  if (/invalid token|token is invalid|otp.*invalid/i.test(message)) return 'Mã xác nhận chưa đúng.';
  if (/database error saving new user/i.test(message)) return 'Username đã tồn tại hoặc thông tin đăng ký chưa hợp lệ.';
  if (/at least one active administrator|ít nhất một quản trị viên/i.test(message)) {
    return 'Hệ thống phải còn ít nhất một quản trị viên đang hoạt động.';
  }
  if (/cannot demote|không thể tự hạ quyền|khóa tài khoản quản trị/i.test(message)) {
    return 'Bạn không thể tự hạ quyền hoặc khóa tài khoản quản trị của chính mình.';
  }
  if (/only active administrators|quản trị viên đang hoạt động/i.test(message)) {
    return 'Chỉ quản trị viên đang hoạt động mới được thay đổi quyền.';
  }
  if (/captcha|turnstile|challenge verification/i.test(message)) return 'Xác minh bảo mật chưa hợp lệ hoặc đã hết hạn. Vui lòng xác minh lại.';
  if (/rate limit/i.test(message)) return 'Bạn thao tác quá nhanh. Vui lòng đợi một chút rồi thử lại.';
  if (/một bài sau mỗi 15 phút|one post.*15 minutes/i.test(message)) {
    return 'Bạn chỉ có thể đăng một bài sau mỗi 15 phút.';
  }
  if (/media.*vượt quá giới hạn|số lượng ảnh hoặc video/i.test(message)) {
    return 'Ảnh hoặc video vượt quá giới hạn của tài khoản.';
  }
  if (/failed to fetch|network/i.test(message)) return 'Không thể kết nối máy chủ. Hãy kiểm tra Internet.';
  return message || 'Đã xảy ra lỗi. Vui lòng thử lại.';
}
