# Khung chat online thời gian thực

Khung chat chạy trực tiếp trên web: ai có link cũng vào được, đặt tên hiển
thị rồi trò chuyện ngay, không cần tài khoản. Chủ phòng có mật khẩu riêng
và toàn quyền quản lý phòng.

Chỉ dùng thư viện có sẵn của Node.js — **không cần `npm install`**, không
cần cơ sở dữ liệu. Lịch sử chat được lưu ra file nên khởi động lại máy chủ
vẫn còn. Tin nhắn mới tới ngay lập tức qua SSE (Server-Sent Events).

## Tính năng

- **Vào chat bằng link:** mở link, đặt tên hiển thị (2–20 ký tự, không
  trùng với người đang online), trò chuyện ngay.
- **Thời gian thực:** tin nhắn, người vào/ra, trạng thái đang gõ, danh sách
  online đều cập nhật ngay cho mọi người trong phòng.
- **Gửi hình ảnh:** bấm nút 📷 để chọn ảnh, hoặc dán ảnh từ clipboard
  (chụp màn hình rồi Ctrl+V). Ảnh hiển thị ngay trong khung chat, bấm vào
  để xem cỡ lớn. Mỗi ảnh tối đa 2 MB (đổi được bằng `MAX_IMAGE_MB`).
- **Link bấm được:** đường link http/https trong tin nhắn và chú thích ảnh
  sẽ thành link bấm được, mở sang tab mới.
- **Lưu chat lâu dài:** lịch sử chat (tối đa 1.000 tin nhắn), danh sách cấm
  và trạng thái khóa phòng được lưu ra file `chat-data.json`, khởi động
  lại máy chủ vẫn còn. Ảnh đã gửi lưu trong thư mục `uploads/`.
- **Chủ phòng (mật khẩu riêng):**
  - Xóa bất kỳ tin nhắn nào (nút ✕ bên cạnh tin nhắn, kể cả tin nhắn ảnh).
  - Đuổi người ra khỏi phòng.
  - Khóa/mở khóa chat của một người.
  - Cấm tên (tên đó không vào lại được) và gỡ cấm.
  - Khóa/mở khóa phòng (khi khóa, chỉ chủ phòng được nhắn).
  - Xóa toàn bộ lịch sử chat (kèm cả file ảnh đã gửi).
- **An toàn cơ bản:** nội dung chat được hiển thị dưới dạng văn bản thuần
  (không chạy mã HTML/JS người khác gửi), link chỉ bấm được khi bắt đầu
  bằng http/https, ảnh gửi lên được kiểm tra đúng định dạng ảnh, giới hạn
  độ dài và tốc độ nhắn, tên hiển thị trùng nhau không vào được.

## Cấu trúc dự án

```
chat-online-realtime/
├── server.js            Máy chủ chat (Node.js thuần, cổng 3000 mặc định)
├── package.json         Khai báo dự án (không có gói phụ thuộc)
├── render.yaml          Triển khai một lần bấm trên Render
├── .env.example         Mẫu biến môi trường
├── .gitignore
├── chat-data.json       File dữ liệu (tự tạo khi chạy, không đẩy lên git)
├── uploads/             Hình ảnh đã gửi (tự tạo khi chạy, không đẩy lên git)
├── public/
│   ├── index.html       Giao diện: màn hình đặt tên + khung chat
│   ├── style.css        Giao diện: màu sắc, bố cục, mobile
│   └── app.js           Giao diện: gọi API, nhận SSE, bảng chủ phòng
└── README.md            Tài liệu này
```

## Chạy thử trên máy của bạn

Cần Node.js 18 trở lên.

```bash
cd chat-online-realtime
node server.js
```

Mở trình duyệt: http://localhost:3000

Muốn đổi mật khẩu chủ phòng và tên phòng khi chạy thử:

```bash
OWNER_PASSWORD="mat-khau-manh-cua-ban" ROOM_NAME="Phòng chat lớp 9A" node server.js
```

Hoặc tạo file `.env` từ `.env.example` rồi chạy `node server.js` như thường
(máy chủ tự đọc file `.env` nếu có). Trong `.env.example` còn có
`DATA_FILE` (nơi lưu file dữ liệu), `UPLOADS_DIR` (nơi lưu ảnh đã gửi) và
`MAX_IMAGE_MB` (giới hạn dung lượng ảnh).

## Lấy link công khai (triển khai miễn phí)

### Cách 1: Render (khuyên dùng)

