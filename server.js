// Ai rửa chén? — server cho TikTok Live
// Chạy: npm install && npm start  →  mở http://localhost:3000 (bảng điều khiển) và http://localhost:3000/?obs=1 (gắn OBS)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError } from 'tiktok-live-connector';
import {
  loadDotEnv, safeEqual, maskToken, parseUsername, createDedupe, createRateLimit,
  writeJsonAtomic, readJsonSafe, supportersCsv, ttsLine, ttsParts, thanksLine, spellAbbr, setBannedWords, COMMON_GIFTS, giftSpeech, speakable, ownerIdOf, isGuestGift,
} from './server-util.js';
import { createTts, DEFAULT_VOICE } from './tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Nạp .env ở thư mục dự án (không ghi đè biến đã đặt sẵn). DISH_DATA_DIR / DISH_NO_ENV dùng cho test.
if (!process.env.DISH_NO_ENV) loadDotEnv(path.join(__dirname, '.env'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DISH_DATA_DIR ? path.resolve(process.env.DISH_DATA_DIR) : path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TTS_DIR = path.join(DATA_DIR, 'tts');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';        // đặt khi chạy trên VPS để người lạ không điều khiển được
const EULER_API_KEY = process.env.EULER_API_KEY || '';    // tuỳ chọn, giúp kết nối TikTok ổn định hơn
const AUTO_USERNAME = process.env.TIKTOK_USERNAME || '';
const VBEE_APP_ID = process.env.VBEE_APP_ID || '';
const VBEE_TOKEN = process.env.VBEE_TOKEN || '';
const VBEE_VOICE = process.env.VBEE_VOICE || DEFAULT_VOICE;

await import('./public/engine.js');
const { DishGame } = globalThis;
const { createEngine } = DishGame;

// ---------- Lưu luật chơi ----------
function loadSettings() {
  const s = readJsonSafe(SETTINGS_FILE);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}
function saveSettings(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); writeJsonAtomic(SETTINGS_FILE, s); }
  catch (e) { console.error('[settings] không lưu được:', e.message); }
}

// ---------- Engine ----------
const clients = new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}
function notice(message) { broadcast({ t: 'notice', message }); }

let stateDirty = true;
let saveTimer = null;   // ghi data/state.json
let lastSaveAt = 0;
let settings = null; // bản sao luật chơi, cập nhật khi có fx settings (đỡ gọi getState mỗi sự kiện)
const engine = createEngine({
  settings: loadSettings(),
  onEffect: (fx) => { broadcast({ t: 'fx', fx }); onGameFx(fx); },
  onChange: () => { stateDirty = true; scheduleSave(); },
});
settings = engine.getState().settings;
setBannedWords(settings.bannedWords);

// ---------- Giọng đọc Vbee ----------
const tts = createTts({
  appId: VBEE_APP_ID, token: VBEE_TOKEN, voice: VBEE_VOICE, dir: TTS_DIR,
  speed: process.env.VBEE_SPEED, mode: process.env.VBEE_MODE, webhook: process.env.VBEE_WEBHOOK,
  api: process.env.VBEE_API_URL, // chỉ dùng khi test với server Vbee giả
  onError: (msg) => { notice(msg); stateDirty = true; },
});
// vbee: server tạo mp3; browser: client tự đọc bằng speechSynthesis (fx tts không có url); off: tắt.
const ttsMode = () => (!settings.ttsEnabled ? 'off' : tts.active ? 'vbee' : 'browser');
const ttsVoice = () => settings.ttsVoice || VBEE_VOICE;

function speak(text) {
  if (!text) return;
  const mode = ttsMode();
  if (mode === 'off') return;
  if (mode === 'browser') return broadcast({ t: 'fx', fx: { type: 'tts', url: null, text } });
  tts.say(text, ttsVoice()).then((r) => {
    if (r) broadcast({ t: 'fx', fx: { type: 'tts', url: r.url, text } });
    else if (ttsMode() === 'browser') broadcast({ t: 'fx', fx: { type: 'tts', url: null, text } }); // Vbee vừa hỏng: để trình duyệt đọc
  }).catch((e) => console.error('[tts] lỗi:', e));
}

// Đọc nhiều đoạn: tất cả bắt đầu tạo cùng lúc (đoạn có sẵn trả ngay), nhưng gửi xuống client đúng thứ tự.
// Đoạn đầu (quà + bên) thường đã cache nên vang lên ngay; đoạn tên chưa có thì tạo trong lúc đoạn đầu đang đọc.
function speakParts(parts, fullText) {
  if (!parts || !parts.length) return;
  const mode = ttsMode();
  if (mode === 'off') return;
  if (mode === 'browser') return broadcast({ t: 'fx', fx: { type: 'tts', url: null, text: fullText || parts.join(' ') } });
  const voice = ttsVoice();
  lastVoiceAt = Date.now();
  let chain = Promise.resolve();
  for (const text of parts) {
    const job = tts.say(spellAbbr(text), voice);
    chain = chain.then(() => job).then((r) => { if (r) broadcast({ t: 'fx', fx: { type: 'tts', url: r.url, text } }); });
  }
  chain.catch((e) => console.error('[tts] lỗi:', e));
}

