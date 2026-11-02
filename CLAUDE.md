# Ai rửa chén? — mini-game tương tác cho TikTok Live

Overlay dọc 9:16 cho OBS: người xem comment `vk`/`ck` để thêm chén cho Vợ/Chồng, quà/tim/follow/share cộng chén, ai nhiều chén hơn thì đứng rửa. Có tên hai bên tuỳ chỉnh, giờ vàng, quà cứu nguy, sự kiện ngẫu nhiên, bình chọn hình phạt, mục tiêu quà cả phòng, giọng đọc Vbee, lưu/khôi phục ván. Giao diện và nội dung hiển thị đều bằng tiếng Việt.

## Lệnh

- `npm install` rồi `npm start`: chạy server ở `http://localhost:3000` (bảng điều khiển) và `/?obs=1` (overlay sạch cho OBS, 1080 × 1920). Cổng bị chiếm thì server báo rồi thoát mã 1.
- `npm run dev`: chạy với `node --watch`.
- `npm test`: `node --test test/*.test.mjs` (engine + server; test server tự chạy server thật ở cổng 3993 với Vbee giả ở 3994, data trong thư mục tạm).
- `npm run build:demo`: tạo `dist/ai-rua-bat-demo.html`, bản một file chạy trong trình duyệt không cần server (engine nhúng sẵn, có nút giả lập).
- Test nhanh không cần live: `curl "localhost:3000/event?type=chat&user=Lan&text=vk"`, `curl "localhost:3000/event?type=gift&user=Lan&coins=30&gift=Donut"`, `type=like&count=60`, `type=follow`, `type=share`. Muốn chạy bản thử song song bản đang dùng thì đặt `PORT` khác và `DISH_DATA_DIR` riêng.

## Kiến trúc

- `public/engine.js`: toàn bộ luật chơi, file UMD gán `globalThis.DishGame` (`createEngine`, `detectTeam`, `cleanName`, `cleanText`, `stripDiacritics`, `sanitizeSettings`, `DEFAULTS`, `TEAMS`, `EVENT_LABELS`). Dùng chung cho server và bản demo. Engine không tự đọc đồng hồ hay số ngẫu nhiên: dùng `opts.now()` và `opts.random()` được truyền vào, host phải gọi `tick()` định kỳ. Engine trả thêm `teamOfUser(id)`, `getSupporters()` (CSV), `exportState()` / `importState(o)`.
- Mọi luật mới có trong `DEFAULTS`, đi qua `sanitizeSettings` và có ô trong form Luật chơi. Mã nội bộ hai bên luôn là `vk` / `ck`; tên hiển thị lấy từ `settings.labels`.
- `server.js` (ESM, Node ≥ 20): server là nguồn sự thật duy nhất. Chạy engine, gửi `state` 4 lần/giây (và ngay khi có thay đổi), gửi `fx` cho từng hiệu ứng. Nghe TikTok qua `tiktok-live-connector` 2.5.0 (chat, gift, like, follow, share, member; chống trùng theo `d.common.msgId`, tự nối lại có backoff), nhận sự kiện ngoài qua `/event` (GET/POST, body ≤ 100 KB, quá thì 413), phục vụ `public/`. Route `/config.js` trả `window.DISH_SERVER = true` để client biết đang chạy với server. Chặn request từ trang web khác (Origin / Sec-Fetch-Site / Host lạ), WS quá 50 message/giây bị đóng 1008.
- `server-util.js`: hàm thuần của server để test được (`.env`, token, username, chống trùng, quà khách mời, CSV, `ttsLine` tạo câu đọc từ fx). `tts.js`: gọi Vbee (sync, lỗi thì async + hỏi lại), hàng đợi tối đa 5 câu, bỏ câu cũ quá 20 giây, timeout 15 giây, cache mp3 trong `data/tts/` (~200 file).
- Server tự nạp `.env` ở thư mục dự án (không ghi đè biến có sẵn; `DISH_NO_ENV=1` để tắt). Khoá Vbee (`VBEE_APP_ID`, `VBEE_TOKEN`, `VBEE_VOICE`…) không bao giờ gửi xuống client hay in ra log; token admin chỉ in 4 ký tự đầu.
- `public/index.html`: một file chứa CSS + JS, gồm sân khấu 1080 × 1920 (được scale cho vừa khung) và bảng điều khiển. Không có `DISH_SERVER` thì tự tạo engine trong trình duyệt (chế độ demo, lưu luật chơi ở localStorage, giọng đọc bằng `speechSynthesis`). Hai dòng script có marker `<!--SERVER_CONFIG-->` và `<!--ENGINE-->` là chỗ `build:demo` thay thế, đừng xoá marker.
- Dữ liệu trong `DISH_DATA_DIR` (mặc định `data/`): `settings.json` (luật chơi), `state.json` (ván đang chơi, ghi debounce 1 giây, nạp lại khi khởi động ở trạng thái tạm dừng), `tts/`. Ghi file kiểu ghi `.tmp` rồi rename; JSON hỏng thì đổi tên thành `.bak`.
- Route khác: `/health`, `/export.csv?token=` (người ủng hộ cả buổi), `/tts/<hash>.mp3`.

