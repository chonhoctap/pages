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
- RPC bảo mật để chủ bài hoặc admin được đánh dấu đã giải (V12 thu hồi quyền này
  khỏi Staff);
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

## Hoàn thiện diễn đàn V4

Sau `forum_v3_migration.sql`, chạy tiếp toàn bộ file
`forum_v4_migration.sql`. Migration này cập nhật đúng quy tắc sử dụng hiện tại:

- mọi tài khoản chỉ được đăng một bài sau mỗi 15 phút;
- Hỏi đáp đã giải tự xóa sau 3 ngày kể từ lúc đánh dấu;
- Hỏi đáp chưa giải có bình luận tự xóa sau 5 ngày, chưa có bình luận sau 7 ngày;
- bài Giải trí tự xóa sau 14 ngày; bài ghim vẫn không tự hết hạn;
- bài hết hạn bị ẩn ngay, rồi workflow dọn dữ liệu chạy mỗi giờ;
- bài viết và bình luận nhận thêm âm thanh MP3, M4A, OGG, WebM hoặc WAV;
- thành viên được gắn 1 âm thanh tối đa 10 MB, VIP/staff được gắn 2 âm thanh,
  mỗi tệp tối đa 20 MB; thời lượng tối đa 10 phút.

Supabase Free giới hạn mỗi file tối đa 50 MB. Website dùng TUS resumable upload
cho tệp lớn hơn 6 MB để đường truyền không ổn định có thể tải đáng tin cậy hơn.
Khi chuyển sang R2 có thể nâng giới hạn VIP nếu backend R2 cũng được cập nhật.

Từ V12 không còn bộ phát hiện vi phạm tự động. Staff và admin chịu trách nhiệm
duyệt mọi bài viết trước khi công khai; báo cáo cộng đồng vẫn chỉ gửi admin để
quyết định giữ, ẩn hoặc xóa nội dung đã được duyệt nhưng phát sinh vấn đề.

## Nâng cấp diễn đàn V5

Sau `forum_v4_migration.sql`, chạy tiếp toàn bộ `forum_v5_migration.sql` trước
khi cập nhật website. V5 bổ sung menu quản lý bài, ẩn/hiện, trả lời bình luận,
tag, thông báo, báo cáo chuyển ngay về hàng chờ, quản lý bài trong hồ sơ và các
trường địa chỉ/điện thoại/mạng xã hội.

Hạn mức mới áp dụng giống nhau cho bài viết và bình luận:

- thành viên: 2 ảnh 720p tổng tối đa 5 MB, 1 âm thanh 1 phút/2 MB, không video;
- VIP và moderator: 5 ảnh 720p, 1 video 720p/1 phút, 1 âm thanh 2 phút/5 MB;
- admin: không giới hạn nghiệp vụ; hạ tầng hiện vẫn chặn ở 50 MB mỗi tệp.

### Kiểm duyệt hiện hành

Từ V12, diễn đàn không gọi API kiểm duyệt bên ngoài và không cần Edge Function
hay secret của nhà cung cấp AI. Website cũng không tự dò từ cấm, thông tin cá
nhân, liên kết hoặc nội dung media. Mọi bài viết mới và bài vừa chỉnh sửa đều
chuyển cho Staff/admin duyệt; bình luận văn bản/ảnh công khai ngay, còn bình
luận có âm thanh/video tiếp tục chờ riêng admin.

### Tự dọn bài, Supabase Storage và Cloudflare R2

Workflow `.github/workflows/cleanup-forum.yml` chạy vào phút 17 mỗi giờ. Nó xóa
ảnh/video/âm thanh cũ trong `forum-comment-media`, `forum-media` và media mới
trên Cloudflare R2 trước, sau đó mới xóa bài cùng dữ liệu liên quan. Nếu Worker
không xác nhận xóa R2, workflow thử lại rồi dừng, không xóa bài và không để lại
object mồ côi.

Vào GitHub repository > **Settings > Secrets and variables > Actions** và tạo:

1. `SUPABASE_URL`: URL project Supabase.
2. `SUPABASE_SECRET_KEY`: secret key chỉ dùng cho tác vụ backend, tạo trong
   Supabase Dashboard > Settings > API Keys.
