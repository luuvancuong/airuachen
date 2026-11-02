# Ai rửa chén? — mini-game TikTok Live

Người xem comment **vk** để thêm chén cho Vợ, **ck** để thêm chén cho Chồng. Ai nhiều chén hơn thì đứng rửa (hoà thì giữ nguyên, vòng đầu mặc định Vợ rửa). Người xem đã chọn bên nào thì quà, tim, follow, share của họ cộng chén cho bên đó, mặc định 1 xu = 5 chén. Hết thanh thời gian, người đang rửa thua và vòng sau bắt đầu với người thua đứng rửa.

Tên hai bên, từ khoá, nhân vật và bối cảnh đổi theo cặp (Vợ/Chồng ở bếp gia đình, Anh/Em ở phòng trọ, Mẹ chồng/Nàng dâu ở bếp quê, Sếp/Nhân viên ở pantry văn phòng), quà to có hiệu ứng phủ cả màn hình, có giờ vàng, quà cứu nguy, sự kiện ngẫu nhiên, bình chọn hình phạt, mục tiêu quà cả phòng và giọng đọc Vbee.

## Chạy trên máy stream

Cần Node.js 20 trở lên.

```bash
npm install
npm start
```

1. Mở `http://localhost:3000` để vào bảng điều khiển.
2. Bật live trên TikTok trước, rồi nhập username (ví dụ `@tenkenh`, hoặc dán link `tiktok.com/@tenkenh/live`) và bấm **Kết nối**. Link rút gọn `vm.tiktok.com/…` không dùng được.
3. Trong OBS, thêm **Browser Source** với URL `http://localhost:3000/?obs=1`, kích thước **1080 × 1920**, tick **Control audio via OBS** để tiếng chén, tiếng quà và giọng đọc đi vào live.

Vòng đầu tự bắt đầu khi có comment hợp lệ đầu tiên, hoặc bấm **Bắt đầu** trong bảng điều khiển. Các nút **Thử nhanh** giả lập comment và quà để test trước khi lên sóng.

Nếu cổng 3000 đang có một bản khác chạy, server báo “Cổng 3000 đang được dùng” rồi thoát. Tắt bản cũ hoặc chạy với `PORT` khác.

## Giọng đọc Vbee

1. Tạo app ở https://studio.vbee.vn/apps → “Tích hợp API” → “Tạo ứng dụng”, lấy **App ID** và **Token**.
2. Chép `.env.example` thành `.env` trong thư mục dự án, điền:

   ```
   VBEE_APP_ID=...
   VBEE_TOKEN=...
   # VBEE_VOICE=hn_female_ngochuyen_full_48k-fhg
   ```

3. Chạy lại `npm start`. Dòng “Giọng đọc” trong terminal và bảng điều khiển sẽ ghi **Vbee**. Bấm **Đọc thử** để nghe.

Server tự nạp `.env` (không ghi đè biến đã đặt sẵn trong môi trường). Khoá chỉ nằm ở server: không gửi xuống trình duyệt, không in ra log. File `.env` đã có trong `.gitignore`.

Câu được đọc: cảm ơn quà từ `ttsMinCoins` xu trở lên (mặc định 10, kể cả quà tặng lúc tạm dừng hay giữa hai vòng), đổi người rửa (tối đa 1 lần/10 giây), kết quả vòng, giờ vàng, đạt mục tiêu quà, hình phạt được chọn. Mp3 được cache trong `data/tts/` (tối đa khoảng 200 file). Chỉ overlay `?obs=1` phát tiếng; bảng điều khiển chỉ phát khi bật “Phát giọng đọc ở tab này”, để không đọc đôi.

Không có khoá thì dùng giọng của trình duyệt (`speechSynthesis` vi-VN nếu máy có, không thì im lặng). Khoá sai, hết hạn hay hết credit: server báo một lần trên bảng điều khiển rồi chuyển hẳn sang giọng trình duyệt. Lỗi mạng hay Vbee quá 15 giây không trả lời: bỏ câu đó, báo một lần, câu sau vẫn thử Vbee. Game không bị ảnh hưởng. Tắt hẳn bằng công tắc giọng đọc trong Luật chơi.

## Chỉnh luật chơi