### Giao thức WebSocket `/ws`

- Server gửi: `hello {state, live, canControl}`, `state {state}`, `fx {fx}`, `live {live}`, `notice {message}`.
- Client gửi: `control {action, payload}` với action `start | pause | toggle | endRound | reset | settings | clearTeams | event | ttsTest` (`event` = streamer bấm thử sự kiện ngẫu nhiên, payload `{kind}`; `ttsTest` do server xử lý); `event {event}` (giả lập); `live {action: 'connect', username}` hoặc `live {action: 'disconnect'}`.
- `fx.type`:
  - `add` (team, n, user, source `comment|gift|like|follow|share|rescue|queued`, giftName, count, coins, mult). `n` âm với `rescue`. `queued` là chén xếp hàng được cộng một lần khi vòng mới mở / khi tiếp tục (thêm `people`). Quà tặng lúc tạm dừng hay đang hiện kết quả phát ngay một fx `add` có `queued: true` (source vẫn là `gift`/`rescue`, `n` là số sẽ cộng) để overlay hiện toast và server đọc lời cảm ơn; chén chưa vào chồng, client không bay số.
  - `swap` (washer), `round`, `result` (+ `score`, `reason` `timeout|manual`, `punishment`), `reset`, `settings`.
  - `golden` (mult, seconds), `event` (kind `drought|storm|slip|swapPiles`, label, durationMs, team/n với slip), `goal` (coins, text, totalCoins), `vote` (stage `open|closed`, options, counts, winner, text), `join` (name, team|null; do server phát, tối đa 1 lần/4 giây), `tts` (url mp3 hoặc null = trình duyệt tự đọc `text`).
- `state` có thêm: `score {vk, ck}` (số vòng thắng), `history` (10 vòng gần nhất), `golden`, `queued {vk, ck}`, `sessionTop {vk, ck}` (top 5 cả buổi, có xu), `activeEvent`, `vote`, `totalCoins`, `goal {coins, text, reached}`, `restored` (số vòng khôi phục), `tts {mode: 'vbee'|'browser'|'off', error?}` (server gắn).
- `exportState()` lưu thêm `queuedCount` và `queuedContrib` để chén chờ khôi phục sau khi khởi động lại vẫn có tên người góp.
- Có `ADMIN_TOKEN` thì client thiếu `?token=` chỉ xem được, mọi lệnh bị từ chối.

## Luật chơi (đã chốt với người dùng)

- Comment chứa từ khoá của một bên thêm chén cho bên đó; mặc định `vk`/`vợ` cho Vợ, `ck`/`chồng` cho Chồng (khớp nguyên từ, cả `vkkk`, `ckck`; bản không dấu của từ khoá như `vo`/`chong` chỉ tính khi comment chỉ có đúng từ đó). Comment nhắc cả hai bên thì không tính. Người xem được ghi nhớ bên đã chọn.
- Quà: số chén = tổng xu × `dishesPerCoin` (mặc định 5, người dùng nhờ chọn bộ mặc định tốt nhất: 1 Hoa hồng = 5 comment), cộng cho bên người tặng đã chọn. Quà combo (`gift.type === 1`) chỉ tính một lần khi `repeatEnd`.
- Ai nhiều chén hơn là người đang rửa, hoà giữ nguyên. Vòng đầu mặc định Vợ rửa.
- Vòng bắt đầu khi có sự kiện hợp lệ đầu tiên hoặc khi bấm Bắt đầu.
- Giọng đọc dùng Vbee, khoá đặt trong `.env`. Không có khoá thì dùng giọng trình duyệt.

