# Cloudflare R2 media Worker

Worker này là cổng duy nhất để diễn đàn Chốn Học Tập tải lên, đọc và xóa
ảnh/video/âm thanh trong bucket R2 riêng tư `chonhoctap-media`.

## Bảo mật

- Không đặt Access Key hoặc Secret Key của R2 trong GitHub Pages.
- Worker dùng R2 binding nên không cần khóa R2 trong mã nguồn.
- Mỗi lượt tải lên/xóa đều xác minh access token Supabase.
- Chỉ tài khoản `active` được tải tệp.
- Chủ tệp, moderator hoặc admin mới được xóa.
- Mỗi tài khoản tối đa 12 lượt tải lên trong một phút để hạn chế lạm dụng.
- Thành viên: ảnh 1,5 MB, video 25 MB, âm thanh 10 MB.
- VIP/staff: ảnh 3 MB, video 50 MB, âm thanh 20 MB.
- CORS chỉ mở cho `https://chonhoctap.github.io` và localhost khi phát triển.

## Thiết lập lần đầu

1. Trong Cloudflare Dashboard, tạo bucket R2 tên `chonhoctap-media`,
   Storage Class `Standard`.
2. Cài Node.js 20 trở lên rồi mở thư mục này:

   ```bash
   npm install
   npx wrangler login
   ```

3. Lưu Supabase publishable key dưới dạng Worker secret:

   ```bash
   npx wrangler secret put SUPABASE_ANON_KEY
   ```

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