1. Đưa thư mục này lên GitHub (tạo repo mới, đẩy code lên).
2. Vào https://render.com → **New +** → **Web Service** → chọn repo vừa đẩy.
3. Render tự nhận `render.yaml`: gói **Free**, lệnh chạy `node server.js`.
4. Ở mục **Environment Variables**, đặt:
   - `OWNER_PASSWORD` = mật khẩu chủ phòng thật mạnh (bắt buộc đổi, đừng
     dùng mật khẩu mặc định).
   - `ROOM_NAME` = tên phòng muốn hiển thị (không bắt buộc).
5. Bấm **Create Web Service**, chờ vài phút. Render cấp một link dạng
   `https://chat-online-realtime.onrender.com` — gửi link này cho mọi
   người vào chat.
6. Lưu ý gói Free của Render: nếu 15 phút không ai truy cập, máy chủ sẽ
   "ngủ" và lần mở link đầu tiên sau đó sẽ chờ khoảng 30–60 giây để tỉnh
   lại. Ổ đĩa của gói Free là tạm thời: dữ liệu chat và ảnh đã gửi có thể
   mất khi Render triển khai lại hoặc chuyển máy chủ. Muốn lưu thật lâu
   dài thì chạy trên VPS/máy chủ có ổ đĩa bền (xem Cách 2) hoặc gắn ổ đĩa
   bền của Render (gói trả phí).

### Cách 2: Railway / Glitch / máy chủ Node.js bất kỳ

- **Railway:** tạo project mới từ repo GitHub, Railway tự chạy
  `npm start` (`node server.js`), đặt biến `OWNER_PASSWORD` trong mục
  Variables, lấy link ở mục Deployments.
- **Glitch:** import repo GitHub, đặt `OWNER_PASSWORD` trong file `.env`
  của Glitch, lấy link ở nút Share.
- **VPS/máy chủ riêng:** cài Node.js 18+, chạy
  `OWNER_PASSWORD="..." node server.js`, trỏ tên miền về cổng đã chạy
  (nên chạy sau HTTPS — xem mục Bảo mật). Trên VPS, file
  `chat-data.json` và thư mục `uploads/` nằm bền trên ổ đĩa nên chat và
  ảnh được lưu lâu dài thật sự.

## Hướng dẫn cho chủ phòng

1. Mở link phòng chat, đặt tên rồi vào phòng như mọi người.
2. Bấm nút **👑 Chủ phòng** ở góc phải trên cùng, nhập mật khẩu chủ phòng
   (đã đặt trong biến `OWNER_PASSWORD` lúc triển khai).
3. Khi đã là chủ phòng, tên của bạn có vương miện 👑 và bạn có thể:
   - Bấm ✕ bên cạnh bất kỳ tin nhắn nào để xóa (xóa tin nhắn ảnh cũng
     xóa luôn file ảnh đó).
   - Ở danh sách "Đang online", bấm **Khóa chat / Đuổi / Cấm** bên cạnh
     tên một người.
   - Ở bảng chủ phòng: **Khóa phòng / Mở khóa phòng**, **Xóa toàn bộ
     chat**, xem và **Gỡ cấm** các tên đã cấm.

## Giới hạn cần biết

- **Lưu trữ bằng file:** lịch sử chat tối đa 1.000 tin nhắn (người mới vào
  xem 200 tin gần nhất), ảnh đã gửi lưu trong `uploads/` (tối đa 500
  file). Trên gói Free của Render, ổ đĩa là tạm thời nên dữ liệu có thể
  mất khi triển khai lại; trên VPS/máy chủ riêng thì dữ liệu còn mãi.
- **Một phòng duy nhất:** mọi người vào cùng một link là cùng một phòng.
- **Cấm theo tên:** người bị cấm vẫn có thể vào lại bằng tên khác. Đây là
  mức kiểm soát phù hợp cho nhóm nhỏ, quen biết nhau.
- **Quy mô:** phù hợp nhóm nhỏ tới vài chục người cùng online. Máy chủ
  dùng SSE và lưu file nên không dành cho hàng nghìn người.

## Bảo mật

- Luôn đặt `OWNER_PASSWORD` thật mạnh khi triển khai, không dùng mật khẩu
  mặc định `chu-phong-123`.
- Luôn dùng link `https://` (Render, Railway, Glitch đều cấp HTTPS sẵn).
  Không gửi mật khẩu chủ phòng qua chat.
- Đây là bản demo cho nhóm nhỏ, tin cậy lẫn nhau — không dùng cho nội dung
  nhạy cảm, không thu thập thông tin cá nhân qua khung chat này.