Các điểm Claude tự chọn khi người dùng chưa nói rõ (là mặc định tự chọn, đều có thể đổi trong bảng điều khiển):

- Hết giờ thì người đang rửa thua và đứng rửa vòng sau; quà của người chưa chọn bên cộng cho người đang rửa; mỗi người chỉ tính 1 comment/giây; vòng 180 giây; tự sang vòng mới sau 10 giây (đủ để giọng đọc kết quả).
- `dishesPerCoin` < 1: phần lẻ cộng dồn theo từng người, đủ 1 chén mới cộng; xu của lần tặng chưa đủ 1 chén vẫn ghi vào bảng ủng hộ.
- Tạm dừng hoặc đang hiện kết quả: chén xếp hàng, gộp theo bên, cộng khi tiếp tục / vòng mới mở (không đổi người rửa lúc đang dừng). Kết thúc vòng lúc đang dừng thì hàng chờ được tính cho vòng đó trước khi chốt. Tắt tự sang vòng (pha `ended`) thì chỉ ghi nhớ bên, không cộng chén.
- Tim: 20 tim = 1 chén, tối đa 600 tim tính mỗi người mỗi vòng. Follow, share mặc định 0 chén (tắt theo rà soát chính sách: thưởng điểm đổi follow là trao đổi tương tác), mỗi người 1 lần mỗi vòng. Người chưa chọn bên thì không tính tim/follow/share.
- Giờ vàng: 30 giây cuối, comment và tim ×2, không nhân quà và hàng chờ (chính sách: tránh “khuyến mãi quà có hạn giờ”); `goldenSeconds` bị kẹp tối đa nửa `roundSeconds` ngay trong `sanitizeSettings` (form hiện đúng số đang dùng).
- Quà cứu nguy: mặc định Kem ốc quế (`Ice Cream Cone`, 1 xu, “mời kem để cứu”); tên tiếng Việt và tên TikTok của cùng quà khớp nhau qua danh mục `TIKTOK_GIFTS` trong engine; trừ chén bên người tặng, sàn 0; người chưa chọn bên thì cứu người đang rửa.
- Sự kiện ngẫu nhiên: mặc định bật; mỗi 60–100 giây, không rút trong 30 giây cuối hay giờ vàng.
- Bình chọn hình phạt: mặc định bật, 15 giây, comment `1`/`2`/`3`, mỗi người 1 phiếu (đổi được), hoà thì rút ngẫu nhiên trong các lựa chọn bằng phiếu.
- Mục tiêu quà cả phòng: mặc định tắt; `totalCoins` tính mọi quà cả buổi (kể cả quà cứu nguy).
- Quà tặng khách mời (multi-guest) không tính; chỉ lọc khi đọc được id chủ phòng.
- Lời chào người mới bật; giọng đọc bật, cảm ơn mọi quà (`ttsMinCoins` 1, gộp tối đa 1 câu/10 giây); đổi người đọc tối đa 1 lần/10 giây.
- Danh mục quà `TIKTOK_GIFTS` (engine.js, 40 quà, tên TikTok + tên Việt + giá xu tham khảo) dùng cho nút giả lập, đọc tên quà và quà cứu nguy. Khi kết nối live, server lấy danh sách quà thật của phòng (`fetchAvailableGifts`) gửi message `gifts {gifts:[{name, coins}]}` để thay danh sách giả lập.
- Giọng đọc Vbee mặc định Minh Quân (`hn_male_minhquan_yt-stable`, người dùng chọn), tốc độ 1.1. Gói Vbee của người dùng không có sync nên mỗi câu mới mất ~2–3 giây; để đọc trong ~1 giây, câu được tách đoạn (`ttsParts`): “{quà} cho {bên}!” và câu cố định tạo sẵn lúc mở server, “Cảm ơn {tên} nhé!” tạo sẵn khi người xem comment/thả tim lần đầu; đoạn chưa có thì tạo song song và nối vào sau.
- Lời dẫn tự động (`HOST_LINES`, `hostLine`, `hostStateLine` trong engine; lập lịch `hostTick` trong server, bản demo tự lập lịch ở client): mặc định 180 giây ±25% một câu, cứ câu thứ ba là câu theo diễn biến ván, câu báo giọng AI (`HOST_AI_LINE`) lúc bắt đầu và 30 phút một lần, câu nhắc quà (có chữ quà/tặng) tối đa 15 phút một lần và luôn có “không bắt buộc”. Không đọc lúc hiện kết quả, lùi lại nếu vừa có giọng quà. Client có kênh `Host` riêng: giọng quà (`Voice`) chen vào thì câu dẫn tắt dần, giọng quà xong 1,8 giây thì đọc lại câu đó. fx mới: `host {url, text}`.
- Nhạc nền `Music` tự tổng hợp bằng Web Audio (vòng hoà âm 100 BPM), chỉ phát nơi phát giọng đọc, hạ còn 30% khi có giọng. Cảm ơn quà tối đa 1 lần/10 giây, quà tới trong lúc đó gộp thành “Cảm ơn A, B và n bạn nữa”. Tên có link / số điện thoại / tag / từ cấm (`bannedWords`) đọc là “bạn”, hiện là “Một bạn”. Chữ trên overlay không tôn vinh theo tiền: không bảng giá xu, thẻ quà chỉ “Cảm ơn!” không số xu, “⭐ Fan cứng” thay “đại gia 👑”. Mọi quyết định này theo `CHINH-SACH-TIKTOK.md` (gift baiting, LIVE tự động, nhãn AI); sửa kịch bản thì đối chiếu file đó.
- Phòng vắng (người dùng muốn live không bị đứng im; đã từ chối làm người xem / comment / quà giả vì TikTok cấm tương tác giả): engine đếm `idleMs` từ lần tương tác thật gần nhất (`handle` trả true, hoặc streamer chọn phe). Vắng quá `idleSeconds` (20) thì: client bật `#stage[data-idle]` (nhân vật nhún nhảy, mèo / chim đi ngang, nước bắn, điện thoại “Ví dụ” gõ từ khoá, đĩa minh hoạ không cộng chén); ở pha ready engine chạy vòng khởi động `warmup` (máy “comment” từ khoá một bên mỗi 0,9–2,2 giây, cộng `dishesPerComment` chén thật, đổi người thật kèm banner ghi “máy chơi”, điện thoại bên trái gõ theo từng lượt với nhãn “🤖 Máy chơi / Máy:”, tổng quá 24 chén thì về 0, fx `add` source `bot` tên “Máy”, `swap` có `bot: true`, fx `warmup {on, reset}`, nhãn “🤖 Máy tự chơi”, không đọc, không tính điểm / bảng / CSV, không lưu; có người chơi thật thì `startRound` xoá về 0). Lời dẫn dùng câu phòng vắng nói thật (“bạn là người đầu tiên”), tối đa 90 giây một câu. Lúc máy chơi có lời dẫn riêng (`warmupLine`): câu mở đầu hướng dẫn cách chơi ngay khi máy bắt đầu, câu giải thích luật khi máy làm đổi người (cách câu trước ≥ 15 giây), còn lại khoảng 30 giây một câu xoay vòng (hướng dẫn, mẹo, tỉ số, “một comment là chơi thật”); chỉ mời comment / tim, không nhắc quà. Streamer có nút chọn phe (`control streamer {team}`, `streamerDishes` chén dưới tên “Streamer”). Đang kết nối live thì server từ chối `event` giả lập từ WS và bảng điều khiển khoá mục Thử nhanh.
- Sau mỗi vòng, tỉ số tính số vòng THẮNG (không phải rửa) của mỗi bên.