// Danh sách quà thật của phòng live (tên + giá xu), lấy sau khi kết nối; lỗi thì giữ danh mục có sẵn.
// Bảng điều khiển dùng cho nút giả lập; giọng đọc tạo sẵn đoạn “{quà} cho {bên}!” cho các quà rẻ (≤ 100 xu).
let roomGifts = null;
async function loadRoomGifts(c) {
  try {
    const raw = await c.fetchAvailableGifts();
    if (conn !== c || !Array.isArray(raw)) return;
    const seen = new Set();
    roomGifts = raw.map((g) => ({ name: speakable(g && g.name, 40, ''), coins: Math.max(0, Math.round(Number(g && (g.diamond_count ?? g.diamondCount)) || 0)) }))
      .filter((g) => g.name && g.coins > 0 && !seen.has(g.name) && seen.add(g.name)).slice(0, 300);
    broadcast({ t: 'gifts', gifts: roomGifts });
    console.log(`[tiktok] đã lấy ${roomGifts.length} quà của phòng`);
    if (ttsMode() === 'vbee') {
      for (const t of ['vk', 'ck']) {
        const label = speakable(settings.labels[t], 12, t);
        for (const g of roomGifts.filter((x) => x.coins <= 100).slice(0, 30)) warmLine(`${giftSpeech(g.name)} cho ${label}!`);
      }
    }
  } catch (e) {
    console.warn('[tiktok] không lấy được danh sách quà của phòng:', (e && e.message) || e);
  }
}

// ---------- Lời dẫn tự động ----------
// Người dùng muốn giọng dẫn nói gần như liên tục suốt buổi: đọc xong câu này hostGapSec giây (mặc định 3) thì sang câu sau.
// Dừng khi streamer đang nói (micro hoặc nút “Tôi đang nói”, nói xong 1,5 giây thì đọc tiếp), khi vừa có giọng cảm ơn quà,
// và lúc hiện kết quả. Chọn câu: máy đang chơi → warmupLine; phòng vắng → idleLine (chỉ mời comment);
// đang chơi thật → xen câu diễn biến với câu dẫn. Câu báo giọng AI lúc bắt đầu và 30 phút một lần; câu nhắc quà tối đa 15 phút một lần.
// Client ưu tiên giọng quà: đang dẫn mà có quà thì tắt lời dẫn, đọc quà xong một lúc mới đọc lại câu dẫn đó.
let lastVoiceAt = 0, hostStatic = 0, playCount = 0, idleCount = 0, hostNextAt = Date.now() + 8000;
let lastAiLineAt = 0, lastGiftLineAt = 0, announce = null; // announce: đoạn mở vòng chờ đọc (ưu tiên)
const AI_LINE_EVERY = 30 * 60 * 1000;   // nhắc “giọng đọc AI” khoảng 30 phút một lần
const GIFT_LINE_EVERY = 15 * 60 * 1000; // câu dẫn nhắc quà tối đa 15 phút một lần
// Ước lượng thời gian đọc một câu (giọng Vbee tốc độ 1.1 khoảng 14 ký tự/giây) để câu sau không chen ngang câu trước.
const speakMs = (text) => 1500 + Array.from(text).length * 72;

// Streamer đang nói: bảng điều khiển gửi {t:'talk', on} (tự nghe micro hoặc nút bấm). Overlay tắt lời dẫn ngay.
let streamerTalking = false, talkEndedAt = 0, talkingWs = null;
function setTalking(on, ws) {
  on = !!on;
  talkingWs = on ? ws || null : null;
  if (on === streamerTalking) return;
  streamerTalking = on;
  if (!on) talkEndedAt = Date.now();
  broadcast({ t: 'talk', on });
  stateDirty = true;
}

// Giữa ván thật: cứ câu thứ hai là câu diễn biến (tỉ số, thời gian), còn lại câu dẫn / hướng dẫn; câu nhắc quà khi đủ 15 phút.
function playLine(st, now) {
  playCount += 1;
  if (playCount % 2 === 0) { const l = DishGame.hostStateLine(settings, st, playCount); if (l) return l; }
  if (!lastGiftLineAt || now - lastGiftLineAt >= GIFT_LINE_EVERY) {
    const gift = Array.from({ length: 24 }, (_, i) => DishGame.hostLine(settings, i)).find((l) => l && DishGame.isGiftLine(l));
    if (gift && playCount % 5 === 4) return gift; // không mở đầu buổi bằng câu nhắc quà
  }
  return playCount % 3 === 0 ? DishGame.idleLine(settings, st, playCount * 3 + 1) : DishGame.hostLine(settings, hostStatic++, { noGift: true });
}

