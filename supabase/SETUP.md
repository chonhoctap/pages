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

## Project hiện tại: thêm diễn đàn

Sau khi hoàn tất phân quyền, mở **SQL Editor**, dán toàn bộ file
`forum_migration.sql` và chọn **Run**. Chỉ cập nhật mã website sau khi Supabase
báo `Success. No rows returned`.

Migration này tạo:

- bảng bài viết, bình luận, lượt thích và lượt chia sẻ;
- hai khu vực `question` (Hỏi đáp) và `entertainment` (Giải trí);
- môn học, khối và trạng thái đã giải cho bài Hỏi đáp;
- RLS theo role và `account_status`;
- bucket `forum-media` cho ảnh/video tối đa 25 MB.

## Nâng cấp diễn đàn lần 2

Sau khi đã chạy `forum_migration.sql`, chạy tiếp toàn bộ file
`forum_v2_migration.sql`. Migration bổ sung:

- ảnh tối đa 2 MB hoặc video tối đa 8 MB trong bình luận;
- bucket riêng `forum-comment-media` để kiểm soát dung lượng;
- RPC bảo mật để chỉ chủ bài, moderator hoặc admin được đánh dấu đã giải;
- thu hồi quyền sửa trực tiếp cột `is_solved` từ trình duyệt.

## Nâng cấp diễn đàn V3

Sau hai migration diễn đàn ở trên, chạy tiếp toàn bộ
`forum_v3_migration.sql`. Migration này chuẩn bị:

- role `vip` và hạn mức media theo role;
- thành viên: tối đa 2 ảnh 1,5 MB + 1 video 25 MB, khung 720p;
- VIP/staff: tối đa 6 ảnh 3 MB + 2 video 50 MB, khung 1080p;
- cảm xúc, lượt xem, báo cáo, điểm xu hướng và hàng đợi kiểm duyệt;
- chống spam ở database: mỗi tài khoản thường chỉ đăng một bài sau 15 phút;
- Hỏi đáp chưa giải hết hạn sau 5 ngày, đã giải sau 7 ngày;
- bài Giải trí hết hạn sau 15 ngày; bài ghim không tự hết hạn.

Supabase Free giới hạn mỗi file tối đa 50 MB. Website dùng TUS resumable upload
cho tệp lớn hơn 6 MB để đường truyền không ổn định có thể tải đáng tin cậy hơn.
Khi chuyển sang R2 có thể nâng giới hạn VIP nếu backend R2 cũng được cập nhật.

Bộ lọc database chỉ tự nhận diện được một phần từ ngữ đáng ngờ. Ảnh/video nhạy
cảm và hành vi nói xấu vẫn phải dùng báo cáo cộng đồng hoặc dịch vụ kiểm duyệt
media ở backend; không nên coi bộ lọc từ khóa là chính xác tuyệt đối.

### Tự dọn bài và Supabase Storage

Workflow `.github/workflows/cleanup-forum.yml` chạy lúc 02:17 mỗi ngày theo giờ
Việt Nam. Nó xóa ảnh/video trong `forum-comment-media` và `forum-media` trước,
sau đó mới xóa bài cùng dữ liệu liên quan.

Vào GitHub repository > **Settings > Secrets and variables > Actions** và tạo:

1. `SUPABASE_URL`: URL project Supabase.
2. `SUPABASE_SECRET_KEY`: secret key chỉ dùng cho tác vụ backend, tạo trong
   Supabase Dashboard > Settings > API Keys.

Không dùng publishable key cho tác vụ dọn dẹp và không dán secret key vào mã
nguồn, ảnh chụp hay cuộc trò chuyện. Lần chạy thủ công đầu tiên phải để
`dry_run = true`; kiểm tra log đúng số bài rồi mới chạy với `dry_run = false`.

## Lưu media diễn đàn bằng Cloudflare R2

Mã nguồn mới giữ tương thích với các ảnh/video cũ trong Supabase Storage nhưng
chuyển tệp mới sang Cloudflare R2 sau khi cấu hình Worker.

1. Tạo bucket R2 tên `chonhoctap-media`, Storage Class `Standard`.
2. Làm theo `cloudflare/media-worker/README.md` để deploy Worker.
3. Chép URL `workers.dev` vào `assets/media-config.js`.
4. Không bật Public Development URL cho bucket và không đưa Access Key hoặc
   Secret Key R2 vào repository.
5. Ảnh được trình duyệt đổi sang WebP, thu về khung 720p và giới hạn 2 MB trước
   khi tải lên. Video hiện được kiểm tra định dạng và giới hạn 25 MB; R2 là nơi
   lưu trữ chứ không tự mã hóa lại video.

Nếu `MEDIA_API_URL` còn trống, website tạm thời dùng hai bucket Supabase cũ để
không làm gián đoạn phiên bản đang chạy.

## 1. Tạo database và chính sách bảo mật

Trong Supabase Dashboard:

1. Mở **SQL Editor**.
2. Tạo query mới.
3. Dán toàn bộ nội dung `schema.sql`.
4. Chọn **Run**.

File gốc tạo bảng `profiles` và các quyền cơ bản. Sau khi chạy
`forum_v3_migration.sql`, hệ thống có bốn quyền `member` / `vip` /
`moderator` / `admin`, ba trạng thái tài khoản, RLS, hàm cấp quyền dành riêng
cho quản trị viên, nhật ký thay đổi quyền và bucket `avatars`.

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
11. Chạy `forum_migration.sql`, đăng một bài Hỏi đáp kèm ảnh và đánh dấu đã giải.
12. Thử like, bình luận, chia sẻ trong khu vực Giải trí.
13. Tạm khóa tài khoản test và xác nhận tài khoản chỉ đọc, không thể tương tác.
14. Cấm tài khoản test và xác nhận tài khoản không thể mở dữ liệu diễn đàn.
15. Chạy `forum_v2_migration.sql`, thử bình luận kèm ảnh/video và kiểm tra giới hạn dung lượng.
16. Đăng nhập tài khoản khác và xác nhận không thể đánh dấu bài của người khác là đã giải.
17. Deploy R2 Worker, điền `MEDIA_API_URL`, đăng một bài kèm ảnh và xác nhận URL
    media có dạng `/media/post/...`.
18. Xóa bài và xác nhận object tương ứng cũng biến mất khỏi bucket R2.
19. Chạy `forum_v3_migration.sql`, thử đăng hai bài liên tiếp và xác nhận lần
    thứ hai bị chặn trong 15 phút.
20. Dùng tài khoản thường thử liên kết quá 2 ảnh hoặc 1 video; xác nhận
    database từ chối. Lặp lại với VIP ở giới hạn 6 ảnh và 2 video.
21. Chạy workflow dọn dẹp thủ công với `dry_run = true`, đối chiếu số bài hết
    hạn rồi mới cho phép lần chạy thật.