3. `R2_CLEANUP_SECRET`: chuỗi ngẫu nhiên tối thiểu 40 ký tự, phải giống hoàn
   toàn Secret cùng tên trong Cloudflare Worker `chonhoctap-media`.

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
5. Ảnh của member/VIP/moderator được thu về khung 720p trước khi tải lên. Video
   VIP/moderator được kiểm tra 720p và 1 phút; R2 là nơi
   lưu trữ chứ không tự mã hóa lại video.

Nếu `MEDIA_API_URL` còn trống, website tạm thời dùng hai bucket Supabase cũ để
không làm gián đoạn phiên bản đang chạy.

## Nâng cấp diễn đàn V6

Sau `forum_v5_migration.sql`, chạy tiếp toàn bộ `forum_v6_migration.sql` trong
SQL Editor. V6 bổ sung:

- chống spam bình luận ở database: mỗi tài khoản chỉ gửi một bình luận sau
  mỗi 2 phút, kể cả khi tải lại trang hoặc xóa bình luận vừa gửi;
- Realtime cho bài viết, media, bình luận, cảm xúc, lượt chia sẻ, báo cáo và
  hộp thư thông báo;
- báo cáo mới xuất hiện ngay trong hộp thư của moderator và admin.

V12 bên dưới thay thế quy trình kiểm duyệt tự động của phiên bản này. Bình luận
văn bản/ảnh sẽ công khai ngay; âm thanh/video chờ admin.

## Nâng cấp diễn đàn V7

Sau `forum_v6_migration.sql`, chạy tiếp toàn bộ `forum_v7_migration.sql`. V7
đổi quy trình báo cáo: báo cáo chỉ tạo thư cho tài khoản admin, không tự ẩn hoặc
đổi trạng thái bài viết. Admin mở bài từ hộp thư rồi tự quyết định duyệt, ẩn hay
xóa. Migration cũng khôi phục các bài chưa được admin xem xét nhưng từng bị
trigger báo cáo cũ tự động ẩn.

V7 đồng thời sửa lỗi FileList làm media bình luận biến mất ngay sau khi chọn và
nâng thao tác cảm xúc: bấm nhanh để Thích/bỏ cảm xúc, nhấn giữ trên màn hình cảm
ứng hoặc rê chuột để chọn loại khác, đồng thời có bộ lọc người thả theo từng loại.

## Nâng cấp diễn đàn V8

Sau `forum_v7_migration.sql`, chạy tiếp toàn bộ `forum_v8_migration.sql`. V8
lưu mốc chống spam đăng bài trong bảng riêng thay vì suy ra từ bài gần nhất còn
tồn tại. Do đó, tác giả xóa bài vừa đăng vẫn phải chờ đủ 15 phút mới được đăng
bài tiếp theo. Frontend đọc mốc này từ RPC bảo mật và giữ thêm bản tạm trên
trình duyệt để đồng hồ không biến mất khi chuyển trang hoặc tải lại trang.

## Nâng cấp diễn đàn V9–V11

Chạy lần lượt `forum_v9_migration.sql`, `forum_v10_migration.sql` và
`forum_v11_migration.sql` để giữ đúng lịch sử schema. V9 bổ sung bộ lọc từ cấm
ngay trong database; V10 bổ sung hàng chờ admin cho âm thanh/video. Phần gọi
dịch vụ kiểm duyệt tự động của các phiên bản này đã được V12 gỡ bỏ hoàn toàn.

## Nâng cấp diễn đàn V12

Sau `forum_v11_migration.sql`, chạy toàn bộ `forum_v12_migration.sql`. V12:

- xóa lịch, trigger và thời hạn chờ dành cho kiểm duyệt tự động;
- xóa bộ từ cấm, dò dữ liệu cá nhân, chặn liên kết, dấu vân tay nội dung và dấu
  vân tay media;
- đưa mọi bài viết mới hoặc vừa chỉnh sửa vào hàng chờ;
- Staff và admin đang hoạt động có thể duyệt, ẩn hoặc hiện bài;
- Staff không thể xóa bài của người khác, quản lý role, kick, khóa hoặc cấm;
- chỉ admin có các quyền quản lý tài khoản và xóa nội dung của người khác;
- gửi thông báo bài chờ duyệt tới hộp thư của tất cả Staff và admin;
- công khai bình luận văn bản/ảnh ngay, vẫn giữ giới hạn 2 phút giữa hai lần
  bình luận;
