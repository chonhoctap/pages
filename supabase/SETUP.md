# Thiết lập Supabase cho Chốn Học Tập

## Project hiện tại: nâng cấp phân quyền

Nếu Chốn Học Tập đã chạy `schema.sql` trước đây, không cần chạy lại toàn bộ
schema. Mở **SQL Editor**, dán toàn bộ file `permissions_migration.sql`, chọn
**Run** và đợi thông báo `Success. No rows returned`.

Hãy chạy migration này trước khi cập nhật mã website. Migration bổ sung:

- trạng thái `active` / `suspended` / `banned`;
- kiểm tra tài khoản đang hoạt động ngay trong RLS;
- RPC quản trị cập nhật role và trạng thái cùng lúc;
- bảo vệ quản trị viên cuối cùng;
- bảng `access_audit_log` ghi lại mọi thay đổi quyền.

## 1. Tạo database và chính sách bảo mật

Trong Supabase Dashboard:

1. Mở **SQL Editor**.
2. Tạo query mới.
3. Dán toàn bộ nội dung `schema.sql`.
4. Chọn **Run**.

File tạo bảng `profiles`, ba quyền `member` / `moderator` / `admin`, ba trạng
thái tài khoản, RLS, hàm cấp quyền dành riêng cho quản trị viên, nhật ký thay
đổi quyền và bucket `avatars`.

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

## 4. Cấu hình email quên mật khẩu bằng mã 6 số

Mở **Authentication → Emails → Templates → Reset password**:

1. Đặt tiêu đề email, ví dụ: `Mã khôi phục mật khẩu Chốn Học Tập`.
2. Dán nội dung file `RESET_PASSWORD_EMAIL_TEMPLATE.html` vào phần nội dung.
3. Chọn **Save changes**.

Biến `{{ .Token }}` trong mẫu email sẽ được Supabase thay bằng mã OTP 6 số.
Trang `auth.html` dùng email và mã này để xác minh, sau đó mới cho phép đặt
mật khẩu mới.

Email mặc định của Supabase chỉ phù hợp để thử nghiệm và có giới hạn gửi thấp.
Khi website có người dùng thật, nên cấu hình **Authentication → SMTP Settings**
với nhà cung cấp email riêng.

## 5. Cấp quyền quản trị đầu tiên

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

Từ thời điểm đó, tài khoản chủ có thể mở `admin.html` để cấp quyền, tạm khóa
hoặc cấm tài khoản. Người dùng thông thường không thể tự thay đổi `role` hay
`account_status`.

## 6. Kiểm tra

1. Đăng ký bằng email, username và mật khẩu.
2. Xác nhận email nếu Supabase yêu cầu.
3. Đăng nhập và chỉnh sửa hồ sơ tại `profile.html`.
4. Tải ảnh đại diện nhỏ hơn 2 MB.
5. Đăng nhập tài khoản admin và thử thay đổi quyền/trạng thái trong `admin.html`.
6. Xác nhận không thể tự hạ quyền hoặc khóa tài khoản admin của chính mình.
7. Kiểm tra bảng `access_audit_log` có bản ghi sau mỗi lần thay đổi.
8. Bật Google provider rồi thử nút **Tiếp tục bằng Google**.
9. Mở **Quên mật khẩu**, nhập email, nhận mã 6 số và đặt mật khẩu mới.
10. Mở hồ sơ và thử đổi mật khẩu trong phần **Bảo mật tài khoản**.