Chỉnh ngay trong bảng điều khiển, lưu vào `data/settings.json`:

| Mục | Mặc định |
|---|---|
| Mỗi vòng | 180 giây |
| Chén mỗi comment | 1 |
| Chén mỗi xu quà | 5 (nhỏ hơn 1 thì phần lẻ cộng dồn theo từng người) |
| Mỗi người chỉ tính 1 comment trong | 1 giây (chống spam) |
| Quà của người chưa chọn bên | Cộng cho người đang rửa |
| Tự sang vòng mới | Bật, sau 10 giây |
| Tim | 10 tim = 1 chén cho phe người xem đã comment chọn, tối đa 600 tim mỗi người mỗi vòng |
| Follow / share | 0 / 0 chén (tắt, vì thưởng điểm đổi follow dễ bị coi là trao đổi tương tác; bật được) |
| Tên hai bên, từ khoá | Vợ (`vk`, `vợ`) / Chồng (`ck`, `chồng`), có preset nhanh |
| Nhân vật, bối cảnh | Vợ + Chồng, bếp gia đình; nút cài sẵn đổi cả bộ, chọn riêng từng bên được |
| Giờ vàng | 30 giây cuối vòng, comment và tim ×2, không nhân quà (tối đa nửa vòng) |
| Quà cứu nguy | Kem ốc quế (Ice Cream Cone, 1 xu): tặng để trừ chén cho bên mình |
| Sự kiện ngẫu nhiên | Bật |
| Bình chọn hình phạt | Bật, 15 giây |
| Mục tiêu quà cả phòng | Tắt |
| Chào người mới vào phòng | Bật |
| Quà tặng khách mời (multi-guest) | Không tính |
| Giọng đọc | Bật, giọng Minh Quân, cảm ơn mọi quà, tối đa 1 câu/10 giây (quà dồn thì gộp tên) |
| Phòng vắng | Sau 20 giây không ai tương tác: nhân vật tự cử động, điện thoại “Ví dụ”, vòng “Máy tự chơi” (không tính điểm); nút “Streamer vào phe” (+5 chén) |
| Lời dẫn tự động | Bật, nói gần như liên tục (lặng 3 giây giữa hai câu), đoạn dẫn mở mỗi vòng mới, tự dừng khi bạn nói (micro hoặc nút “🎙️ Tôi đang nói”) và khi đọc cảm ơn quà; có câu báo giọng AI; nút “Tắt lời dẫn” ở mục Vòng chơi |
| Nhạc nền | Bật, âm lượng 25, tự tổng hợp (không bản quyền), nhỏ lại khi có giọng đọc |

Comment được nhận khi có nguyên từ khoá của một bên (cả `vkkk`, `VK`…); comment nhắc cả hai bên thì không tính. Bản không dấu (`vo`, `chong`) chỉ tính khi comment chỉ có đúng một từ đó, để “vô”, “chống”… không bị tính nhầm.

Tim, follow, share chỉ tính cho người đã chọn bên. Lúc tạm dừng hay đang hiện kết quả, chén được xếp hàng (“+n chờ” trên chồng chén) và cộng khi tiếp tục hay khi vòng mới mở; bấm “Kết thúc vòng ngay” lúc đang dừng thì hàng chờ được tính cho vòng đó. Tắt “Tự sang vòng mới” thì comment lúc chờ chỉ ghi nhớ bên, không cộng chén.

Ván đang chơi (tỉ số, lịch sử, bảng ủng hộ, người đã chọn bên) được lưu vào `data/state.json` và nạp lại khi khởi động, ở trạng thái tạm dừng. Nút **Tải CSV người ủng hộ** xuất danh sách cả buổi (tên, bên, chén, xu).

## Biến môi trường

Đặt trong `.env` hoặc trước lệnh `npm start`.