- giữ bình luận có âm thanh/video trong hàng chờ admin;
- không cần secret hoặc Edge Function kiểm duyệt nào.

## Ma trận quyền theo role

Sau `forum_v12_migration.sql`, chạy toàn bộ `role_permissions_migration.sql`
trước khi cập nhật website. Migration này tạo phần thứ hai trong trang
`admin.html`:

- tab **Tài khoản** để admin set role và trạng thái hoạt động / tạm khóa / cấm;
- tab **Quyền theo role** để bật hoặc tắt quyền truy cập, đăng bài, bình luận,
  cảm xúc, chia sẻ, báo cáo và kiểm duyệt;
- RLS và RPC kiểm tra quyền trực tiếp trong database, không tin dữ liệu role từ
  giao diện;
- nhật ký `role_permission_audit_log` cho mọi lần thay đổi quyền;
- đồng bộ hộp thư bài chờ duyệt khi quyền Staff hoặc trạng thái tài khoản đổi.

Theo ranh giới an toàn của hệ thống, quyền duyệt/ẩn chỉ thuộc Staff hoặc admin.
Xử lý báo cáo, xóa nội dung người khác, quản lý tài khoản và thay đổi ma trận
quyền luôn bị khóa cho admin; không thể cấp các quyền này cho member, VIP hoặc
Staff. Hạn mức media vẫn cố định theo đặc quyền role và không nằm trong ma trận.

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
21. Chạy `forum_v4_migration.sql`, thử tải một tệp âm thanh và xác nhận trình
    phát xuất hiện trong bài hoặc bình luận.
22. Xác nhận bài Hỏi đáp đã giải có hạn 3 ngày; bài chưa giải có bình luận là
    5 ngày, chưa có bình luận là 7 ngày; bài Giải trí là 14 ngày.
23. Chạy workflow dọn dẹp thủ công với `dry_run = true`, đối chiếu số bài hết
    hạn rồi mới cho phép lần chạy thật.
24. Chạy `forum_v5_migration.sql`, rồi thử đủ member, VIP, moderator và admin ở
    cả bài viết lẫn bình luận.
25. Thử tag, trả lời, báo cáo, ẩn/hiện và kiểm tra chuông thông báo; mọi bài
    phải ở hàng chờ cho đến khi Staff hoặc admin duyệt.
26. Chạy `forum_v6_migration.sql`, rồi mở diễn đàn trên hai cửa sổ để kiểm tra
    Realtime, danh sách người thả cảm xúc và hộp thư báo cáo của moderator/admin.
27. Gửi hai bình luận liên tiếp và xác nhận lần hai bị chặn đủ 2 phút.
28. Chạy `forum_v7_migration.sql`; thử ảnh/âm thanh/video trong bình luận theo
    từng role, thao tác cảm xúc bằng chuột và cảm ứng, rồi gửi báo cáo để xác nhận
    chỉ admin nhận thư còn bài viết vẫn công khai đến khi admin quyết định.
29. Chạy `forum_v8_migration.sql`, đăng một bài rồi xóa ngay; tải lại diễn đàn
    và xác nhận nút đăng bài vẫn đếm ngược cho đến khi đủ 15 phút.
30. Chạy `forum_v9_migration.sql`; thử từ cấm viết chèn dấu/số và xác nhận
    database từ chối, còn âm thanh chỉ admin có thể duyệt.
31. Chạy lần lượt `forum_v10_migration.sql`, `forum_v11_migration.sql` và
    `forum_v12_migration.sql`.
32. Chạy `role_permissions_migration.sql`, mở `admin.html`, thử cả hai tab và
    tắt/bật một quyền không khóa của Staff; xác nhận thay đổi có hiệu lực ở một
    tài khoản Staff đang hoạt động.
32. Đăng bài bất kỳ và xác nhận bài nằm trong hàng chờ, Staff/admin nhận thông
    báo và đều có nút Duyệt/Từ chối. Staff được ẩn/hiện nhưng không được xóa bài
    của người khác hoặc quản lý tài khoản. Bình luận văn bản/ảnh công khai ngay;
    âm thanh/video trong bình luận vẫn chờ riêng admin.