function hostTick() {
  if (!settings || ttsMode() === 'off') return;
  const now = Date.now();
  const st = engine.getState();
  if (st.phase !== 'ready' && st.phase !== 'running') return;
  if (streamerTalking || now - talkEndedAt < 1500) return; // streamer đang nói: nhường
  if (now - lastVoiceAt < 3000) return;                    // vừa có giọng cảm ơn quà
  const aiDue = !lastAiLineAt || now - lastAiLineAt > AI_LINE_EVERY;
  // Tắt lời dẫn nhưng vẫn đọc cảm ơn: vẫn báo “giọng đọc AI” khoảng 30 phút một lần
  if (!settings.hostEnabled) { if (aiDue) { lastAiLineAt = now; sendHost(DishGame.HOST_AI_LINE); } return; }
  if (now < hostNextAt && !announce) return;
  let text = null;
  if (announce) { text = announce; announce = null; } // vòng mới: đọc đoạn mở vòng ngay
  else if (aiDue) { text = DishGame.HOST_AI_LINE; lastAiLineAt = now; }
  else if (st.warmup) {
    // Máy vừa làm đổi người thì câu giải thích được đọc ở lượt kế tiếp, tối đa 30 giây một lần
    const swap = warmSwapTeam && now - warmSwapAt < 8000 && now - warmSwapLineAt >= 30000;
    text = swap ? DishGame.warmupLine(settings, st, 'swap', warmSwapCount++, warmSwapTeam) : DishGame.warmupLine(settings, st, 'tick', warmCount++);
    if (swap) warmSwapLineAt = now;
    warmSwapTeam = null;
  } else if (st.idleMs >= settings.idleSeconds * 1000) text = DishGame.idleLine(settings, st, idleCount++);
  else text = playLine(st, now);
  if (!text) return;
  if (DishGame.isGiftLine(text)) lastGiftLineAt = now;
  warmSend(text);
}
setInterval(hostTick, 500);

let warmCount = 0, warmSwapTeam = null, warmSwapAt = 0, warmSwapLineAt = 0, warmSwapCount = 0;
function warmSend(text) {
  hostNextAt = Date.now() + speakMs(text) + settings.hostGapSec * 1000 + Math.random() * 1000;
  sendHost(text);
}
function warmupSpeak(kind, team) {
  if (!settings || !settings.hostEnabled || ttsMode() === 'off') return;
  if (kind === 'swap') { warmSwapTeam = team; warmSwapAt = Date.now(); return; } // đọc ở lượt kế tiếp, không chen ngang
  if (Date.now() - lastVoiceAt < 3000 || streamerTalking) return; // đang đọc cảm ơn quà / streamer đang nói
  warmSend(DishGame.warmupLine(settings, engine.getState(), kind, warmCount, team));
}

function sendHost(text) {
  if (ttsMode() === 'browser') return broadcast({ t: 'fx', fx: { type: 'host', url: null, text } });
  tts.say(spellAbbr(text), ttsVoice()).then((r) => {
    if (r) broadcast({ t: 'fx', fx: { type: 'host', url: r.url, text } });
  }).catch((e) => console.error('[host] lỗi:', e));
}

// Tạo sẵn một câu (cùng cách chuẩn hoá với lúc đọc để trúng cache).
const warmLine = (text) => tts.warm(spellAbbr(text), ttsVoice());

// Câu dẫn cố định tạo sẵn để đọc ngay.
function warmHost() {
  if (ttsMode() !== 'vbee' || !settings.hostEnabled) return;
  warmLine(DishGame.HOST_AI_LINE);
  // Câu lúc máy chơi (trừ câu có tỉ số, đổi theo ván)
  const fake = { piles: { vk: 0, ck: 0 } };
  warmLine(DishGame.warmupLine(settings, fake, 'start'));
  for (const t of ['vk', 'ck']) for (let i = 0; i < 3; i++) warmLine(DishGame.warmupLine(settings, fake, 'swap', i, t));
  // Tạo sẵn mọi câu không có con số (câu có tỉ số đổi theo ván, tạo khi đọc)
  for (let i = 0; i < 20; i++) { const l = DishGame.warmupLine(settings, fake, 'tick', i); if (!/\d/.test(l)) warmLine(l); }
  for (let i = 0; i < 40; i++) {
    const line = DishGame.hostLine(settings, i);
    if (!line) break;
    warmLine(line);
  }
}

