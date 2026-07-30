# Thiết lập Supabase cho Chốn Học Tập

## 1. Tạo database và chính sách bảo mật

Trong Supabase Dashboard:

1. Mở **SQL Editor**.
2. Tạo query mới.
3. Dán toàn bộ nội dung `schema.sql`.
4. Chọn **Run**.

File tạo bảng `profiles`, ba quyền `member` / `moderator` / `admin`, RLS,
hàm cấp quyền dành riêng cho quản trị viên và bucket `avatars`.

## 2. Cấu hình URL đăng nhập

Mở **Authentication → URL Configuration**:

- Site URL: `https://chonhoctap.github.io/pages/`
- Redirect URLs: thêm `https://chonhoctap.github.io/pages/**`

## 3. Bật đăng nhập Google

Trong Google Cloud Console, tạo OAuth Client ID loại **Web application**:

- Authorized JavaScript origin:
  `https://chonhoctap.github.io`
- Authorized redirect URI:
  `https://qartstnodgujgqkczzml.supabase.co/auth/v1/callback`

Sau đó mở **Supabase → Authentication → Sign In / Providers → Google**,
bật Google và nhập Client ID cùng Client Secret. Client Secret chỉ nhập trong
Supabase Dashboard, không đưa vào GitHub hoặc mã frontend.

## 4. Cấp quyền quản trị đầu tiên

Đăng ký tài khoản chủ website trước. Sau đó chạy câu lệnh dưới đây trong
SQL Editor và thay email mẫu bằng email của tài khoản chủ:

```sql
update public.profiles
set role = 'admin'
where id = (
  select id
  from auth.users
  where lower(email) = lower('EMAIL_CUA_BAN')
);
```

Từ thời điểm đó, tài khoản chủ có thể mở `admin.html` để cấp quyền cho các
thành viên khác. Người dùng thông thường không thể tự thay đổi cột `role`.

## 5. Kiểm tra

1. Đăng ký bằng email, username và mật khẩu.
2. Xác nhận email nếu Supabase yêu cầu.
3. Đăng nhập và chỉnh sửa hồ sơ tại `profile.html`.
4. Tải ảnh đại diện nhỏ hơn 2 MB.
5. Đăng nhập tài khoản admin và thử thay đổi quyền trong `admin.html`.
6. Bật Google provider rồi thử nút **Tiếp tục bằng Google**.