| Biến | Tác dụng |
|---|---|
| `PORT` | Cổng chạy, mặc định 3000 |
| `HOST` | Mặc định `127.0.0.1` (chỉ máy này). Đặt `0.0.0.0` khi chạy trên VPS |
| `ADMIN_TOKEN` | Bắt buộc nên đặt khi chạy trên VPS. Bảng điều khiển mở bằng `/?token=...`; link `/?obs=1` không cần token và chỉ xem được |
| `TIKTOK_USERNAME` | Tự kết nối phòng live khi khởi động |
| `EULER_API_KEY` | Tuỳ chọn, key của Euler Stream giúp kết nối TikTok ổn định hơn |
| `VBEE_APP_ID`, `VBEE_TOKEN` | Khoá Vbee. Thiếu thì dùng giọng trình duyệt |
| `VBEE_VOICE` | Mã giọng, mặc định `hn_female_ngochuyen_full_48k-fhg` (đổi được trong Luật chơi) |
| `VBEE_SPEED` | Tốc độ đọc 0,25–1,9, mặc định 1,1 |
| `VBEE_MODE` | `auto` (thử sync, lỗi thì async), `sync` hoặc `async` |
| `DISH_DATA_DIR` | Thư mục lưu `settings.json`, `state.json`, `tts/` (mặc định `data/`) |
| `DISH_NO_ENV` | Đặt `1` để không đọc file `.env` (dùng khi test) |

Ví dụ trên VPS (Linux):

```bash
HOST=0.0.0.0 ADMIN_TOKEN=matkhau123 TIKTOK_USERNAME=tenkenh npm start
```

Trên Windows PowerShell:

```powershell
$env:ADMIN_TOKEN="matkhau123"; npm start
```

## Dùng TikFinity hoặc Streamer.bot thay cho kết nối trực tiếp

Kết nối TikTok trong gói này dùng thư viện không chính thức `tiktok-live-connector`. Nếu TikTok đổi giao thức và kết nối lỗi, thử `npm i tiktok-live-connector@latest`, hoặc cho công cụ khác bắn sự kiện vào `/event`:

```
GET  /event?type=chat&user=Lan&text=vk
GET  /event?type=gift&user=Lan&coins=30&gift=Donut
GET  /event?type=like&user=Lan&count=15
GET  /event?type=follow&user=Lan
GET  /event?type=share&user=Lan
POST /event   {"type":"gift","user":"Lan","coins":30,"gift":"Donut"}
```

Thêm `&token=...` nếu có đặt `ADMIN_TOKEN`. Với quà, `coins` là tổng xu (giá quà × số lượng). Body POST tối đa 100 KB (quá thì trả 413).

## Kiểm tra

```bash
npm test
```

Chạy test engine (`test/engine.test.mjs`) và server (`test/server.test.mjs`, tự chạy server thật ở cổng 3993–3994 với Vbee giả, không cần mạng).

Thử bằng tay không cần live: chạy server ở cổng khác cho khỏi đụng bản đang dùng, rồi bắn sự kiện.

```bash
PORT=3996 DISH_DATA_DIR=/tmp/dish-test npm start
curl "localhost:3996/event?type=chat&user=Lan&text=vk"
curl "localhost:3996/event?type=gift&user=Minh&coins=30&gift=Donut"
curl "localhost:3996/event?type=like&user=Lan&count=60"
```

Mở `http://localhost:3996/?obs=1` để xem overlay.

## Cấu trúc

```
server.js          Server: nghe TikTok Live, chạy luật chơi, đẩy trạng thái qua WebSocket, giọng đọc, lưu phiên
server-util.js     Hàm thuần của server (.env, token, username, chống trùng, CSV, câu đọc)
tts.js             Gọi Vbee, hàng đợi và cache mp3
public/engine.js   Luật chơi (dùng chung cho server và bản demo chạy trong trình duyệt)
public/index.html  Overlay 9:16 + bảng điều khiển; ?obs=1 chỉ hiện màn hình game
data/              settings.json, state.json, tts/ (tự tạo)
test/              Test node:test
scripts/           build-demo.mjs: npm run build:demo tạo bản demo một file trong dist/
CLAUDE.md          Bối cảnh dự án cho Claude Code
```

Bố cục đã chừa phần dưới màn hình cho khung comment của TikTok: điểm số, thời gian, hai chồng chén và thẻ kết quả nằm ở nửa trên.

## Chính sách TikTok

Đọc [CHINH-SACH-TIKTOK.md](CHINH-SACH-TIKTOK.md) trước khi live: rủi ro “gift baiting”, LIVE tự động, nhãn giọng AI, câu nên tránh và checklist trước mỗi buổi.