// Tạo sẵn “Cảm ơn {tên} nhé!” khi người xem comment / thả tim lần đầu, để lúc họ tặng quà đọc được ngay.
const warmedNames = new Set();
function warmName(name) {
  if (ttsMode() !== 'vbee' || !name) return;
  const line = thanksLine(name);
  if (warmedNames.has(line)) return;
  if (warmedNames.size > 5000) warmedNames.clear();
  warmedNames.add(line);
  warmLine(line);
}

let lastSwapSpeak = 0;
function onGameFx(fx) {
  if (!settings) return;
  if (fx.type === 'settings') { settings = engine.getState().settings; setBannedWords(settings.bannedWords); stateDirty = true; return; }
  // Vòng máy chơi: không cảm ơn, không tạo sẵn tên; chỉ có lời dẫn bình luận + hướng dẫn
  if (fx.type === 'warmup') { if (fx.on && !fx.reset) warmupSpeak('start'); return; }
  if (fx.type === 'swap' && fx.bot) { warmupSpeak('swap', fx.washer); return; }
  // Vòng mới: đoạn dẫn mở vòng, đọc ở lượt kế tiếp của giọng dẫn (vẫn nhường streamer và giọng quà)
  if (fx.type === 'round') { if (settings.hostEnabled) announce = DishGame.roundLine(settings, engine.getState(), fx.round, fx.washer); return; }
  if (fx.bot || fx.source === 'bot') return;
  if (fx.type === 'add' && fx.source === 'streamer') { speakParts([`Streamer vào phe ${speakable(settings.labels[fx.team], 12, fx.team)}!`]); return; }
  if (fx.type === 'swap') {
    if (Date.now() - lastSwapSpeak < 10000) return; // tối đa 1 lần/10s
    lastSwapSpeak = Date.now();
  }
  if (fx.type === 'add' && fx.source !== 'gift' && fx.source !== 'rescue' && fx.user) { warmName(fx.user.name); return; }
  try {
    const ctx = { labels: settings.labels, minCoins: settings.ttsMinCoins };
    const parts = ttsParts(fx, ctx);
    if (parts && fx.type === 'add') thankGift(fx, parts, ttsLine(fx, ctx));
    else speakParts(parts, ttsLine(fx, ctx));
  } catch (e) { console.error('[tts] lỗi tạo câu:', e); }
}

// Cảm ơn quà tối đa 1 lần mỗi THANK_WINDOW: quà đầu đọc ngay, quà tới trong lúc đó gom lại đọc một câu
// “Cảm ơn A, B và n bạn nữa” (không đọc dồn dập từng người, combo đã chỉ tính một lần ở repeatEnd).
const THANK_WINDOW = 10000;
let thankUntil = 0, thankBuf = [], thankTimer = null;
function thankGift(fx, parts, fullText) {
  const now = Date.now();
  if (now >= thankUntil) {
    thankUntil = now + THANK_WINDOW;
    clearTimeout(thankTimer);
    thankTimer = setTimeout(flushThanks, THANK_WINDOW);
    speakParts(parts, fullText);
    return;
  }
  const name = speakable(fx.user && fx.user.name);
  if (!thankBuf.includes(name)) thankBuf.push(name);
}
function flushThanks() {
  thankTimer = null;
  const names = thankBuf;
  thankBuf = [];
  if (!names.length) return;
  thankUntil = Date.now() + THANK_WINDOW;
  thankTimer = setTimeout(flushThanks, THANK_WINDOW);
  const text = names.length === 1 ? `Cảm ơn ${names[0]} đã ủng hộ nha!`
    : names.length === 2 ? `Cảm ơn ${names[0]} và ${names[1]} đã ủng hộ nha!`
      : `Cảm ơn ${names[0]}, ${names[1]} và ${names.length - 2} bạn nữa đã ủng hộ nha!`;
  speakParts([text]);
}

// Câu cố định tạo sẵn khi rảnh để đọc không bị trễ.
function warmTts() {
  if (ttsMode() !== 'vbee') return;
  const L = settings.labels;
  const ctx = { labels: L, minCoins: 0 };
  const fixed = [{ type: 'golden', mult: settings.goldenMult }];
  for (const t of ['vk', 'ck']) fixed.push({ type: 'swap', washer: t }, { type: 'result', loser: t });
  for (const fx of fixed) for (const line of ttsParts(fx, ctx) || []) warmLine(line);
  // “{quà} cho {bên}!” cho quà hay gặp và quà cứu nguy đã cài
  for (const t of ['vk', 'ck']) {
    const label = speakable(L[t], 12, t);
    for (const g of COMMON_GIFTS) warmLine(`${giftSpeech(g)} cho ${label}!`);
    for (const g of settings.rescueGifts || []) warmLine(`${giftSpeech(g)} cứu ${label}!`);
  }
  warmLine(thanksLine('bạn'));
  warmHost();
}

