// Ai rửa chén? — các hàm thuần cho server (tách riêng để test được)
import './public/engine.js'; // nạp globalThis.DishGame (danh mục quà)
import fs from 'node:fs';
import crypto from 'node:crypto';

// ---------- .env ----------
// Parser nhỏ: KEY=VALUE, bỏ dòng trống/#, nhận "export ", giá trị trong nháy đơn/kép, comment sau giá trị không nháy.
export function parseDotEnv(src) {
  const out = {};
  for (const raw of String(src || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"')) {
      const end = v.indexOf('"', 1);
      v = (end > 0 ? v.slice(1, end) : v.slice(1)).replace(/\\n/g, '\n');
    } else if (v.startsWith("'")) {
      const end = v.indexOf("'", 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = v;
  }
  return out;
}

// Nạp .env vào env, không ghi đè biến đã có. Trả danh sách tên biến đã nạp (không trả giá trị).
export function loadDotEnv(file, env = process.env) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const loaded = [];
  for (const [k, v] of Object.entries(parseDotEnv(src))) {
    if (env[k] === undefined) { env[k] = v; loaded.push(k); }
  }
  return loaded;
}

// ---------- Token ----------
// So sánh chuỗi không lộ thời gian; độ dài khác → false.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
// In token ra log: chỉ 4 ký tự đầu.
export const maskToken = (t) => (t ? String(t).slice(0, 4) + '…' : '');

// ---------- Username TikTok ----------
// Nhận "@tenkenh", "tenkenh", link tiktok.com/@tenkenh/live… Link rút gọn vm./vt. không dùng được.
export function parseUsername(input) {
  const s = (typeof input === 'string' ? input : '').trim();
  if (!s) return { username: '', error: '' };
  if (/(^|\/\/|\.)(vm|vt)\.tiktok\.com/i.test(s)) {
    return { username: '', error: 'Dán username dạng @tenkenh, link rút gọn không dùng được' };
  }
  const at = /@([A-Za-z0-9._]{2,24})/.exec(s);
  if (at) return { username: at[1], error: '' };
  const name = s.replace(/^https?:\/\/(www\.|m\.)?tiktok\.com\//i, '').split(/[/?#]/)[0];
  if (/^[A-Za-z0-9._]{1,24}$/.test(name)) return { username: name, error: '' };
  return { username: '', error: 'Username không hợp lệ, dán dạng @tenkenh' };
}
export const cleanUsername = (input) => parseUsername(input).username;

// ---------- Chống trùng ----------
// Nhớ tối đa max id gần nhất (theo thứ tự chèn). seen(id) = true nếu đã gặp.
export function createDedupe(max = 5000) {
  const m = new Map();
  return {
    seen(id) {
      id = id == null ? '' : String(id);
      if (!id || id === '0') return false; // không có id thì không lọc
      if (m.has(id)) return true;
      m.set(id, 1);
      if (m.size > max) m.delete(m.keys().next().value);
      return false;
    },
    get size() { return m.size; },
  };
}

// ---------- Quà tặng khách mời ----------
// Id chủ phòng từ room/info (dạng chuỗi; số dạng number có thể mất chính xác nên bỏ).
export function ownerIdOf(ri) {
  const d = (ri && typeof ri === 'object' && (ri.data || ri)) || {};
  const id = (d.owner && (d.owner.id_str || d.owner.idStr)) || d.owner_user_id_str || d.ownerUserIdStr || '';
  return typeof id === 'string' && /^\d+$/.test(id) ? id : '';
}
// Quà gửi cho người khác chủ phòng. Chưa biết chủ phòng hoặc không có người nhận thì coi là quà chủ phòng.
export function isGuestGift(d, ownerId) {
  const to = d && d.toUser;
  const toId = String((to && (to.id || to.userId)) || '');
  return Boolean(ownerId && toId && toId !== '0' && toId !== ownerId);
}

// Giới hạn số lần trong một cửa sổ thời gian: hit() = false khi vượt.
export function createRateLimit(limit, windowMs, now = Date.now) {
  let start = 0, count = 0;
  return () => {
    const t = now();
    if (t - start >= windowMs) { start = t; count = 0; }
    count += 1;
    return count <= limit;
  };
}

// ---------- Ghi/đọc JSON ----------
// Ghi file tạm rồi rename để không bao giờ để lại file ghi dở.
export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
// Đọc JSON; file hỏng thì đổi tên thành .bak, cảnh báo và trả null.
export function readJsonSafe(file, warn = console.warn) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(src); } catch (e) {
    try { fs.renameSync(file, `${file}.bak`); } catch { /* bỏ qua */ }
    warn(`[data] ${file} hỏng (${e.message}), đã đổi tên thành .bak`);
    return null;
  }
}

// ---------- CSV ----------
// Escape một ô CSV; chặn công thức Excel (=, +, -, @) bằng dấu nháy đơn.
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Có BOM UTF-8 để Excel đọc đúng tiếng Việt, xuống dòng CRLF.
export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function supportersCsv(list, labels) {
  const rows = [['Hạng', 'Tên', 'Bên', 'Chén', 'Xu']];
  (list || []).forEach((p, i) => rows.push([i + 1, p.name, (labels && labels[p.team]) || p.team, p.dishes, p.coins]));
  return toCsv(rows);
}

