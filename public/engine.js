/*
 * Ai rửa chén? — engine luật chơi.
 * Dùng chung cho server (Node) và trình duyệt (bản demo chạy không cần server).
 *
 * Luật:
 *  - Comment từ khoá của một bên (mặc định "vk"/"vợ", "ck"/"chồng") thêm chén cho bên đó.
 *  - Người xem được ghi nhớ bên đã chọn; quà, tim, follow, share của họ cộng chén cho bên đó.
 *  - Ai nhiều chén hơn là người đang rửa (hoà thì giữ nguyên). Vòng đầu mặc định Vợ rửa.
 *  - Hết thời gian: người đang rửa thua, vòng sau bắt đầu với người thua đứng rửa.
 * Engine không tự đọc đồng hồ hay số ngẫu nhiên: dùng opts.now() và opts.random().
 */
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  globalThis.DishGame = api;
})(function () {
  'use strict';

  const TEAMS = ['vk', 'ck'];
  const DEFAULT_PUNISHMENTS = ['Rửa bằng găng tay hình thú', 'Hát một bài', 'Đeo tạp dề cả vòng sau'];
  const DEFAULT_RESCUE = ['Kem ốc quế']; // khớp quà “Ice Cream Cone” qua GIFT_ALIAS
  const DEFAULTS = {
    roundSeconds: 180,        // độ dài mỗi vòng
    dishesPerComment: 1,      // số chén cho mỗi comment hợp lệ
    dishesPerCoin: 5,         // số chén cho mỗi xu quà: 1 Hoa hồng = 5 comment, quà luôn đáng giá hơn gõ phím
    commentCooldownMs: 1000,  // giãn cách tính comment của cùng một người
    giftWithoutTeam: 'washer',// quà của người chưa chọn bên: washer | other | ignore
    resultSeconds: 10,        // thời gian hiện bảng kết quả (đủ cho giọng đọc kết quả)
    autoNextRound: true,      // tự sang vòng mới
    startWasher: 'vk',        // người rửa ở vòng đầu
    likesPerDish: 20,         // số tim đổi 1 chén (0 = tắt)
    likeCapPerRound: 600,     // số tim tối đa được tính mỗi người mỗi vòng (0 = không giới hạn)
    dishesPerFollow: 0,       // chén cho mỗi follow (0 = tắt), mỗi người 1 lần/vòng. Mặc định tắt: thưởng điểm đổi follow dễ bị coi là trao đổi tương tác
    dishesPerShare: 0,        // chén cho mỗi share (0 = tắt), mỗi người 1 lần/vòng. Mặc định tắt, cùng lý do
    labels: { vk: 'Vợ', ck: 'Chồng' },
    keywords: { vk: ['vk', 'vợ'], ck: ['ck', 'chồng'] },
    characters: { vk: 'wife', ck: 'husband' }, // hình nhân vật mỗi bên, xem CHARACTERS
    scene: 'home',            // bối cảnh sân khấu, xem SCENES
    goldenSeconds: 30,        // giờ vàng ở cuối vòng (0 = tắt)
    goldenMult: 2,            // hệ số chén trong giờ vàng
    rescueGifts: DEFAULT_RESCUE, // tên quà cứu nguy (trừ chén): mặc định Kem ốc quế (1 xu), “mời kem để cứu”
    randomEvents: true,       // sự kiện ngẫu nhiên giữa vòng
    punishVote: true,         // bình chọn hình phạt sau mỗi vòng
    punishments: DEFAULT_PUNISHMENTS,
    voteSeconds: 15,
    goalCoins: 0,             // mục tiêu xu cả phòng (0 = tắt)
    goalText: '',
    countGuestGifts: false,   // server: tính cả quà tặng khách mời
    welcomeEnabled: true,     // server: chào người mới vào phòng
    ttsEnabled: true,         // server: giọng đọc
    ttsMinCoins: 1,           // cảm ơn mọi quà (gộp tối đa 1 câu/10 giây), không phân tầng theo tiền
    ttsVoice: '',
    hostEnabled: true,        // lời dẫn tự động (giới thiệu, hướng dẫn, mời tương tác)
    hostIntervalSec: 180,     // khoảng cách giữa hai câu dẫn (±25% ngẫu nhiên); thưa để không bị coi là xin tương tác máy móc
    hostLines: [],            // kịch bản riêng, mỗi dòng một câu; rỗng = dùng HOST_LINES
    musicEnabled: true,       // nhạc nền tự tổng hợp (Web Audio), không dùng bài có bản quyền
    musicVolume: 25,          // 0–100
    bannedWords: [],          // từ cấm thêm: tên người xem chứa từ này thì hiện / đọc là “Một bạn”
    idleSeconds: 20,          // không có tương tác thật sau chừng này giây thì coi là phòng vắng
    warmupAuto: true,         // phòng vắng lúc chưa vào vòng: máy tự chơi vòng khởi động (có nhãn, không tính điểm)
    idleAnim: true,           // phòng vắng: nhân vật tự cử động, mèo / chim đi ngang, điện thoại minh hoạ cách comment
    streamerDishes: 5,        // số chén mỗi lần streamer bấm “Streamer chọn phe”
  };

  // Khoá giá trị mặc định lồng nhau để không bị sửa nhầm qua tham chiếu.
  Object.freeze(DEFAULTS.labels); Object.freeze(DEFAULTS.characters); Object.freeze(DEFAULTS.keywords.vk); Object.freeze(DEFAULTS.keywords.ck);
  Object.freeze(DEFAULTS.keywords); Object.freeze(DEFAULT_PUNISHMENTS); Object.freeze(DEFAULT_RESCUE);

  // Danh mục quà TikTok hay gặp: tên TikTok gửi trong sự kiện (tiếng Anh), tên tiếng Việt để hiển thị / đọc, giá xu tham khảo.
  // Giá thật lấy từ sự kiện quà (diamondCount); danh mục chỉ dùng cho nút giả lập, đọc tên quà và nhận diện quà cứu nguy.
  const TIKTOK_GIFTS = [
    ['Rose', 'Hoa hồng', 1], ['TikTok', 'Tóp tóp', 1], ['GG', 'Gờ gờ', 1], ['Ice Cream Cone', 'Kem ốc quế', 1],
    ['Heart Me', 'Thả tim', 1], ['Thumbs Up', 'Like', 1], ['Cake Slice', 'Miếng bánh', 1], ['Glow Stick', 'Que phát sáng', 1],
    ['Love you so much', 'Yêu bạn nhiều', 1], ['Finger Heart', 'Tim ngón tay', 5], ['Rosa', 'Bó hồng', 10],
    ['Friendship Necklace', 'Vòng tình bạn', 10], ['Perfume', 'Nước hoa', 20], ['Doughnut', 'Bánh donut', 30],
    ['Paper Crane', 'Hạc giấy', 99], ['Little Crown', 'Vương miện nhỏ', 99], ['Cap', 'Mũ lưỡi trai', 99],
    ['Hat and Mustache', 'Mũ và ria', 99], ['Hand Hearts', 'Tim bàn tay', 100], ['Confetti', 'Pháo giấy', 100],
    ['Sunglasses', 'Kính râm', 199], ['Hearts', 'Trái tim', 199], ['Corgi', 'Chó corgi', 299],
    ['Boxing Gloves', 'Găng đấm bốc', 299], ['Money Gun', 'Súng bắn tiền', 500], ['Swan', 'Thiên nga', 699],
    ['Train', 'Tàu hoả', 899], ['Galaxy', 'Thiên hà', 1000], ['Fireworks', 'Pháo hoa', 1088],
    ['Whale diving', 'Cá voi', 2150], ['Motorcycle', 'Xe máy', 2988], ['Private Jet', 'Máy bay riêng', 4888],
    ['Sports Car', 'Xe thể thao', 7000], ['Interstellar', 'Liên sao', 10000], ['Falcon', 'Chim ưng', 10999],
    ['Rocket', 'Tên lửa', 20000], ['Castle Fantasy', 'Lâu đài', 20000], ['Lion', 'Sư tử', 29999],
    ['Leon and Lion', 'Leon và Sư tử', 34000], ['TikTok Universe', 'Vũ trụ', 44999],
  ].map(([name, vi, coins]) => ({ name, vi, coins }));
  // Kịch bản lời dẫn mặc định. Biến: {vk} {ck} tên hai bên, {kvk} {kck} từ khoá, {rescue} quà cứu nguy.
  // when: chỉ đọc khi tính năng đó đang bật. Câu nhắc quà ít, nhẹ nhàng, không hứa hẹn đổi quà lấy gì.
  const HOST_LINES = [
    { text: 'Chào mừng cả nhà đến với Ai rửa chén! Hôm nay {vk} và {ck} thi xem ai phải rửa chén nè!' },
    { text: 'Cách chơi siêu dễ: comment {kvk} để thêm chén cho {vk}, comment {kck} để thêm chén cho {ck}.' },
    { text: 'Bên nào nhiều chén hơn thì phải đứng rửa. Hết giờ mà vẫn nhiều chén hơn là thua nha!' },
    { text: 'Mới vào thì chọn phe đi nè, gõ {kvk} hoặc {kck} là được!' },
    { text: 'Thả tim cũng được tính chén cho phe mình nữa nha.', when: 'likes' },
    { text: 'Ai đang đứng về phe {vk}, điểm danh bằng một chữ {kvk} nào!' },
    { text: 'Phe {ck} đâu rồi, cho xem sức mạnh bằng chữ {kck} đi!' },
    { text: 'Quà TikTok cũng được tính thành chén cho phe bạn đã chọn. Tặng hay không là tuỳ bạn, không bắt buộc, chơi vui như nhau nha!', gift: true },
    { text: 'Ba mươi giây cuối là giờ vàng, mỗi comment và tim được tính gấp đôi nha!', when: 'golden' },
    { text: 'Thấy vui thì bấm theo dõi kênh để lần sau có game là biết liền nha!' },
    { text: 'Rủ bạn bè vào chọn phe cho đông vui nào!' },
    { text: 'Hết vòng, cả phòng bình chọn hình phạt vui cho bên thua bằng cách comment số một, hai hoặc ba nha!', when: 'vote' },
    { text: 'Giữa vòng có thể có sự kiện bất ngờ như mất nước hay bão comment, để ý màn hình nha!', when: 'events' },
    { text: 'Trong game có quà cứu nguy giúp phe mình bớt chén, còn chơi bằng comment cũng vui như nhau, không bắt buộc nha.', when: 'rescue', gift: true },
    { text: 'Thua thì đi rửa chén thôi, vui là chính, không ai mất gì đâu nha!' },
    { text: 'Cảm ơn mọi người đã comment và thả tim, mỗi lượt tương tác đều được tính hết!' },
  ];
  const GIFT_WORDS = /quà|tặng|\bxu\b|donate|ủng hộ|bông hồng|\brose\b|kim cương/i;
  // Câu báo giọng AI: đọc khi bắt đầu dẫn và khoảng 30 phút một lần (luật VN về nội dung AI, TikTok khuyến khích minh bạch).
  const HOST_AI_LINE = 'Mình là giọng đọc AI của trò chơi, giúp đọc luật và cảm ơn mọi người. Còn trò chuyện thì có streamer ngay đây nha!';
  // Câu theo diễn biến ván: chen giữa các câu cố định (mỗi câu thứ ba).
  // n: số lần đã gọi, để xoay vòng các câu chờ. Câu phòng vắng nói thật: chưa có ai, mời người đầu tiên.
  function hostStateLine(S, st, n) {
    const L = S.labels, K = S.keywords;
    n = n || 0;
    if (st.phase === 'ready') {
      const waiting = [
        st.players ? `Vòng mới chờ người mở màn, comment ${K.vk[0]} hoặc ${K.ck[0]} nha!` : `Chưa ai chọn phe, bạn là người đầu tiên đó! Comment ${K.vk[0]} hoặc ${K.ck[0]} nha!`,
        `Comment đầu tiên sẽ mở vòng chơi, gõ ${K.vk[0]} cho ${L.vk} hay ${K.ck[0]} cho ${L.ck} đều được!`,
        `Comment ${K.vk[0]} hoặc ${K.ck[0]} để bắt đầu vòng chơi nha!`,
      ];
      if (st.warmup) waiting.unshift(`Máy đang tự chơi khởi động thôi, comment ${K.vk[0]} hoặc ${K.ck[0]} là vào chơi thật liền!`);
      return waiting[n % waiting.length];
    }
    if (st.phase !== 'running') return null;
    if (st.idleMs >= 60000 && st.remainingMs > 40000) {
      return n % 2 ? `Phòng đang yên quá, comment ${K.vk[0]} hay ${K.ck[0]} cho vui nào!`
        : `Ai mới vào thì chọn phe đi nè, gõ ${K.vk[0]} cho ${L.vk} hoặc ${K.ck[0]} cho ${L.ck}!`;
    }
    const d = st.piles.vk - st.piles.ck;
    const left = Math.ceil(st.remainingMs / 1000);
    if (left <= 40) return null; // cuối vòng đã có giờ vàng, banner, tiếng hiệu ứng: không nói chen
    if (d === 0) return `Hai bên đang hoà, comment ${K.vk[0]} hay ${K.ck[0]} để phân thắng bại nào!`;
    const lead = d > 0 ? 'vk' : 'ck', other = d > 0 ? 'ck' : 'vk';
    if (left <= 90) return `${L[lead]} đang phải rửa, còn ${left} giây, xem có đổi người không nha!`;
    return `${L[lead]} đang nhiều hơn ${L[other]} ${Math.abs(d)} chén nên đang phải rửa đó!`;
  }
  // Lời dẫn lúc máy chơi (vòng khởi động): vừa bình luận vừa hướng dẫn cách chơi, chỉ mời comment / tim, không nhắc quà.
  // kind: 'start' (máy bắt đầu), 'swap' (máy làm đổi người, team = người vào rửa), 'tick' (xoay vòng theo n).
  function warmupLine(S, st, kind, n, team) {
    const L = S.labels, K = S.keywords;
    const per = S.dishesPerComment > 1 ? `${S.dishesPerComment} chén` : 'một chén';
    if (kind === 'start') {
      return `Máy chơi thử cho mọi người xem cách chơi nè! Comment ${K.vk[0]} là ${L.vk} thêm ${per}, comment ${K.ck[0]} là ${L.ck} thêm ${per}.`;
    }
    if (kind === 'swap' && TEAMS.includes(team)) {
      return `Thấy chưa, ${L[team]} nhiều chén hơn nên phải vào rửa rồi đó! Bên nào nhiều chén hơn là bên đó rửa.`;
    }
    const lines = [
      `Mỗi chữ ${K.vk[0]} là ${per} cho ${L.vk}, mỗi chữ ${K.ck[0]} là ${per} cho ${L.ck}. Đơn giản vậy thôi!`,
      `Hiện ${L.vk} ${st.piles.vk} chén, ${L.ck} ${st.piles.ck} chén. Đây là máy chơi thôi, có người comment là tính thật liền!`,
      `Muốn ${L.vk} thoát rửa chén thì comment ${K.ck[0]} dồn chén cho ${L.ck}, muốn ${L.ck} thoát thì comment ${K.vk[0]} nha!`,
      'Chỉ cần một comment thật là vòng chơi thật bắt đầu, chén của máy sẽ xoá về không.',
      `Hết giờ, bên nào còn nhiều chén hơn thì phải rửa. Comment ${K.vk[0]} hay ${K.ck[0]} để vào chơi nào!`,
    ];
    if (S.likesPerDish > 0) lines.push('Thả tim cũng được tính chén cho phe bạn đã chọn nha.');
    return lines[((n || 0) % lines.length + lines.length) % lines.length];
  }

  // Câu dẫn cố định thứ idx (vòng lại khi hết danh sách), đã điền biến; null nếu danh sách rỗng.
  // Nơi gọi tự xen câu hostStateLine (ví dụ mỗi câu thứ ba). opts.noGift: bỏ qua câu nhắc quà (đã nhắc gần đây).
  function hostLine(S, idx, opts) {
    const on = {
      likes: S.likesPerDish > 0, golden: S.goldenSeconds > 0 && S.goldenMult > 1, rescue: S.rescueGifts.length > 0,
      follow: S.dishesPerFollow > 0, share: S.dishesPerShare > 0, vote: S.punishVote, events: S.randomEvents,
    };
    let list = S.hostLines.length
      ? S.hostLines.map((text) => {
        const gift = GIFT_WORDS.test(text);
        // Câu tự viết có nhắc quà mà chưa nói “không bắt buộc” thì tự nối thêm
        return { text: gift && !/không bắt buộc/i.test(text) ? `${text.replace(/[.!?…\s]+$/u, '')}, không bắt buộc nha.` : text, gift };
      })
      : HOST_LINES.filter((l) => !l.when || on[l.when]);
    if (opts && opts.noGift) list = list.filter((l) => !l.gift);
    if (!list.length) return null;
    const giftVi = (g) => { const k = giftKey(g); const x = TIKTOK_GIFTS.find((y) => rawGiftKey(y.name) === k); return x ? x.vi : g; };
    const vars = {
      vk: S.labels.vk, ck: S.labels.ck, kvk: S.keywords.vk[0], kck: S.keywords.ck[0],
      rescue: S.rescueGifts.length ? giftVi(S.rescueGifts[0]) : 'quà cứu nguy',
    };
    const tpl = list[((idx % list.length) + list.length) % list.length].text;
    return tpl.replace(/\{(vk|ck|kvk|kck|rescue)\}/g, (_, k) => vars[k]);
  }

  // Các kiểu nhân vật overlay vẽ được (charSVG trong index.html).
  const CHARACTERS = ['wife', 'husband', 'brother', 'sister', 'motherInLaw', 'daughterInLaw', 'boss', 'employee'];
  // Bối cảnh: bếp gia đình | phòng trọ | bếp quê | pantry văn phòng.
  const SCENES = ['home', 'dorm', 'village', 'office'];

  const MAX_COINS = 1e7;                      // trần xu cho một lần tặng, chặn số bậy từ /event
  const MAX_PILE = Number.MAX_SAFE_INTEGER;
  const MAX_USERS = 50000;                    // trần số người ghi nhớ trong mỗi Map
  const HISTORY_LEN = 10;
  const EVENT_LABELS = { drought: 'Mất nước!', storm: 'Bão comment!', slip: 'Trượt tay!', swapPiles: 'Đổi chồng chén!' };
  const EVENT_KINDS = Object.keys(EVENT_LABELS);

  const other = (t) => (t === 'vk' ? 'ck' : 'vk');
  // Dữ liệu vào có thể đến từ /event hay WebSocket: chỉ nhận chuỗi hoặc số, còn lại coi như rỗng.
  const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  const clamp = (v, lo, hi, d) => {
    const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const bool = (v, d) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1' ? true
    : v === false || v === 'false' || v === 'off' || v === 0 || v === '0' ? false : d);
  // Danh sách từ mảng hoặc chuỗi phân tách bằng dấu phẩy / xuống dòng.
  const list = (v, sep) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(sep) : []);

  // Bỏ dấu tiếng Việt (kể cả đ) để so khớp không dấu.
  function stripDiacritics(s) {
    return str(s).normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFC');
  }
  // Chuẩn hoá chuỗi người gõ: chữ kiểu toán học về chữ thường, bỏ zero-width.
  const normInput = (s) => str(s).normalize('NFKC').normalize('NFC').replace(/\p{Cf}+/gu, '');
  // ---------- Từ cấm có sẵn (tên người xem hiện trên màn hình và được đọc) ----------
  // Từ ngắn hoặc dễ trùng nghĩa: chỉ khớp nguyên từ, giữ dấu (để “Các bạn”, “Lồng đèn” không bị chặn nhầm).
  const BANNED_WORDS = new Set([
    // tục, chửi (kể cả viết tắt / lách chữ)
    'địt', 'đjt', 'djt', 'đụ', 'đéo', 'lồn', 'loz', 'buồi', 'cặc', 'cak', 'đĩ', 'đỉ', 'điếm', 'cave',
    'đm', 'đmm', 'dm', 'dmm', 'đcm', 'dcm', 'đkm', 'dkm', 'vcl', 'vkl', 'vcc', 'vl', 'clm', 'cmm', 'cc', 'cl',
    'chịch', 'nứng', 'dâm', 'sex', 'xxx', 'porn', 'jav',
    // tiếng Anh
    'fuck', 'fck', 'fuk', 'shit', 'bitch', 'dick', 'pussy', 'cunt', 'nigga', 'nigger', 'faggot', 'slut', 'whore',
    // cờ bạc, lừa đảo, kéo sang kênh khác
    'casino', 'kubet', 'fb88', 'w88', '188bet', '789bet', '8xbet', 'jun88', 'sv388', 'hi88', 'f8bet', 'shbet', 'nhacai',
    'zalo', 'telegram', 'tele',
  ]);
  // Cụm từ: khớp trọn từ (sau khi gộp khoảng trắng / dấu chấm / gạch), để “con ngu” không chặn “Con Nguyên”.
  const BANNED_PHRASES = [
    'địt mẹ', 'đụ má', 'đụ mẹ', 'mẹ mày', 'má mày', 'bố mày', 'cha mày', 'con đĩ', 'thằng chó', 'con chó', 'óc chó', 'chó đẻ',
    'súc vật', 'óc lợn', 'đồ ngu', 'thằng ngu', 'con ngu',
    'nhà cái', 'cá độ', 'cá cược', 'tài xỉu', 'lô đề', 'xóc đĩa', 'nổ hũ', 'nạp thẻ', 'kiếm tiền online', 'việc nhẹ lương cao',
    'cho vay', 'vay tiền', 'gái gọi', 'gái xinh', 'chat sex', 'ma túy', 'ma tuý', 'cỏ mỹ', 'bay lắc', '18+',
  ];
  // true nếu tên chứa từ cấm có sẵn hoặc từ cấm streamer thêm (extra).
  function isBannedName(name, extra) {
    const s = normInput(name).toLowerCase();
    if (!s) return false;
    const raw = s.replace(/[\s._\-*~|]+/g, ' ');
    const parts = raw.split(/[^\p{L}\p{M}\p{N}+]+/u).filter(Boolean);
    // Ghép các chữ cái lẻ liền nhau (“đ.ị.t”, “v c l”) thành một từ để bắt kiểu lách
    const tokens = [];
    for (let i = 0; i < parts.length; i++) {
      if (Array.from(parts[i]).length === 1) {
        let w = parts[i];
        while (i + 1 < parts.length && Array.from(parts[i + 1]).length === 1) w += parts[++i];
        tokens.push(w);
      } else tokens.push(parts[i]);
    }
    if (tokens.some((t) => BANNED_WORDS.has(t) || BANNED_WORDS.has(t.replace(/\+/g, '')))) return true;
    const joined = ` ${tokens.join(' ')} `;
    if (BANNED_PHRASES.some((p) => joined.includes(` ${p} `))) return true;
    if (Array.isArray(extra) && extra.some((w) => w && (tokens.includes(w) || raw.includes(w)))) return true;
    return false;
  }
  // Khoá so sánh tên quà: không phân biệt hoa thường, bỏ dấu.
  const rawGiftKey = (s) => stripDiacritics(normInput(s)).toLowerCase().replace(/\s+/g, ' ').trim();
  // Tên tiếng Việt và tên TikTok của cùng một quà cho ra cùng một khoá (cài “Kem ốc quế” vẫn khớp quà “Ice Cream Cone”).
  const GIFT_ALIAS = new Map();
  TIKTOK_GIFTS.forEach((g) => { GIFT_ALIAS.set(rawGiftKey(g.vi), rawGiftKey(g.name)); });
  GIFT_ALIAS.set('donut', 'doughnut'); // TikTok gửi “Doughnut”, công cụ ngoài hay gõ “Donut”
  const giftKey = (s) => { const k = rawGiftKey(s); return GIFT_ALIAS.get(k) || k; };
  // Tên tiếng Việt của quà nếu có trong danh mục, không thì giữ nguyên.
  const giftVi = (s) => { const k = giftKey(s); const g = TIKTOK_GIFTS.find((x) => rawGiftKey(x.name) === k); return g ? g.vi : s; };

  // Làm sạch chữ hiển thị: bỏ chữ kiểu toán học, Zalgo, ký tự điều khiển; cắt độ dài.
  function cleanText(v, max, fallback) {
    let s = str(v).normalize('NFKC').normalize('NFC');
    s = s.replace(/\p{M}+/gu, '').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length === 0) return fallback;
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
  }
  const cleanName = (name) => cleanText(name, 18, 'Ẩn danh');

  function cleanKeywords(v, def) {
    const out = [];
    for (const w of list(v, /[,\s]+/)) {
      const k = normInput(w).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (k && Array.from(k).length <= 12 && !out.includes(k)) out.push(k);
      if (out.length >= 5) break;
    }
    return out.length ? out : def.slice();
  }

  function sanitizeSettings(input) {
    const s = Object.assign({}, DEFAULTS, input || {});
    const lb = s.labels && typeof s.labels === 'object' ? s.labels : {};
    const kw = s.keywords && typeof s.keywords === 'object' ? s.keywords : {};
    const ch = s.characters && typeof s.characters === 'object' ? s.characters : {};
    const keywords = { vk: cleanKeywords(kw.vk, DEFAULTS.keywords.vk), ck: cleanKeywords(kw.ck, DEFAULTS.keywords.ck) };
    // Một từ không được thuộc cả hai bên: bỏ khỏi bên Chồng; hết từ thì quay về mặc định.
    keywords.ck = keywords.ck.filter((k) => !keywords.vk.includes(k));
    if (!keywords.ck.length) keywords.ck = DEFAULTS.keywords.ck.filter((k) => !keywords.vk.includes(k));
    if (!keywords.ck.length) { keywords.vk = DEFAULTS.keywords.vk.slice(); keywords.ck = DEFAULTS.keywords.ck.slice(); }
    const punishments = list(s.punishments, /\n/).map((p) => cleanText(p, 40, '')).filter(Boolean).slice(0, 3);
    const roundSeconds = Math.round(clamp(s.roundSeconds, 15, 3600, DEFAULTS.roundSeconds));
    return {
      roundSeconds,
      dishesPerComment: Math.round(clamp(s.dishesPerComment, 0, 1000, DEFAULTS.dishesPerComment)),
      dishesPerCoin: clamp(s.dishesPerCoin, 0, 1000, DEFAULTS.dishesPerCoin),
      commentCooldownMs: Math.round(clamp(s.commentCooldownMs, 0, 60000, DEFAULTS.commentCooldownMs)),
      giftWithoutTeam: ['washer', 'other', 'ignore'].includes(s.giftWithoutTeam) ? s.giftWithoutTeam : DEFAULTS.giftWithoutTeam,
      resultSeconds: Math.round(clamp(s.resultSeconds, 2, 60, DEFAULTS.resultSeconds)),
      autoNextRound: s.autoNextRound !== false && s.autoNextRound !== 'false',
      startWasher: TEAMS.includes(s.startWasher) ? s.startWasher : DEFAULTS.startWasher,
      likesPerDish: Math.round(clamp(s.likesPerDish, 0, 100000, DEFAULTS.likesPerDish)),
      likeCapPerRound: Math.round(clamp(s.likeCapPerRound, 0, 1e7, DEFAULTS.likeCapPerRound)),
      dishesPerFollow: Math.round(clamp(s.dishesPerFollow, 0, 1000, DEFAULTS.dishesPerFollow)),
      dishesPerShare: Math.round(clamp(s.dishesPerShare, 0, 1000, DEFAULTS.dishesPerShare)),
      labels: { vk: cleanText(lb.vk, 12, DEFAULTS.labels.vk), ck: cleanText(lb.ck, 12, DEFAULTS.labels.ck) },
      keywords,
      characters: {
        vk: CHARACTERS.includes(ch.vk) ? ch.vk : DEFAULTS.characters.vk,
        ck: CHARACTERS.includes(ch.ck) ? ch.ck : DEFAULTS.characters.ck,
      },
      scene: SCENES.includes(s.scene) ? s.scene : DEFAULTS.scene,
      // Giờ vàng tối đa nửa vòng (vòng ngắn không vàng từ đầu); kẹp ngay đây để panel hiện đúng số đang dùng.
      goldenSeconds: Math.min(Math.floor(roundSeconds / 2), Math.round(clamp(s.goldenSeconds, 0, 600, DEFAULTS.goldenSeconds))),
      goldenMult: Math.round(clamp(s.goldenMult, 1, 5, DEFAULTS.goldenMult)),
      rescueGifts: list(s.rescueGifts, /[,\n]/).map((g) => cleanText(g, 30, '')).filter(Boolean)
        .filter((g, i, a) => a.findIndex((x) => giftKey(x) === giftKey(g)) === i).slice(0, 10),
      randomEvents: bool(s.randomEvents, DEFAULTS.randomEvents),
      punishVote: bool(s.punishVote, DEFAULTS.punishVote),
      punishments: punishments.length ? punishments : DEFAULT_PUNISHMENTS.slice(),
      voteSeconds: Math.round(clamp(s.voteSeconds, 5, 120, DEFAULTS.voteSeconds)),
      goalCoins: Math.round(clamp(s.goalCoins, 0, 1e9, DEFAULTS.goalCoins)),
      goalText: cleanText(s.goalText, 60, ''),
      countGuestGifts: bool(s.countGuestGifts, DEFAULTS.countGuestGifts),
      welcomeEnabled: bool(s.welcomeEnabled, DEFAULTS.welcomeEnabled),
      ttsEnabled: bool(s.ttsEnabled, DEFAULTS.ttsEnabled),
      ttsMinCoins: Math.round(clamp(s.ttsMinCoins, 0, 1e6, DEFAULTS.ttsMinCoins)),
      ttsVoice: str(s.ttsVoice).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64),
      hostEnabled: bool(s.hostEnabled, DEFAULTS.hostEnabled),
      hostIntervalSec: Math.round(clamp(s.hostIntervalSec, 30, 1800, DEFAULTS.hostIntervalSec)),
      hostLines: list(s.hostLines, /\n/).map((l) => cleanText(l, 200, '')).filter(Boolean).slice(0, 40),
      musicEnabled: bool(s.musicEnabled, DEFAULTS.musicEnabled),
      musicVolume: Math.round(clamp(s.musicVolume, 0, 100, DEFAULTS.musicVolume)),
      bannedWords: list(s.bannedWords, /[,\n]/).map((w) => cleanText(w, 30, '').toLowerCase()).filter(Boolean).slice(0, 200),
      idleSeconds: Math.round(clamp(s.idleSeconds, 10, 300, DEFAULTS.idleSeconds)),
      warmupAuto: bool(s.warmupAuto, DEFAULTS.warmupAuto),
      idleAnim: bool(s.idleAnim, DEFAULTS.idleAnim),
      streamerDishes: Math.round(clamp(s.streamerDishes, 1, 1000, DEFAULTS.streamerDishes)),
    };
  }
  const copySettings = (S) => Object.assign({}, S, {
    labels: Object.assign({}, S.labels),
    characters: Object.assign({}, S.characters),
    keywords: { vk: S.keywords.vk.slice(), ck: S.keywords.ck.slice() },
    rescueGifts: S.rescueGifts.slice(),
    punishments: S.punishments.slice(),
    hostLines: S.hostLines.slice(),
    bannedWords: S.bannedWords.slice(),
  });

  // Bộ so khớp từ khoá, cache theo object keywords.
  const matcherCache = new WeakMap();
  function buildMatcher(keywords) {
    const m = { vk: { exact: new Set(), loose: new Set(), re: null }, ck: { exact: new Set(), loose: new Set(), re: null } };
    for (const t of TEAMS) {
      for (const k of list(keywords && keywords[t], /[,\s]+/)) {
        const w = normInput(k).toLowerCase();
        if (!w) continue;
        m[t].exact.add(w);
        const plain = stripDiacritics(w);
        if (plain !== w) m[t].loose.add(plain); // bản bỏ dấu chỉ tính khi comment chỉ có đúng từ đó
        if (w === 'vk' || w === 'ck') m[t].re = new RegExp('^(?:' + w + ')+k*$'); // giữ luật "vkkk", "ckck"
      }
    }
    return m;
  }
  function matcherFor(keywords) {
    if (!keywords || typeof keywords !== 'object') keywords = DEFAULTS.keywords;
    let m = matcherCache.get(keywords);
    if (!m) { m = buildMatcher(keywords); matcherCache.set(keywords, m); }
    return m;
  }

  // Nhận diện bên được chọn trong comment. Chỉ khớp nguyên từ để "vô", "chống"... không bị tính nhầm.
  // Comment nhắc cả hai bên thì không tính.
  function detectTeam(text, keywords) {
    text = normInput(text);
    if (!text) return null;
    const m = matcherFor(keywords);
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const found = new Set();
    for (const tok of tokens) {
      for (const t of TEAMS) if (m[t].exact.has(tok) || (m[t].re && m[t].re.test(tok))) found.add(t);
    }
    if (tokens.length === 1 && !found.size) {
      for (const t of TEAMS) if (m[t].loose.has(tokens[0])) found.add(t);
    }
    return found.size === 1 ? found.values().next().value : null;
  }

  function normUser(u) {
    u = u && typeof u === 'object' ? u : {};
    const name = cleanName(str(u.name) || str(u.nickname) || str(u.id) || 'Ẩn danh');
    // Cắt id (id TikTok chỉ ~19 chữ số) để id dài bất thường không làm phình các Map.
    const id = (str(u.id) || str(u.name) || name).slice(0, 64);
    return { id, name };
  }

  // Bảng xếp hạng người góp: Map đầy đủ + top k cập nhật dần (số chén chỉ tăng nên top luôn đúng).
  function makeBoard(k) { return { k, map: new Map(), top: [] }; }
  function bump(b, id, name, dishes, coins) {
    let e = b.map.get(id);
    if (!e) {
      if (b.map.size >= MAX_USERS) return;
      e = { id, name, dishes: 0, coins: 0 };
      b.map.set(id, e);
    }
    e.name = name;
    e.dishes = Math.min(MAX_PILE, e.dishes + Math.max(0, dishes));
    e.coins = Math.min(MAX_PILE, e.coins + Math.max(0, coins));
    if (!(e.dishes > 0)) return;
    if (!b.top.includes(e)) {
      if (b.top.length >= b.k && e.dishes <= b.top[b.top.length - 1].dishes) return;
      b.top.push(e);
    }
    b.top.sort((x, y) => y.dishes - x.dishes);
    if (b.top.length > b.k) b.top.length = b.k;
  }
  function rebuildTop(b) {
    b.top = Array.from(b.map.values()).filter((e) => e.dishes > 0).sort((x, y) => y.dishes - x.dishes).slice(0, b.k);
  }
  const topList = (b, withCoins) => b.top.map((e) => (withCoins ? { name: e.name, dishes: e.dishes, coins: e.coins } : { name: e.name, dishes: e.dishes }));

  function createEngine(opts) {
    opts = opts || {};
    const now = opts.now || (() => Date.now());
    const random = opts.random || Math.random;
    const onEffect = opts.onEffect || (() => {});
    const onChange = opts.onChange || (() => {});
    const maxTeams = opts.maxTeams || MAX_USERS;

    let S = sanitizeSettings(opts.settings);
    const teamOf = new Map();       // userId -> 'vk' | 'ck' (thứ tự chèn = cũ → mới)
    const lastComment = new Map();  // userId -> thời điểm comment được tính gần nhất
    let lastCleanAt = now();

    let round, phase, washer, piles, contrib, endsAt, pausedRemaining, pausedAt, resultEndsAt, lastResult;
    let pending, pendingContrib, pendingCount, score, history, session, totalCoins, goalReached;
    let coinRem, likesRound, followRound, shareRound, goldenFired, activeEvent, nextEventAt, vote, restored;
    // Phòng vắng: lần tương tác thật gần nhất; vòng khởi động do máy tự chơi (chỉ ở pha ready, không tính điểm).
    let lastActivityAt, warmup, botNextAt;

    function resetAll() {
      round = 1;
      phase = 'ready'; // ready | running | paused | result | ended
      washer = S.startWasher;
      piles = { vk: 0, ck: 0 };
      contrib = { vk: makeBoard(3), ck: makeBoard(3) };
      endsAt = 0;
      pausedRemaining = S.roundSeconds * 1000;
      pausedAt = 0;
      resultEndsAt = 0;
      lastResult = null;
      clearPending();
      score = { vk: 0, ck: 0 };
      history = [];
      session = { vk: makeBoard(5), ck: makeBoard(5) };
      totalCoins = 0;
      goalReached = false;
      coinRem = new Map();
      resetRoundTrackers();
      goldenFired = false;
      activeEvent = null;
      nextEventAt = 0;
      vote = null;
      restored = null;
      lastActivityAt = now();
      warmup = false;
      botNextAt = 0;
    }
    function clearPending() {
      pending = { vk: 0, ck: 0 };
      pendingContrib = { vk: new Map(), ck: new Map() };
      pendingCount = { vk: 0, ck: 0 };
    }
    function resetRoundTrackers() {
      likesRound = new Map();
      followRound = new Set();
      shareRound = new Set();
    }
    resetAll();

    const emit = (fx) => { try { onEffect(fx); } catch (e) { /* bỏ qua lỗi hiển thị */ } };
    const changed = () => { try { onChange(); } catch (e) { /* bỏ qua */ } };

    // Ghi nhớ bên; cập nhật thì xoá rồi chèn lại để mục mới nhất nằm cuối, quá trần thì xoá mục cũ nhất.
    function setTeam(id, team) {
      teamOf.delete(id);
      teamOf.set(id, team);
      if (teamOf.size > maxTeams) teamOf.delete(teamOf.keys().next().value);
    }

    // goldenSeconds đã được kẹp tối đa nửa vòng trong sanitizeSettings.
    const goldenWindow = () => S.goldenSeconds * 1000;
    function isGolden(t) {
      if (S.goldenSeconds <= 0) return false;
      if (phase === 'running') return endsAt - t <= goldenWindow();
      if (phase === 'paused') return pausedRemaining <= goldenWindow();
      return false;
    }
    function maybeGolden(t) {
      if (phase !== 'running' || goldenFired || !isGolden(t)) return;
      goldenFired = true;
      emit({ type: 'golden', mult: S.goldenMult, seconds: S.goldenSeconds });
      changed();
    }

    function startRound(isNext) {
      const t = now();
      if (warmup) { warmup = false; emit({ type: 'warmup', on: false }); } // có người chơi thật: bỏ chén của máy
      if (isNext) round += 1;
      phase = 'running';
      piles = { vk: 0, ck: 0 };
      contrib = { vk: makeBoard(3), ck: makeBoard(3) };
      washer = lastResult ? lastResult.loser : S.startWasher;
      endsAt = t + S.roundSeconds * 1000;
      goldenFired = false;
      activeEvent = null;
      nextEventAt = S.randomEvents ? t + eventDelay() : 0;
      vote = null;
      restored = null;
      emit({ type: 'round', round, washer });
      flushPending();
      maybeGolden(t);
      changed();
    }

    function endRound(reason) {
      const t = now();
      // Kết thúc lúc đang dừng: hàng chờ thuộc vòng này, cộng vào trước khi chốt (không để dồn sang vòng sau).
      if (phase === 'paused') {
        phase = 'running';
        flushPending(1);
      }
      const loser = washer;
      const winner = other(loser);
      score[winner] += 1;
      lastResult = {
        round,
        loser,
        winner,
        dishes: piles[loser],
        piles: { vk: piles.vk, ck: piles.ck },
        top: topList(contrib[loser]),
        reason: reason === 'manual' ? 'manual' : 'timeout',
        punishment: null,
      };
      history.push({ round, loser, piles: { vk: piles.vk, ck: piles.ck }, reason: lastResult.reason });
      if (history.length > HISTORY_LEN) history.shift();
      phase = 'result';
      activeEvent = null;
      nextEventAt = 0;
      resetRoundTrackers(); // tim/follow/share lúc chờ tính cho vòng sau
      let extra = 0;
      if (S.punishVote && S.punishments.length) {
        vote = { options: S.punishments.slice(), counts: S.punishments.map(() => 0), voters: new Map(), endsAt: t + S.voteSeconds * 1000, winner: null, open: true };
        extra = S.voteSeconds * 1000;
      } else vote = null;
      resultEndsAt = t + extra + S.resultSeconds * 1000;
      emit(Object.assign({ type: 'result', score: { vk: score.vk, ck: score.ck } }, lastResult));
      if (vote) emit({ type: 'vote', stage: 'open', options: vote.options.slice(), durationMs: extra });
      changed();
    }

    function closeVote() {
      const max = Math.max.apply(null, vote.counts);
      const cands = vote.counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
      vote.winner = cands[Math.min(cands.length - 1, Math.floor(random() * cands.length))];
      vote.open = false;
      const text = vote.options[vote.winner];
      if (lastResult) lastResult.punishment = text;
      if (history.length) history[history.length - 1].punishment = text;
      emit({ type: 'vote', stage: 'closed', options: vote.options.slice(), counts: vote.counts.slice(), winner: vote.winner, text });
      changed();
    }

    // Ai nhiều chén hơn thì rửa; xét được cả khi bên đang rửa bị trừ chén (quà cứu nguy).
    function checkWasher() {
      const o = other(washer);
      if (piles[o] > piles[washer]) {
        washer = o;
        emit({ type: 'swap', washer });
      }
    }

    // Cộng (n > 0) hoặc trừ (n < 0) chồng chén, sàn 0. Trả số thực sự thay đổi.
    function applyPile(team, n) {
      const before = piles[team];
      piles[team] = Math.max(0, Math.min(MAX_PILE, before + n));
      return piles[team] - before;
    }

    function credit(team, n, user, meta) {
      if (phase === 'ended') return;
      if (phase === 'ready') startRound(false);
      if (phase === 'result' || phase === 'paused') {
        // Gộp theo bên, cộng một lần khi vòng mới mở / khi tiếp tục.
        pending[team] = Math.max(-MAX_PILE, Math.min(MAX_PILE, pending[team] + n));
        pendingCount[team] += 1;
        const pc = pendingContrib[team];
        const e = pc.get(user.id) || (pc.size < MAX_USERS ? { name: user.name, dishes: 0, coins: 0 } : null);
        if (e) {
          e.name = user.name;
          e.dishes = Math.min(MAX_PILE, e.dishes + Math.max(0, n));
          e.coins = Math.min(MAX_PILE, e.coins + (meta.coins || 0));
          pc.set(user.id, e);
        }
        // Quà lúc chờ vẫn báo ngay (toast + lời cảm ơn); chén thì cộng sau. queued:true = chưa vào chồng.
        if (meta.source === 'gift' || meta.source === 'rescue' || meta.source === 'streamer') {
          emit({
            type: 'add', team, n, user: { name: user.name }, queued: true,
            source: meta.source, giftName: meta.giftName || null, count: meta.count || 1, coins: meta.coins || 0, mult: 1,
          });
        }
        changed();
        return;
      }
      const t = now();
      maybeGolden(t);
      // Giờ vàng chỉ nhân comment và tim, không nhân quà (tránh thành “khuyến mãi quà có hạn giờ”, dễ bị coi là thúc giục tặng)
      const mult = isGolden(t) && (meta.source === 'comment' || meta.source === 'like') ? S.goldenMult : 1;
      const d = applyPile(team, n * mult);
      const gained = Math.max(0, n * mult);
      bump(contrib[team], user.id, user.name, gained, meta.coins || 0);
      bump(session[team], user.id, user.name, gained, meta.coins || 0);
      if (d !== 0) {
        emit({
          type: 'add', team, n: d, user: { name: user.name },
          source: meta.source, giftName: meta.giftName || null, count: meta.count || 1, coins: meta.coins || 0,
          mult,
        });
      }
      checkWasher();
      changed();
    }

    // Lần tặng chưa đủ 1 chén (dishesPerCoin < 1): vẫn ghi xu cho người tặng (bảng ủng hộ, CSV).
    function creditCoins(team, user, coins) {
      if (phase === 'result' || phase === 'paused') {
        const pc = pendingContrib[team];
        const e = pc.get(user.id) || (pc.size < MAX_USERS ? { name: user.name, dishes: 0, coins: 0 } : null);
        if (e) { e.name = user.name; e.coins = Math.min(MAX_PILE, e.coins + coins); pc.set(user.id, e); }
        return;
      }
      if (phase === 'running') bump(contrib[team], user.id, user.name, 0, coins);
      bump(session[team], user.id, user.name, 0, coins);
    }

    function flushPending(forceMult) {
      const t = now();
      const mult = forceMult || 1; // hàng chờ có cả quà: không nhân giờ vàng
      for (const team of TEAMS) {
        const n = pending[team];
        const pc = pendingContrib[team];
        let coins = 0;
        for (const [id, e] of pc) {
          bump(contrib[team], id, e.name, e.dishes * mult, e.coins);
          bump(session[team], id, e.name, e.dishes * mult, e.coins);
          coins += e.coins;
        }
        const d = n ? applyPile(team, n * mult) : 0;
        if (d !== 0) {
          const names = Array.from(pc.entries()).filter(([id]) => id !== '__streamer').map(([, e]) => e); // Streamer không tính là người xem
          const who = names.length === 1 ? names[0].name : names.length > 1 ? `${names.length} người xem` : 'Người xem';
          emit({
            type: 'add', team, n: d, user: { name: who },
            source: 'queued', giftName: null, count: Math.max(1, pendingCount[team]), coins: Math.min(MAX_PILE, coins), people: names.length, mult,
          });
        }
      }
      clearPending();
      checkWasher();
    }

    // Đổi xu thành chén. dishesPerCoin < 1 thì cộng dồn phần lẻ theo từng người.
    function dishesFromCoins(id, coins) {
      const raw = coins * S.dishesPerCoin;
      if (S.dishesPerCoin >= 1) return Math.min(MAX_PILE, Math.max(1, Math.round(raw)));
      const r = (coinRem.get(id) || 0) + raw;
      const n = Math.floor(r + 1e-9);
      coinRem.delete(id);
      coinRem.set(id, Math.max(0, r - n));
      if (coinRem.size > MAX_USERS) coinRem.delete(coinRem.keys().next().value);
      return n;
    }

    function addCoins(coins) {
      totalCoins = Math.min(MAX_PILE, totalCoins + coins);
      if (!goalReached && S.goalCoins > 0 && totalCoins >= S.goalCoins) {
        goalReached = true;
        emit({ type: 'goal', coins: S.goalCoins, text: S.goalText, totalCoins });
      }
    }

    // ---------- Sự kiện ngẫu nhiên ----------
    const eventDelay = () => Math.round((60 + random() * 40) * 1000);
    function fireEvent(kind) {
      const t = now();
      const fx = { type: 'event', kind, label: EVENT_LABELS[kind] };
      let dur = 4000; // sự kiện tức thời vẫn hiện banner vài giây
      if (kind === 'drought') dur = 10000;
      else if (kind === 'storm') dur = 15000;
      else if (kind === 'slip') {
        const n = Math.max(5, Math.round(piles[washer] * 0.1));
        fx.team = washer;
        fx.n = applyPile(washer, n);
      } else if (kind === 'swapPiles') {
        piles = { vk: piles.ck, ck: piles.vk };
        checkWasher();
      }
      activeEvent = { kind, label: EVENT_LABELS[kind], endsAt: t + dur };
      fx.durationMs = dur;
      nextEventAt = S.randomEvents ? t + dur + eventDelay() : 0;
      emit(fx);
      changed();
    }

    // Sự kiện từ TikTok (hoặc giả lập):
    // { type:'chat', user, text } | { type:'gift', user, coins, count, giftName, team? }
    // { type:'like', user, count } | { type:'follow', user } | { type:'share', user }
    // Mọi sự kiện thật được tính (comment chọn phe, quà, tim…) làm mới đồng hồ phòng vắng.
    // Có người xem chat / thả tim / tặng (kể cả comment không có từ khoá) là phòng không còn vắng.
    function handle(ev) {
      const ok = handleEvent(ev);
      if (ok || (ev && typeof ev === 'object' && ['chat', 'gift', 'like', 'follow', 'share'].includes(ev.type))) lastActivityAt = now();
      return ok;
    }

    function handleEvent(ev) {
      if (!ev || typeof ev !== 'object') return false;
      const user = normUser(ev.user);
      if (isBannedName(user.name, S.bannedWords)) user.name = 'Một bạn';
      const t = now();

      if (ev.type === 'chat') {
        // Đang bình chọn hình phạt: comment "1"/"2"/"3" là phiếu, không tính chén.
        if (vote && vote.open && phase === 'result') {
          const v = normInput(ev.text).trim();
          const idx = /^[1-9]$/.test(v) ? Number(v) - 1 : -1;
          if (idx >= 0 && idx < vote.options.length) {
            const prev = vote.voters.get(user.id);
            if (prev !== undefined) vote.counts[prev] -= 1;
            else if (vote.voters.size >= MAX_USERS) return false;
            vote.voters.set(user.id, idx);
            vote.counts[idx] += 1;
            changed();
            return true;
          }
        }
        const team = detectTeam(ev.text, S.keywords);
        if (!team) return false;
        setTeam(user.id, team);
        if (phase === 'ended') { changed(); return true; } // chỉ ghi nhớ bên, không dồn chén sang vòng sau
        const last = lastComment.get(user.id);
        if (S.commentCooldownMs > 0 && last !== undefined && t - last < S.commentCooldownMs) return true; // vẫn ghi nhận bên, không cộng chén
        if (phase === 'running' && activeEvent && activeEvent.kind === 'drought' && t < activeEvent.endsAt) return true; // mất nước
        lastComment.set(user.id, t);
        const storm = phase === 'running' && activeEvent && activeEvent.kind === 'storm' && t < activeEvent.endsAt;
        const n = S.dishesPerComment * (storm ? 3 : 1);
        if (n > 0) credit(team, n, user, { source: 'comment' });
        return true;
      }

      if (ev.type === 'gift') {
        const coins = clamp(ev.coins, 0, MAX_COINS, 0);
        if (TEAMS.includes(ev.team)) setTeam(user.id, ev.team);
        addCoins(coins);
        if (phase === 'ended') { changed(); return coins > 0; }
        const giftName = str(ev.giftName);
        const rescue = giftName !== '' && S.rescueGifts.some((g) => giftKey(g) === giftKey(giftName));
        let team = TEAMS.includes(ev.team) ? ev.team : teamOf.get(user.id);
        if (!team) {
          // Pha ready: người rửa thật của vòng sắp mở (washer lúc này có thể do máy tự chơi đẩy lên)
          const w = phase === 'ready' ? (lastResult ? lastResult.loser : S.startWasher) : washer;
          if (rescue) team = w; // cứu người đang rửa
          else if (S.giftWithoutTeam === 'ignore') { changed(); return false; }
          else team = S.giftWithoutTeam === 'other' ? other(w) : w;
        }
        if (!(coins > 0) || !(S.dishesPerCoin > 0)) { changed(); return false; }
        const n = dishesFromCoins(user.id, coins);
        const meta = { source: rescue ? 'rescue' : 'gift', giftName: giftName ? cleanName(giftName) : 'Quà', count: Math.round(clamp(ev.count, 1, 1e5, 1)), coins };
        if (n > 0) credit(team, rescue ? -n : n, user, meta);
        else { creditCoins(team, user, coins); changed(); }
        return true;
      }

      if (ev.type === 'like') {
        if (S.likesPerDish <= 0 || phase === 'ended') return false;
        const team = teamOf.get(user.id);
        if (!team) return false;
        const count = Math.round(clamp(ev.count, 0, 1e6, 1));
        const prev = likesRound.get(user.id) || 0;
        const room = S.likeCapPerRound > 0 ? Math.max(0, S.likeCapPerRound - prev) : count;
        const taken = Math.min(count, room);
        if (taken <= 0) return false;
        if (likesRound.size >= MAX_USERS && !likesRound.has(user.id)) return false;
        likesRound.set(user.id, prev + taken);
        const n = Math.floor((prev + taken) / S.likesPerDish) - Math.floor(prev / S.likesPerDish);
        if (n > 0) credit(team, n, user, { source: 'like', count: taken });
        return true;
      }

      if (ev.type === 'follow' || ev.type === 'share') {
        const per = ev.type === 'follow' ? S.dishesPerFollow : S.dishesPerShare;
        const seen = ev.type === 'follow' ? followRound : shareRound;
        if (per <= 0 || phase === 'ended') return false;
        const team = teamOf.get(user.id);
        if (!team || seen.has(user.id) || seen.size >= MAX_USERS) return false;
        seen.add(user.id);
        credit(team, per, user, { source: ev.type });
        return true;
      }
      return false;
    }

    function resume(t) {
      phase = 'running';
      endsAt = t + pausedRemaining;
      const shift = pausedAt ? t - pausedAt : 0;
      if (activeEvent) activeEvent.endsAt += shift;
      if (nextEventAt) nextEventAt += shift;
      flushPending();
      maybeGolden(t);
      changed();
    }

    function control(action, payload) {
      const t = now();
      switch (action) {
        case 'start':
          if (phase === 'ready') startRound(false);
          else if (phase === 'ended') startRound(true);
          else if (phase === 'paused') { restored = null; resume(t); }
          break;
        case 'pause':
          if (phase === 'running') { pausedRemaining = Math.max(0, endsAt - t); pausedAt = t; phase = 'paused'; changed(); }
          break;
        case 'toggle':
          if (phase === 'running') control('pause');
          else control('start');
          break;
        case 'endRound':
          if (phase === 'running' || phase === 'paused') endRound('manual');
          break;
        case 'reset':
          resetAll();
          if (payload && payload.clearTeams) { teamOf.clear(); lastComment.clear(); }
          emit({ type: 'reset' });
          changed();
          break;
        case 'clearTeams':
          teamOf.clear();
          lastComment.clear();
          changed();
          break;
        case 'streamer': {
          // Streamer tự chọn phe và góp chén dưới tên mình (người thật, có ghi rõ là Streamer)
          const team = payload && TEAMS.includes(payload.team) ? payload.team : null;
          if (!team || phase === 'ended') return false;
          credit(team, S.streamerDishes, { id: '__streamer', name: 'Streamer' }, { source: 'streamer' });
          lastActivityAt = t;
          break;
        }
        case 'event': {
          // Streamer bấm thử một sự kiện (kind trống thì rút ngẫu nhiên).
          if (phase !== 'running') return false;
          const k = payload && EVENT_KINDS.includes(payload.kind) ? payload.kind : EVENT_KINDS[Math.min(3, Math.floor(random() * 4))];
          fireEvent(k);
          break;
        }
        case 'settings': {
          const prev = S;
          S = sanitizeSettings(Object.assign({}, S, payload || {}));
          if (phase === 'ready') { if (!warmup) washer = S.startWasher; pausedRemaining = S.roundSeconds * 1000; }
          if (phase === 'running' && prev.roundSeconds !== S.roundSeconds) {
            // Đổi độ dài vòng khi đang chạy: giữ phần thời gian đã trôi qua.
            const elapsed = prev.roundSeconds * 1000 - (endsAt - t);
            endsAt = t + Math.max(1000, S.roundSeconds * 1000 - elapsed);
          }
          if (phase === 'paused' && prev.roundSeconds !== S.roundSeconds) {
            const elapsed = prev.roundSeconds * 1000 - pausedRemaining;
            pausedRemaining = Math.max(1000, S.roundSeconds * 1000 - elapsed);
          }
          if (phase === 'result' && prev.resultSeconds !== S.resultSeconds) {
            resultEndsAt = Math.max(t + 1000, resultEndsAt + (S.resultSeconds - prev.resultSeconds) * 1000);
          }
          if (!S.randomEvents) nextEventAt = 0;
          else if (!prev.randomEvents && (phase === 'running' || phase === 'paused')) nextEventAt = (phase === 'paused' ? pausedAt : t) + eventDelay();
          // Đổi mốc mục tiêu: tính lại lặng lẽ (không bắn fx goal).
          goalReached = S.goalCoins > 0 && totalCoins >= S.goalCoins;
          emit({ type: 'settings' });
          changed();
          break;
        }
        default:
          return false;
      }
      return true;
    }

    function tick() {
      const t = now();
      if (phase === 'running') {
        if (t >= endsAt) endRound('timeout');
        else {
          maybeGolden(t);
          if (activeEvent && t >= activeEvent.endsAt) { activeEvent = null; changed(); }
          if (S.randomEvents && !nextEventAt) nextEventAt = t + eventDelay();
          // Không rút sự kiện trong 30s cuối hay giờ vàng.
          if (S.randomEvents && nextEventAt && t >= nextEventAt && !activeEvent && endsAt - t > Math.max(30000, goldenWindow())) {
            fireEvent(EVENT_KINDS[Math.min(3, Math.floor(random() * 4))]);
          }
        }
      } else if (phase === 'ready') {
        tickWarmup(t);
      } else if (phase === 'result') {
        if (vote && vote.open && t >= vote.endsAt) closeVote();
        if (t >= resultEndsAt) {
          if (S.autoNextRound) startRound(true);
          else { phase = 'ended'; changed(); }
        }
      }
      // Dọn bộ nhớ comment cũ mỗi ~60s.
      if (t - lastCleanAt >= 60000) {
        lastCleanAt = t;
        for (const [id, at] of lastComment) if (t - at >= S.commentCooldownMs) lastComment.delete(id);
      }
    }

    // Vòng khởi động: máy “comment” từ khoá của một bên mỗi 0,9–2,2 giây, cộng chén y như comment thật
    // (dishesPerComment), giữ hai bên sát nhau để hay đổi người. Không có tên người xem, không đọc cảm ơn,
    // tổng quá 24 chén thì về 0 (chồng chén thấp, không che điện thoại ví dụ). Có người chơi thật là dừng (startRound).
    function tickWarmup(t) {
      if (!warmup) {
        if (!S.warmupAuto || t - lastActivityAt < S.idleSeconds * 1000) return;
        warmup = true;
        botNextAt = t + 800;
        emit({ type: 'warmup', on: true });
        changed();
        return;
      }
      if (!S.warmupAuto) { warmup = false; piles = { vk: 0, ck: 0 }; emit({ type: 'warmup', on: false }); changed(); return; }
      if (t < botNextAt) return;
      botNextAt = t + 900 + random() * 1300;
      const d = piles.vk - piles.ck;
      const team = d > 3 ? 'ck' : d < -3 ? 'vk' : random() < 0.5 ? 'vk' : 'ck';
      const n = Math.max(1, S.dishesPerComment);
      piles[team] += n;
      emit({ type: 'add', team, n, user: { name: 'Máy' }, source: 'bot', keyword: S.keywords[team][0], giftName: null, count: 1, coins: 0 });
      const lead = piles.vk > piles.ck ? 'vk' : piles.ck > piles.vk ? 'ck' : washer;
      if (lead !== washer) { washer = lead; emit({ type: 'swap', washer, bot: true }); }
      if (piles.vk + piles.ck > 24) { piles = { vk: 0, ck: 0 }; washer = S.startWasher; emit({ type: 'warmup', on: true, reset: true }); }
      changed();
    }

    function getState() {
      const t = now();
      let remainingMs = S.roundSeconds * 1000;
      if (phase === 'running') remainingMs = Math.max(0, endsAt - t);
      else if (phase === 'paused') remainingMs = pausedRemaining;
      else if (phase === 'result' || phase === 'ended') remainingMs = 0;
      let ev = null;
      if (activeEvent && (phase === 'running' || phase === 'paused')) {
        const left = phase === 'paused' ? activeEvent.endsAt - pausedAt : activeEvent.endsAt - t;
        if (left > 0) ev = { kind: activeEvent.kind, label: activeEvent.label, endsAt: activeEvent.endsAt, remainingMs: left };
      }
      return {
        phase,
        round,
        washer,
        piles: { vk: piles.vk, ck: piles.ck },
        remainingMs,
        durationMs: S.roundSeconds * 1000,
        resultRemainingMs: phase === 'result' ? Math.max(0, resultEndsAt - t) : 0,
        top: { vk: topList(contrib.vk), ck: topList(contrib.ck) },
        lastResult: lastResult ? Object.assign({}, lastResult) : null,
        players: teamOf.size,
        settings: copySettings(S),
        score: { vk: score.vk, ck: score.ck },
        history: history.map((h) => Object.assign({}, h, { piles: { vk: h.piles.vk, ck: h.piles.ck } })),
        golden: isGolden(t),
        queued: { vk: pending.vk, ck: pending.ck },
        sessionTop: { vk: topList(session.vk, true), ck: topList(session.ck, true) },
        activeEvent: ev,
        vote: vote ? {
          options: vote.options.slice(), counts: vote.counts.slice(), endsAt: vote.endsAt,
          remainingMs: vote.open ? Math.max(0, vote.endsAt - t) : 0, open: vote.open, winner: vote.winner,
        } : null,
        totalCoins,
        goal: { coins: S.goalCoins, text: S.goalText, reached: goalReached },
        restored,
        idleMs: Math.max(0, t - lastActivityAt),
        warmup: warmup && phase === 'ready',
      };
    }

    // Bên đã chọn của một người xem (cho lời chào), null nếu chưa chọn.
    function teamOfUser(id) {
      return teamOf.get(str(id)) || null;
    }

    // Toàn bộ người ủng hộ cả buổi (xuất CSV), sắp theo chén giảm dần.
    function getSupporters() {
      const out = [];
      for (const team of TEAMS) for (const e of session[team].map.values()) out.push({ name: e.name, team, dishes: e.dishes, coins: e.coins });
      return out.sort((a, b) => b.dishes - a.dishes || b.coins - a.coins);
    }

    // ---------- Lưu / khôi phục phiên ----------
    const boardOut = (b) => Array.from(b.map.values()).map((e) => [e.id, e.name, e.dishes, e.coins]);
    const pendingOut = (pc) => Array.from(pc).map(([id, e]) => [id, e.name, e.dishes, e.coins]);
    function exportState() {
      const t = now();
      let remainingMs = S.roundSeconds * 1000;
      if (phase === 'running') remainingMs = Math.max(0, endsAt - t);
      else if (phase === 'paused') remainingMs = pausedRemaining;
      return {
        v: 1,
        round, phase, washer: warmup ? S.startWasher : washer, remainingMs,
        piles: warmup ? { vk: 0, ck: 0 } : { vk: piles.vk, ck: piles.ck }, // chén của máy không lưu
        score: { vk: score.vk, ck: score.ck },
        history: history.map((h) => Object.assign({}, h)),
        lastResult: lastResult ? Object.assign({}, lastResult) : null,
        totalCoins, goalReached,
        queued: { vk: pending.vk, ck: pending.ck },
        queuedCount: { vk: pendingCount.vk, ck: pendingCount.ck },
        queuedContrib: { vk: pendingOut(pendingContrib.vk), ck: pendingOut(pendingContrib.ck) },
        contrib: { vk: boardOut(contrib.vk), ck: boardOut(contrib.ck) },
        session: { vk: boardOut(session.vk), ck: boardOut(session.ck) },
        teams: Array.from(teamOf).slice(-maxTeams),
      };
    }

    const pileNum = (v) => Math.round(clamp(v, 0, MAX_PILE, 0));
    const pilesIn = (p) => ({ vk: pileNum(p && p.vk), ck: pileNum(p && p.ck) });
    function boardIn(b, rows) {
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        if (!Array.isArray(r) || b.map.size >= MAX_USERS) continue;
        const id = str(r[0]).slice(0, 64);
        if (!id) continue;
        b.map.set(id, { id, name: cleanName(r[1]), dishes: pileNum(r[2]), coins: pileNum(r[3]) });
      }
      rebuildTop(b);
    }
    function resultIn(r) {
      if (!r || typeof r !== 'object' || !TEAMS.includes(r.loser)) return null;
      const top = Array.isArray(r.top) ? r.top.slice(0, 3).filter((x) => x && typeof x === 'object').map((x) => ({ name: cleanName(x.name), dishes: pileNum(x.dishes) })) : [];
      return {
        round: Math.round(clamp(r.round, 1, 1e9, 1)), loser: r.loser, winner: other(r.loser),
        dishes: pileNum(r.dishes), piles: pilesIn(r.piles), top,
        reason: r.reason === 'manual' ? 'manual' : 'timeout',
        punishment: typeof r.punishment === 'string' ? cleanText(r.punishment, 40, '') || null : null,
      };
    }

    // Nạp lại phiên đã lưu. Vòng đang chạy/đang dừng được khôi phục ở trạng thái dừng.
    function importState(o) {
      if (!o || typeof o !== 'object' || o.v !== 1) return false;
      resetAll();
      const t = now();
      round = Math.round(clamp(o.round, 1, 1e9, 1));
      washer = TEAMS.includes(o.washer) ? o.washer : S.startWasher;
      piles = pilesIn(o.piles);
      score = pilesIn(o.score);
      history = (Array.isArray(o.history) ? o.history : []).slice(-HISTORY_LEN)
        .filter((h) => h && typeof h === 'object' && TEAMS.includes(h.loser))
        .map((h) => {
          const x = { round: Math.round(clamp(h.round, 1, 1e9, 1)), loser: h.loser, piles: pilesIn(h.piles), reason: h.reason === 'manual' ? 'manual' : 'timeout' };
          if (typeof h.punishment === 'string' && h.punishment) x.punishment = cleanText(h.punishment, 40, '');
          return x;
        });
      lastResult = resultIn(o.lastResult);
      totalCoins = pileNum(o.totalCoins);
      goalReached = S.goalCoins > 0 && totalCoins >= S.goalCoins;
      if (o.queued && typeof o.queued === 'object') {
        for (const team of TEAMS) pending[team] = Math.round(clamp(o.queued[team], -MAX_PILE, MAX_PILE, 0));
      }
      // Người góp vào hàng chờ: để lúc cộng vẫn có tên và vẫn vào bảng ủng hộ.
      for (const team of TEAMS) {
        const rows = o.queuedContrib && o.queuedContrib[team];
        if (Array.isArray(rows)) {
          for (const r of rows) {
            if (!Array.isArray(r) || pendingContrib[team].size >= MAX_USERS) continue;
            const id = str(r[0]).slice(0, 64);
            if (id) pendingContrib[team].set(id, { name: cleanName(r[1]), dishes: pileNum(r[2]), coins: pileNum(r[3]) });
          }
        }
        pendingCount[team] = Math.round(clamp(o.queuedCount && o.queuedCount[team], 0, MAX_PILE, pending[team] ? 1 : 0));
      }
      if (o.contrib) { boardIn(contrib.vk, o.contrib.vk); boardIn(contrib.ck, o.contrib.ck); }
      if (o.session) { boardIn(session.vk, o.session.vk); boardIn(session.ck, o.session.ck); }
      teamOf.clear();
      if (Array.isArray(o.teams)) {
        for (const r of o.teams.slice(-maxTeams)) if (Array.isArray(r) && str(r[0]) && TEAMS.includes(r[1])) setTeam(str(r[0]).slice(0, 64), r[1]);
      }
      const p = o.phase;
      if (p === 'running' || p === 'paused') {
        phase = 'paused';
        pausedRemaining = Math.max(1000, Math.min(S.roundSeconds * 1000, Math.round(clamp(o.remainingMs, 0, 36e5, S.roundSeconds * 1000))));
        pausedAt = t;
        endsAt = t + pausedRemaining;
        goldenFired = isGolden(t); // giờ vàng đã báo trước khi lưu thì không báo lại
      } else if (p === 'result' && lastResult) {
        phase = 'result';
        resultEndsAt = t + S.resultSeconds * 1000;
      } else if (p === 'ended' && lastResult) {
        phase = 'ended';
      } else {
        phase = 'ready';
        pausedRemaining = S.roundSeconds * 1000;
      }
      restored = round;
      changed();
      return true;
    }

    return { handle, control, tick, getState, teamOfUser, getSupporters, exportState, importState };
  }

  return { createEngine, detectTeam, cleanName, cleanText, stripDiacritics, sanitizeSettings, DEFAULTS, TEAMS, EVENT_LABELS, CHARACTERS, SCENES, TIKTOK_GIFTS, giftVi, isBannedName, HOST_LINES, HOST_AI_LINE, hostLine, hostStateLine, warmupLine, isGiftLine: (t) => GIFT_WORDS.test(String(t)) };
});