// tts.error: lý do Vbee bị tắt (sai khoá, hết credit…), để bảng điều khiển hiện cho người mở sau.
const stateOut = () => Object.assign(engine.getState(), {
  tts: tts.disabled ? { mode: ttsMode(), error: tts.disabled } : { mode: ttsMode() },
  talking: streamerTalking,
});

// ---------- Lưu / khôi phục phiên ----------
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  lastSaveAt = Date.now();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); writeJsonAtomic(STATE_FILE, engine.exportState()); }
  catch (e) { console.error('[state] không lưu được:', e.message); }
}
// Gom thay đổi, ghi tối đa 1 lần/giây.
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(saveState, 1000); }

function restoreState() {
  const o = readJsonSafe(STATE_FILE);
  if (!o) return;
  const p = o.piles || {};
  const meaningful = Number(o.round) > 1 || Number(p.vk) > 0 || Number(p.ck) > 0 || Number(o.totalCoins) > 0
    || (Array.isArray(o.teams) && o.teams.length > 0);
  if (!meaningful) return;
  if (engine.importState(o)) console.log(`[state] đã khôi phục ván trước (vòng ${engine.getState().round})`);
  else console.warn('[state] state.json không đúng định dạng, bỏ qua');
}
restoreState();

// Trạng thái gửi 4 lần/giây để đồng hồ chạy mượt; gửi ngay khi có thay đổi.
setInterval(() => {
  engine.tick();
  broadcast({ t: 'state', state: stateOut() });
  stateDirty = false;
  // Đang chạy thì đồng hồ trôi mà không có onChange: vẫn lưu mỗi 5 giây.
  if (Date.now() - lastSaveAt > 5000 && engine.getState().phase === 'running') scheduleSave();
}, 250);
setInterval(() => { if (stateDirty) { broadcast({ t: 'state', state: stateOut() }); stateDirty = false; } }, 60);

// ---------- Kết nối TikTok Live ----------
let live = { status: 'idle', username: '', message: 'Chưa kết nối' };
let conn = null;
let wantUsername = '';
let reconnectTimer = null;
let reconnectTries = 0;

function setLive(status, username, message) {
  live = { status, username, message };
  console.log(`[tiktok] ${status}: ${message}`);
  broadcast({ t: 'live', live });
}

// Chống trùng sự kiện khi TikTok gửi lại (sống qua các lần nối lại).
const dedupe = createDedupe(5000);
const dup = (d) => dedupe.seen(d && d.common && d.common.msgId);

// Thử lại 5s, 10s, 20s, 40s rồi mỗi 60s, tối đa MAX_RECONNECT lần.
const MAX_RECONNECT = 30;
function scheduleReconnect(username, why) {
  if (wantUsername !== username) return false;
  if (reconnectTries >= MAX_RECONNECT) {
    setLive('disconnected', username, `${why}. Đã thử lại ${MAX_RECONNECT} lần, bấm Kết nối để thử tiếp.`);
    return true;
  }
  reconnectTries += 1;
  const sec = Math.min(60, 5 * 2 ** (reconnectTries - 1));
  setLive('reconnecting', username, `${why}. Thử lại sau ${sec} giây (lần ${reconnectTries}/${MAX_RECONNECT})`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectTikTok(username, true), sec * 1000);
  return true;
}

function userOf(u) {
  u = u || {};
  const name = u.nickname || u.displayId || u.uniqueId || 'Ẩn danh';
  return { id: String(u.id || u.userId || u.displayId || u.uniqueId || name), name };
}

// Chào người mới vào phòng: tối đa 1 lần/4 giây, bớt phần dư.
const welcomeLimit = createRateLimit(1, 4000);
function welcome(user) {
  if (!settings.welcomeEnabled || !welcomeLimit()) return;
  const name = DishGame.isBannedName(user.name, settings.bannedWords) ? 'Một bạn' : DishGame.cleanName(user.name);
  broadcast({ t: 'fx', fx: { type: 'join', name, team: engine.teamOfUser(user.id) } });
}

async function disconnectTikTok() {
  clearTimeout(reconnectTimer);
  const c = conn;
  conn = null;
  if (c) { try { await c.disconnect(); } catch { /* bỏ qua */ } }
}