// ---------- Câu đọc ----------
// Tên chứa từ cấm (danh sách có sẵn trong engine + từ streamer thêm), link, số điện thoại thì đọc là "bạn".
// Làm sạch chữ đưa sang Vbee: chỉ giữ chữ, số, khoảng trắng và vài dấu câu; cắt độ dài.
export function speakable(v, max = 20, fallback = 'bạn') {
  let s = (typeof v === 'string' ? v : '').normalize('NFKC').normalize('NFC');
  s = s.replace(/[^\p{L}\p{M}\p{N} .,'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const tokens = s.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (!tokens.length || globalThis.DishGame.isBannedName(s, [...extraBanned])) return fallback; // từ cấm có sẵn (engine) + từ streamer thêm
  if (/https?|www|\.(com|vn|net|me|io)\b|@|\d{5,}/i.test(typeof v === 'string' ? v : '')) return fallback; // link, số điện thoại, tag
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

// Tên quà TikTok thường gửi bằng tiếng Anh: đọc bằng tên tiếng Việt trong danh mục quà của engine.
export function giftSpeech(name) {
  const s = speakable(name, 24, 'quà');
  return speakable(globalThis.DishGame.giftVi(s), 24, 'quà');
}
// Quà rẻ hay gặp (≤ 100 xu): tạo sẵn đoạn “{quà} cho {bên}!” lúc mở server để đọc ngay. Quà đắt hiếm hơn, tạo khi có.
export const COMMON_GIFTS = globalThis.DishGame.TIKTOK_GIFTS.filter((g) => g.coins <= 100).map((g) => g.name);

// Chữ viết tắt toàn phụ âm (vk, ck, nv, mc…) đọc theo tên chữ cái tiếng Việt để giọng đọc không đọc sai.
const LETTER_VI = { b: 'bê', c: 'xê', d: 'dê', đ: 'đê', f: 'ép', g: 'giê', h: 'hát', j: 'gi', k: 'ca', l: 'e lờ', m: 'em mờ',
  n: 'en nờ', p: 'pê', q: 'quy', r: 'e rờ', s: 'ét xì', t: 'tê', v: 'vê', w: 'vê kép', x: 'ích xì', z: 'dét' };
export function spellAbbr(text) {
  return String(text).replace(/(^|[^\p{L}\p{N}])([bcdđfghjklmnpqrstvwxz]{1,4})(?=$|[^\p{L}\p{N}])/giu,
    (m, pre, w) => pre + Array.from(w.toLowerCase()).map((ch) => LETTER_VI[ch] || ch).join(' '));
}

// Từ cấm do streamer thêm (settings.bannedWords), dùng chung cho mọi câu đọc.
let extraBanned = new Set();
export function setBannedWords(list) {
  extraBanned = new Set((Array.isArray(list) ? list : []).map((w) => String(w).toLowerCase().trim()).filter(Boolean));
}

// Câu đọc tách thành đoạn để cache được: phần cố định (quà + bên) đọc ngay từ cache,
// phần tên người tặng tạo sẵn khi họ comment, chưa có thì tạo song song và nối vào sau.
// Trả mảng chuỗi theo thứ tự đọc, hoặc null.
export function ttsParts(fx, ctx) {
  const L = (t) => speakable((ctx.labels && ctx.labels[t]) || t, 12, t);
  switch (fx && fx.type) {
    case 'add': {
      if (fx.source !== 'gift' && fx.source !== 'rescue') return null;
      if (!((fx.coins || 0) >= (ctx.minCoins || 0))) return null;
      const g = giftSpeech(fx.giftName);
      return [fx.source === 'rescue' ? `${g} cứu ${L(fx.team)}!` : `${g} cho ${L(fx.team)}!`, thanksLine(fx.user && fx.user.name)];
    }
    case 'swap':
      return [`Đổi người! ${L(fx.washer)} vào rửa!`];
    case 'result':
      return [`${L(fx.loser)} thua rồi, đi rửa chén thôi!`];
    default: {
      const line = ttsLine(fx, ctx);
      return line ? [line] : null;
    }
  }
}
export const thanksLine = (name) => `Cảm ơn ${speakable(name)} nhé!`;

// Câu đọc cho một fx; null nếu fx này không cần đọc. ctx: {labels, minCoins, lastSwapAt, now}.
export function ttsLine(fx, ctx) {
  const L = (t) => speakable((ctx.labels && ctx.labels[t]) || t, 12, t);
  switch (fx && fx.type) {
    case 'add':
      if (fx.source !== 'gift' && fx.source !== 'rescue') return null;
      if (!((fx.coins || 0) >= (ctx.minCoins || 0))) return null;
      if (fx.source === 'rescue') {
        return `Cảm ơn ${speakable(fx.user && fx.user.name)} tặng ${giftSpeech(fx.giftName)}, ${L(fx.team)} bớt ${Math.abs(fx.n)} chén!`;
      }
      return `Cảm ơn ${speakable(fx.user && fx.user.name)} tặng ${giftSpeech(fx.giftName)}, ${L(fx.team)} thêm ${fx.n} chén!`;
    case 'swap':
      return `Đổi người! ${L(fx.washer)} đang phải rửa`;
    case 'result':
      return `${L(fx.loser)} thua, rửa ${fx.dishes} chén!`;
    case 'golden':
      return `Giờ vàng! Comment và tim được tính gấp ${fx.mult === 2 ? 'đôi' : fx.mult === 3 ? 'ba' : fx.mult} đến hết vòng`;
    case 'goal':
      return fx.text ? `Cả phòng đã đạt mục tiêu: ${speakable(fx.text, 60, '')}!` : 'Cảm ơn cả phòng đã ủng hộ!';
    case 'vote':
      return fx.stage === 'closed' && fx.text ? `Hình phạt: ${speakable(fx.text, 40, '')}` : null;
    default:
      return null;
  }
}
