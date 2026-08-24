# Cloudflare R2 media Worker

Worker này là cổng duy nhất để diễn đàn Chốn Học Tập tải lên, đọc và xóa
ảnh/video/âm thanh trong bucket R2 riêng tư `chonhoctap-media`.

## Bảo mật

- Không đặt Access Key hoặc Secret Key của R2 trong GitHub Pages.
- Worker dùng R2 binding nên không cần khóa R2 trong mã nguồn.
- Mỗi lượt tải lên/xóa đều xác minh access token Supabase.
- Chỉ tài khoản `active` được tải tệp.
- Chủ tệp hoặc admin mới được xóa; moderator không thể xóa tệp của người khác.
- Tác vụ dọn bài hết hạn chỉ được xóa hàng loạt qua `R2_CLEANUP_SECRET` dùng
  riêng giữa GitHub Actions và Worker.
- Mỗi tài khoản thường tối đa 12 lượt tải lên trong một phút để hạn chế lạm dụng.
- Member/moderator và bình luận VIP vẫn chịu hạn mức theo giao diện và database.
- Bài viết VIP không giới hạn số lượng, dung lượng, thời lượng hoặc độ phân giải
  media ở tầng ứng dụng và không bị rate limiter tải tệp.
- Tệp bài viết VIP lớn hơn 40 MB được chia nhỏ và ghép trực tiếp bằng R2
  Multipart Upload, không nén video xuống 720p.
- CORS chỉ mở cho `https://chonhoctap.github.io` và localhost khi phát triển.

## Thiết lập lần đầu

1. Trong Cloudflare Dashboard, tạo bucket R2 tên `chonhoctap-media`,
   Storage Class `Standard`.
2. Cài Node.js 20 trở lên rồi mở thư mục này:

   ```bash
   npm install
   npx wrangler login
   ```

3. Lưu Supabase publishable key và một chuỗi dọn dẹp ngẫu nhiên tối thiểu
   40 ký tự dưới dạng Worker secrets:

   ```bash
   npx wrangler secret put SUPABASE_ANON_KEY
   npx wrangler secret put R2_CLEANUP_SECRET
   ```

   Giá trị `R2_CLEANUP_SECRET` phải được lưu thêm bằng đúng chuỗi đó tại
   GitHub repository > Settings > Secrets and variables > Actions. Không đặt
   chuỗi này trong mã nguồn hoặc gửi qua cuộc trò chuyện.

4. Triển khai:

   ```bash
   npm run deploy
   ```

5. Mở URL `/health` của Worker. Kết quả đúng:

   ```json
   {"ok":true,"service":"chonhoctap-media","storage":"r2"}
   ```

6. Chép URL Worker, ví dụ
   `https://chonhoctap-media.ten-tai-khoan.workers.dev`, vào
   `assets/media-config.js`.

Không cần bật Public Development URL cho bucket. Người xem nhận tệp qua
`/media/...` của Worker; bucket vẫn ở chế độ riêng tư.

Endpoint `POST /api/cleanup` chỉ nhận tối đa 500 object key bắt đầu bằng
`post/` hoặc `comment/`. Tác vụ sẽ thử lại khi Worker lỗi và không xóa dòng bài
viết khỏi Supabase nếu R2 chưa xác nhận xóa đủ media.

Các endpoint `/api/media/multipart/*` chỉ chấp nhận lượt tải đã xác thực và
object key phải thuộc đúng tài khoản. Phần đầu tiên vẫn được kiểm tra chữ ký
định dạng trước khi R2 nhận tệp.