// retry = true khi tự kết nối lại hoặc kết nối từ TIKTOK_USERNAME lúc khởi động:
// lỗi (kể cả "chưa phát live") sẽ được thử lại thay vì dừng hẳn.
async function connectTikTok(input, retry = false) {
  const { username, error } = parseUsername(input);
  if (error) { wantUsername = ''; await disconnectTikTok(); return setLive('error', '', error); }
  wantUsername = username;
  if (!retry) reconnectTries = 0;
  await disconnectTikTok();
  if (wantUsername !== username) return; // đã có lệnh kết nối/ngắt khác trong lúc chờ
  if (!username) return setLive('idle', '', 'Chưa nhập username');
  setLive('connecting', username, `Đang kết nối @${username}…`);

  // Không bật enableExtendedGiftInfo: nếu tải danh sách quà lỗi thì cả lần kết nối hỏng, mà d.gift đã có diamondCount.
  const c = new TikTokLiveConnection(username, {
    ...(EULER_API_KEY ? { signApiKey: EULER_API_KEY } : {}),
  });
  conn = c;
  let ownerId = ''; // id chủ phòng, để lọc quà tặng khách mời

  c.on(WebcastEvent.CHAT, (d) => {
    if (conn !== c || dup(d)) return;
    // Bản 2.5.0 (tiktok-live-proto/v3) để nội dung comment ở d.content; d.comment là của bản legacy.
    engine.handle({ type: 'chat', user: userOf(d.user), text: d.content ?? d.comment });
  });

  c.on(WebcastEvent.GIFT, (d) => {
    if (conn !== c) return;
    const g = d.gift || d.giftDetails || {};
    const ext = d.extendedGiftInfo || {};
    const giftType = g.type ?? g.giftType ?? ext.type;
    if (giftType === 1 && !d.repeatEnd) return; // quà đang combo: chờ kết thúc rồi mới tính một lần
    if (dup(d)) return; // lọc trùng sau bước combo để không nuốt mất gói repeatEnd
    // Quà tặng khách mời (multi-guest): bỏ qua trừ khi bật countGuestGifts. Chưa biết chủ phòng thì không lọc.
    // TODO kiểm live: d.toUser.id có rỗng/"0" khi tặng chủ phòng không, và ownerId đọc từ roomInfo có đúng không.
    if (!settings.countGuestGifts && isGuestGift(d, ownerId)) return;
    const unit = Number(g.diamondCount ?? g.diamond_count ?? ext.diamond_count ?? ext.diamondCount ?? 0);
    const count = Math.max(1, Number(d.repeatCount) || 1);
    engine.handle({ type: 'gift', user: userOf(d.user), coins: unit * count, count, giftName: g.name || g.giftName || ext.name || 'Quà' });
  });

  // Tim: bản 2.5.0 (proto v3) để số tim của lô ở d.count; d.likeCount là của bản legacy.
  c.on(WebcastEvent.LIKE, (d) => {
    if (conn !== c || dup(d)) return;
    engine.handle({ type: 'like', user: userOf(d.user), count: Number(d.count ?? d.likeCount) || 1 });
  });
  // Follow / share: thư viện tách từ WebcastSocialMessage theo common.displayText.key.
  c.on(WebcastEvent.FOLLOW, (d) => {
    if (conn !== c || dup(d)) return;
    engine.handle({ type: 'follow', user: userOf(d.user) });
  });
  c.on(WebcastEvent.SHARE, (d) => {
    if (conn !== c || dup(d)) return;
    engine.handle({ type: 'share', user: userOf(d.user) });
  });
  c.on(WebcastEvent.MEMBER, (d) => {
    if (conn !== c || dup(d)) return;
    welcome(userOf(d.user));
  });

  c.on(WebcastEvent.STREAM_END, (info) => {
    if (conn !== c) return;
    conn = null;
    // action 4 = live bị tạm gián đoạn (STREAM_SUSPENDED): chờ rồi nối lại. 3 = kết thúc hẳn.
    if (info && info.action === 4) { scheduleReconnect(username, 'Live đang tạm gián đoạn'); return; }
    wantUsername = '';
    setLive('ended', username, 'Phiên live đã kết thúc');
  });

  c.on(ControlEvent.DISCONNECTED, (info) => {
    if (conn !== c) return;
    conn = null;
    const reason = info && info.reason ? `: ${info.reason}` : '';
    if (!scheduleReconnect(username, `Mất kết nối${reason}`)) setLive('disconnected', username, `Đã ngắt kết nối${reason}`);
  });

  c.on(ControlEvent.ERROR, (e) => console.error('[tiktok] lỗi:', e && (e.info || e.message || e)));

  try {
    const st = await c.connect();
    if (conn !== c) { c.disconnect().catch(() => {}); return; } // đã bị thay hoặc ngắt trong lúc kết nối: đóng kết nối mồ côi
    reconnectTries = 0;
    ownerId = ownerIdOf(c.roomInfo);
    if (!ownerId) console.warn('[tiktok] không đọc được id chủ phòng, quà tặng khách mời sẽ không bị lọc');
    setLive('connected', username, `Đã kết nối phòng live của @${username} (room ${st.roomId})`);
    loadRoomGifts(c);
  } catch (err) {
    if (conn !== c) return;
    conn = null;
    const msg = (err && (err.message || err.name)) || String(err);
    const offline = err instanceof UserOfflineError || /offline|isn't online|not.*live/i.test(msg);
    const why = offline ? `@${username} chưa phát live` : `Không kết nối được: ${msg}`;
    if (retry && scheduleReconnect(username, why)) return;
    setLive('error', username, offline ? `${why}. Bật live trước rồi kết nối lại.` : why);
  }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

function authorized(url) {
  return !ADMIN_TOKEN || safeEqual(url.searchParams.get('token') || '', ADMIN_TOKEN);
}

// Chặn trang web khác (mở trên cùng máy) gửi lệnh tới server qua trình duyệt: CSRF, WebSocket chéo trang, DNS rebinding.
// OBS, curl, TikFinity, Streamer.bot không gửi Origin/Sec-Fetch-Site nên không bị ảnh hưởng.
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];
const LOOPBACK_ONLY = LOOPBACK_NAMES.includes(HOST);
function hostName(h) {
  return String(h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}
function fromOtherSite(req) {
  // Đang nghe localhost mà Host lạ → DNS rebinding.
  if (LOOPBACK_ONLY && req.headers.host && !LOOPBACK_NAMES.includes(hostName(req.headers.host))) return true;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

// Chỉ nhận chuỗi/số từ dữ liệu ngoài; object lạ có thể làm hỏng engine.
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const userId = (v) => text(v).slice(0, 64); // id TikTok chỉ ~19 chữ số

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Gom Buffer rồi mới giải mã để không cắt đôi ký tự tiếng Việt giữa hai chunk. Trả null nếu quá lớn hoặc lỗi.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e5) {
        // Quá lớn: thôi gom, xả phần còn lại để client vẫn nhận được 413 (huỷ socket thì client chỉ thấy lỗi mạng).
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
    req.on('aborted', () => resolve(null));
  });
}