## Quy ước giao diện

- Toạ độ sân khấu tính theo px của khung 1080 × 1920. Phần dưới (khoảng y > 1450) bị khung comment của TikTok che, nên thông tin quan trọng nằm ở nửa trên. Thẻ kết quả bám từ y = 150; đang bình chọn thì ẩn mặt nhân vật, người góp và đại gia, còn tràn quá y 1440 thì `fitResult()` ẩn dần phần phụ.
- HUD (tiêu đề, thanh thời gian, thẻ điểm, thanh mục tiêu, hướng dẫn) kết thúc khoảng y ≈ 830. `MAX_VISIBLE = 18` đĩa mỗi chồng để nhãn số trên chồng chén không chui vào HUD; muốn tăng phải dời HUD hoặc thu nhỏ đĩa. Bong bóng số (+n) đặt từ y ≥ 960 để bay lên 120px vẫn dưới HUD.
- Chữ người xem cần đọc ≥ 34px. Không thu nhỏ chữ dưới mức này: dòng dài thì rút gọn nội dung (Góp nhiều chỉ còn top 1, tên cắt ngắn; câu hướng dẫn dài tách thành hai câu luân phiên; toast bỏ chữ “chén”) rồi mới cắt bằng “…”. Chữ phụ được phép nhỏ hơn: đơn vị “chén” cạnh số to, chấm “Đang kết nối lại…”.
- Toast quà nằm ở cột giữa x 250–830 để không che nhãn số trên hai chồng chén.
- Không dùng file ảnh hay âm thanh ngoài (trừ mp3 giọng đọc do server tạo): nhân vật và bếp vẽ bằng SVG inline (`charSVG()`), âm thanh tổng hợp bằng Web Audio (`Sfx`). Font Be Vietnam Pro từ Google Fonts, có fallback hệ thống.
- Tên game hiển thị là “Ai rửa chén?” (người dùng chọn thay cho “bát”). Tên gói `ai-rua-bat`, file demo và khoá localStorage `ai-rua-bat:*` giữ nguyên để không mất luật đã lưu.
- Nhân vật theo `settings.characters {vk, ck}` (8 kiểu trong `CHAR_KINDS`: wife, husband, brother, sister, motherInLaw, daughterInLaw, boss, employee), bối cảnh theo `settings.scene` (home | dorm | village | office). Mỗi kiểu chỉ khác tóc/trang phục/phụ kiện trên khung người chung để animation dùng chung; bối cảnh là các nhóm `.sc-{scene}` trong hai lớp SVG nền, CSS chỉ hiện nhóm khớp `#stage[data-scene]`. Nút cài sẵn Vợ/Chồng, Anh/Em, Mẹ chồng/Nàng dâu, Sếp/Nhân viên đổi cùng lúc tên, từ khoá, nhân vật và bối cảnh.
- Hiệu ứng quà toàn màn hình (`GiftFx`, lớp `#giftfx` z-index 7, trên banner dưới thẻ kết quả), bậc theo xu của lần tặng: ≥ 10 chớp màu + mưa giấy; ≥ 100 thêm thẻ lớn giữa màn hình, mưa đĩa, rung (`#stage.shake`, cộng với `transform: var(--fit)` do `fit()` đặt); ≥ 1000 “SIÊU QUÀ!” viền vàng, lâu hơn. Thẻ lớn xếp hàng tối đa 3, đầy thì bỏ quà nhỏ nhất. Ngưỡng là mặc định Claude tự chọn.
- Chỉ một nơi phát giọng đọc: overlay `?obs=1`; bảng điều khiển chỉ phát khi bật “Phát giọng đọc ở tab này”.
- Viền và đổ bóng kiểu sticker dùng màu mực `#241B3A`; màu Vợ `#FF4F8B`, Chồng `#2F6BFF`, xà phòng `#FFD23F`.
- Chữ hiển thị dùng ngoặc kép cong “ ” và tiếng Việt có dấu; trong code giữ nháy thẳng. Chuỗi từ người dùng/settings đưa vào DOM bằng `textContent` hoặc `esc()`.

## Lưu ý

- Chưa thử với một phòng live TikTok thật. Phần đọc payload quà (`d.gift.diamondCount`, `d.gift.type`, `d.repeatCount`, `d.repeatEnd`, `d.toUser`), tim (`d.count`), người dùng (`d.user.id`, `d.user.nickname`, `d.user.displayId`) và id chủ phòng (`c.roomInfo`) viết theo kiểu dữ liệu của `tiktok-live-proto/v3` trong bản 2.5.0, nên kiểm tra lại khi chạy live lần đầu.
- Phần gọi Vbee viết theo tài liệu api-docs.vbee.vn, test tự động chỉ dùng server Vbee giả; kiểm tra lại khi chạy lần đầu với khoá thật.
- `tiktok-live-connector` là thư viện không chính thức. Nếu kết nối hỏng, cập nhật thư viện hoặc dùng TikFinity/Streamer.bot bắn vào `/event`.
- Phiên bản phụ thuộc được ghim chính xác trong `package.json`. Không thêm dependency mới khi chưa cần (Node ≥ 20 có sẵn `fetch`).