// /event — cho TikFinity, Streamer.bot hoặc công cụ khác bắn sự kiện vào (GET hoặc POST JSON)
// Ví dụ: /event?type=chat&user=Lan&text=vk   |   /event?type=gift&user=Lan&coins=30&gift=Donut
async function handleEventRoute(req, res, url) {
  if (fromOtherSite(req)) return sendJson(res, 403, { ok: false, error: 'Không nhận lệnh từ trang web khác' });
  if (!authorized(url)) return sendJson(res, 401, { ok: false, error: 'Sai token' });
  let p = Object.fromEntries(url.searchParams);
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body === null) {
      res.setHeader('Connection', 'close');
      res.on('finish', () => setTimeout(() => req.destroy(), 1000)); // không nhận tiếp body dài vô hạn
      return sendJson(res, 413, { ok: false, error: 'Body quá lớn' });
    }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'Body không phải JSON' }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { ok: false, error: 'Body phải là object JSON' });
    p = Object.assign(p, parsed);
  }
  const u = p.user && typeof p.user === 'object' ? p.user : null;
  const user = u
    ? { id: userId(u.id) || userId(u.userId), name: text(u.name) || text(u.nickname) }
    : { id: userId(p.userId) || userId(p.user), name: text(p.user) || text(p.nickname) };
  const ev = p.type === 'gift'
    ? { type: 'gift', user, coins: text(p.coins), count: text(p.count), giftName: text(p.gift) || text(p.giftName), team: text(p.team) }
    : p.type === 'like' ? { type: 'like', user, count: text(p.count) || '1' }
    : p.type === 'follow' || p.type === 'share' ? { type: p.type, user }
    : { type: 'chat', user, text: text(p.text) || text(p.comment) };
  const ok = engine.handle(ev);
  sendJson(res, 200, { ok });
}

// /export.csv?token= — người ủng hộ cả buổi (tên, bên, chén, xu), có BOM để Excel đọc đúng tiếng Việt.
function handleExportCsv(req, res, url) {
  if (fromOtherSite(req)) return sendJson(res, 403, { ok: false, error: 'Không nhận lệnh từ trang web khác' });
  if (!authorized(url)) return sendJson(res, 401, { ok: false, error: 'Sai token' });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `nguoi-ung-ho-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.end(supportersCsv(engine.getSupporters(), settings.labels));
}

// /tts/<sha1>.mp3 — chỉ phục vụ file đúng tên hash trong data/tts.
function handleTtsFile(req, res, url) {
  const m = /^\/tts\/([a-f0-9]{40})\.mp3$/.exec(url.pathname);
  const file = m && tts.fileFor(m[1]);
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error('[http] lỗi xử lý request:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function handleRequest(req, res) {
  // Không dựng URL từ header Host: Host sai định dạng làm new URL ném lỗi.
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }

  if (url.pathname === '/event') return handleEventRoute(req, res, url);
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, live, phase: engine.getState().phase });
  if (url.pathname === '/export.csv') return handleExportCsv(req, res, url);
  if (url.pathname.startsWith('/tts/')) return handleTtsFile(req, res, url);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('window.DISH_SERVER = true;');
  }

  let rel;
  try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 64 * 1024,
  verifyClient: ({ req }) => !fromOtherSite(req),
});
wss.on('connection', (ws, req) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return ws.close(1008); }
  const canControl = authorized(url);
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'hello', state: stateOut(), live, canControl, gifts: roomGifts }));

  let warned = false;
  const rate = createRateLimit(50, 1000); // quá 50 message/giây thì đóng kết nối
  ws.on('message', (raw) => {
    if (!rate()) { ws.close(1008, 'Too many messages'); return; }
    if (!canControl) {
      if (!warned) ws.send(JSON.stringify({ t: 'notice', message: 'Trang này chỉ xem, không có quyền điều khiển (thiếu token).' }));
      warned = true;
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try {
      if (m.t === 'control' && m.action === 'ttsTest') {
        // Engine không xử lý ttsTest: server đọc thử một câu.
        if (ttsMode() === 'off') ws.send(JSON.stringify({ t: 'notice', message: 'Giọng đọc đang tắt trong Luật chơi.' }));
        else speak(`Xin chào! ${settings.labels.vk} hay ${settings.labels.ck} sẽ phải rửa chén đây?`);
      } else if (m.t === 'control') {
        engine.control(m.action, m.payload);
        if (m.action === 'settings') { saveSettings(engine.getState().settings); warmTts(); }
      } else if (m.t === 'event') {
        // Đang live thật: không nhận sự kiện giả lập từ bảng điều khiển, để không tạo người xem / quà giả trước mặt người xem thật
        if (live.status === 'connected' || live.status === 'reconnecting') {
          ws.send(JSON.stringify({ t: 'notice', message: 'Đang kết nối live: nút giả lập bị khoá để không tạo người xem giả. Ngắt kết nối nếu muốn thử.' }));
        } else engine.handle(m.event);
      } else if (m.t === 'talk') {
        setTalking(m.on, ws); // streamer đang nói: tạm dừng giọng dẫn
      } else if (m.t === 'live' && m.action === 'connect') {
        connectTikTok(m.username);
      } else if (m.t === 'live' && m.action === 'disconnect') {
        wantUsername = '';
        disconnectTikTok().then(() => setLive('idle', '', 'Đã ngắt kết nối'));
      }
    } catch (e) {
      console.error('[ws] lỗi xử lý lệnh:', e);
    }
  });
  ws.on('close', () => { clients.delete(ws); if (talkingWs === ws) setTalking(false); }); // tab báo “đang nói” bị đóng
  ws.on('error', () => { clients.delete(ws); if (talkingWs === ws) setTalking(false); });
});

// Cổng bị chiếm / không có quyền: báo rõ rồi thoát, không chạy tiếp như tiến trình “ma” không nghe cổng nào.
let listening = false;
function onServerError(e) {
  if (listening) { console.error('[server] lỗi:', e); return; }
  console.error(e.code === 'EADDRINUSE' ? `[server] Cổng ${PORT} đang được dùng: tắt bản cũ hoặc đặt PORT khác`
    : e.code === 'EACCES' ? `[server] Không có quyền mở cổng ${PORT}, đặt PORT khác` : `[server] Không mở được cổng ${PORT}: ${e.message}`);
  process.exit(1);
}
server.on('error', onServerError);
wss.on('error', onServerError); // ws chuyển lỗi của server HTTP sang wss trước, không bắt thì thành uncaughtException
server.listen(PORT, HOST, () => {
  listening = true;
  const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  const tok = ADMIN_TOKEN ? `?token=${maskToken(ADMIN_TOKEN)}` : ''; // không in cả token ra log
  console.log('\n  Ai rửa chén? đã chạy');
  console.log(`  Bảng điều khiển : ${base}/${tok}`);
  console.log(`  Gắn vào OBS     : ${base}/?obs=1   (Browser Source 1080 × 1920)`);
  console.log(`  Nhận sự kiện    : ${base}/event?type=chat&user=Lan&text=vk${ADMIN_TOKEN ? '&token=…' : ''}`);
  console.log(`  Giọng đọc       : ${tts.configured ? `Vbee (${VBEE_VOICE})` : 'trình duyệt (chưa có VBEE_APP_ID / VBEE_TOKEN)'}\n`);
  if (AUTO_USERNAME) connectTikTok(AUTO_USERNAME, true);
  warmTts();
});

// Tắt server: ghi phiên lần cuối.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (listening) saveState(); process.exit(0); }); // chưa nghe được cổng thì không ghi đè state.json
}

// Lưới an toàn khi đang live: ghi lỗi lại thay vì để cả server sập giữa chừng.
process.on('uncaughtException', (e) => console.error('[server] lỗi chưa bắt:', e));
process.on('unhandledRejection', (e) => console.error('[server] promise lỗi chưa bắt:', e));
