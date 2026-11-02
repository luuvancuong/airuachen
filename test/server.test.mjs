// Test phần server: hàm thuần, Vbee với fetch giả, và chạy server thật trên cổng 3993 (Vbee giả ở 3994).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  parseDotEnv, loadDotEnv, safeEqual, maskToken, parseUsername, cleanUsername, createDedupe, createRateLimit,
  writeJsonAtomic, readJsonSafe, csvCell, toCsv, supportersCsv, speakable, ttsLine, ttsParts, giftSpeech, spellAbbr, setBannedWords, ownerIdOf, isGuestGift,
} from '../server-util.js';
import { createTts } from '../tts.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dish-test-'));

// ---------- .env ----------
test('parseDotEnv: nháy, export, comment', () => {
  const env = parseDotEnv('﻿# c\nA=1\nexport B = "x y" \nC=\'q # w\'\nD=abc # chú thích\nE=\n bad line\nF="a\\nb"\n');
  assert.deepEqual(env, { A: '1', B: 'x y', C: 'q # w', D: 'abc', E: '', F: 'a\nb' });
});

test('loadDotEnv không ghi đè biến có sẵn, file thiếu thì bỏ qua', () => {
  const dir = tmpDir();
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'X1=from-file\nX2=from-file\n');
  const env = { X1: 'kept' };
  assert.deepEqual(loadDotEnv(f, env), ['X2']);
  assert.deepEqual(env, { X1: 'kept', X2: 'from-file' });
  assert.deepEqual(loadDotEnv(path.join(dir, 'none'), env), []);
});

// ---------- Token ----------
test('safeEqual và maskToken', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(null, 'a'), false);
  assert.equal(maskToken('matkhau123'), 'matk…');
  assert.equal(maskToken(''), '');
});

// ---------- Username ----------
test('parseUsername: @ ở bất kỳ đâu, link đầy đủ, link rút gọn báo lỗi', () => {
  assert.equal(cleanUsername('@ten.kenh_1'), 'ten.kenh_1');
  assert.equal(cleanUsername('tenkenh'), 'tenkenh');
  assert.equal(cleanUsername('https://www.tiktok.com/@tenkenh/live?lang=vi'), 'tenkenh');
  assert.equal(cleanUsername('  xem live @abc nhé'), 'abc');
  assert.equal(cleanUsername('https://tiktok.com/tenkenh'), 'tenkenh');
  for (const s of ['https://vm.tiktok.com/ZMabc/', 'vt.tiktok.com/xyz']) {
    const r = parseUsername(s);
    assert.equal(r.username, '');
    assert.match(r.error, /link rút gọn/);
  }
  assert.ok(parseUsername('tên có dấu').error);
  assert.deepEqual(parseUsername(''), { username: '', error: '' });
  assert.equal(cleanUsername(123), '');
});

// ---------- Chống trùng / giới hạn ----------
test('createDedupe: LRU theo thứ tự chèn, id rỗng không lọc', () => {
  const d = createDedupe(3);
  assert.equal(d.seen('1'), false);
  assert.equal(d.seen('1'), true);
  d.seen('2'); d.seen('3'); d.seen('4'); // đẩy '1' ra
  assert.equal(d.size, 3);
  assert.equal(d.seen('1'), false);
  assert.equal(d.seen(''), false);
  assert.equal(d.seen(''), false);
  assert.equal(d.seen(undefined), false);
  assert.equal(d.seen('0'), false);
});

test('createRateLimit: theo cửa sổ thời gian', () => {
  let t = 0;
  const hit = createRateLimit(2, 1000, () => t);
  assert.equal(hit(), true);
  assert.equal(hit(), true);
  assert.equal(hit(), false);
  t = 1000;
  assert.equal(hit(), true);
});

test('ownerIdOf / isGuestGift: chỉ lọc khi chắc chắn', () => {
  assert.equal(ownerIdOf({ data: { owner: { id_str: '7123456789012345678' } } }), '7123456789012345678');
  assert.equal(ownerIdOf({ data: { owner_user_id_str: '42' } }), '42');
  assert.equal(ownerIdOf({ data: { owner_user_id: 7123456789012345678 } }), ''); // number mất chính xác
  assert.equal(ownerIdOf(null), '');
  assert.equal(isGuestGift({ toUser: { id: '99' } }, '42'), true);
  assert.equal(isGuestGift({ toUser: { id: '42' } }, '42'), false);
  assert.equal(isGuestGift({ toUser: { id: '0' } }, '42'), false);
  assert.equal(isGuestGift({}, '42'), false);
  assert.equal(isGuestGift({ toUser: { id: '99' } }, ''), false);
});

// ---------- JSON ----------
test('writeJsonAtomic / readJsonSafe: file hỏng đổi thành .bak', () => {
  const dir = tmpDir();
  const f = path.join(dir, 's.json');
  writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(readJsonSafe(f), { a: 1 });
  assert.equal(fs.existsSync(`${f}.tmp`), false);
  fs.writeFileSync(f, '{hỏng');
  const warns = [];
  assert.equal(readJsonSafe(f, (m) => warns.push(m)), null);
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.readFileSync(`${f}.bak`, 'utf8'), '{hỏng');
  assert.equal(warns.length, 1);
  assert.equal(readJsonSafe(path.join(dir, 'none.json')), null);
});

// ---------- CSV ----------
test('CSV: escape, chặn công thức, BOM, CRLF', () => {
  assert.equal(csvCell('a'), 'a');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('x\ny'), '"x\ny"');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell(-1), '-1'); // số thì giữ
  assert.equal(csvCell(null), '');
  assert.equal(toCsv([['a', 'b'], [1, 2]]), '﻿a,b\r\n1,2\r\n');
  const csv = supportersCsv([{ name: 'Lan, "Bé"', team: 'vk', dishes: 30, coins: 30 }], { vk: 'Vợ', ck: 'Chồng' });
  assert.equal(csv, '﻿Hạng,Tên,Bên,Chén,Xu\r\n1,"Lan, ""Bé""",Vợ,30,30\r\n');
});

// ---------- Câu đọc ----------
test('speakable: bỏ emoji, từ tục, cắt độ dài', () => {
  assert.equal(speakable('Lan 🌸✨'), 'Lan');
  assert.equal(speakable('🌸🌸'), 'bạn');
  assert.equal(speakable('thằng đm'), 'bạn');
  assert.equal(speakable('Nguyễn Thị Minh Khai Phường'), 'Nguyễn Thị Minh Khai');
  assert.equal(speakable(undefined), 'bạn');
});

test('ttsLine: quà ≥ ttsMinCoins, đổi người, kết quả, giờ vàng', () => {
  const ctx = { labels: { vk: 'Vợ', ck: 'Chồng' }, minCoins: 10 };
  assert.equal(ttsLine({ type: 'add', source: 'gift', team: 'vk', n: 30, coins: 30, user: { name: 'Lan' }, giftName: 'Donut' }, ctx),
    'Cảm ơn Lan tặng Bánh donut, Vợ thêm 30 chén!');
  assert.equal(ttsLine({ type: 'add', source: 'gift', team: 'vk', n: 1, coins: 1, user: { name: 'Lan' }, giftName: 'Hoa' }, ctx), null);
  assert.equal(ttsLine({ type: 'add', source: 'comment', team: 'vk', n: 1, user: { name: 'Lan' } }, ctx), null);
  assert.equal(ttsLine({ type: 'add', source: 'rescue', team: 'ck', n: -20, coins: 20, user: { name: 'An' }, giftName: 'Xà phòng' }, ctx),
    'Cảm ơn An tặng Xà phòng, Chồng bớt 20 chén!');
  assert.equal(ttsLine({ type: 'swap', washer: 'ck' }, ctx), 'Đổi người! Chồng đang phải rửa');
  assert.equal(ttsLine({ type: 'result', loser: 'vk', dishes: 42 }, ctx), 'Vợ thua, rửa 42 chén!');
  assert.equal(ttsLine({ type: 'golden', mult: 2 }, ctx), 'Giờ vàng! Comment và tim được tính gấp đôi đến hết vòng');
  assert.equal(ttsLine({ type: 'golden', mult: 4 }, ctx), 'Giờ vàng! Comment và tim được tính gấp 4 đến hết vòng');
});

test('ttsParts: tách đoạn cache được, tên quà tiếng Anh đọc tiếng Việt', () => {
  const ctx = { labels: { vk: 'Vợ', ck: 'Chồng' }, minCoins: 10 };
  assert.deepEqual(ttsParts({ type: 'add', source: 'gift', team: 'ck', n: 30, coins: 30, user: { name: 'Lan' }, giftName: 'Rose' }, ctx),
    ['Hoa hồng cho Chồng!', 'Cảm ơn Lan nhé!']);
  assert.deepEqual(ttsParts({ type: 'add', source: 'rescue', team: 'vk', n: -20, coins: 20, user: { name: 'An' }, giftName: 'Xà phòng' }, ctx),
    ['Xà phòng cứu Vợ!', 'Cảm ơn An nhé!']);
  assert.equal(ttsParts({ type: 'add', source: 'gift', team: 'vk', n: 1, coins: 1, user: { name: 'Lan' }, giftName: 'Rose' }, ctx), null);
  assert.deepEqual(ttsParts({ type: 'swap', washer: 'vk' }, ctx), ['Đổi người! Vợ vào rửa!']);
  assert.deepEqual(ttsParts({ type: 'result', loser: 'ck', dishes: 42 }, ctx), ['Chồng thua rồi, đi rửa chén thôi!']);
  assert.deepEqual(ttsParts({ type: 'golden', mult: 2 }, ctx), ['Giờ vàng! Comment và tim được tính gấp đôi đến hết vòng']);
  assert.equal(giftSpeech('Finger Heart'), 'Tim ngón tay');
  assert.equal(giftSpeech('Bánh mì'), 'Bánh mì');
  assert.equal(ttsLine({ type: 'join', name: 'x' }, ctx), null);
  assert.equal(ttsLine({ type: 'swap', washer: 'vk' }, { labels: { vk: 'Sếp 😎', ck: 'NV' } }), 'Đổi người! Sếp đang phải rửa');
});

// ---------- Vbee với fetch giả ----------
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const [status, body, type] = handler(url, init, calls.length);
    return new Response(typeof body === 'string' ? body : body, { status, headers: { 'Content-Type': type || 'application/json' } });
  };
  f.calls = calls;
  return f;
}
const mkTts = (fetch, extra) => {
  const errors = [];
  const t = createTts(Object.assign({
    appId: 'app', token: 'secret-token', dir: tmpDir(), fetch, sleep: async () => {}, log: () => {}, onError: (m) => errors.push(m),
  }, extra || {}));
  return { t, errors };
};

test('Vbee sync: lưu cache, lần sau không gọi API', async () => {
  const f = fakeFetch(() => [200, MP3, 'audio/mpeg']);
  const { t } = mkTts(f);
  const r = await t.say('Xin chào');
  assert.match(r.url, /^\/tts\/[a-f0-9]{40}\.mp3$/);
  assert.ok(t.fileFor(r.hash));
  assert.equal(f.calls[0].body.mode, 'sync');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(f.calls[0].headers['App-Id'], 'app');
  assert.equal('sampleRate' in f.calls[0].body, false);
  const r2 = await t.say('Xin chào');
  assert.equal(r2.hash, r.hash);
  assert.equal(f.calls.length, 1);
  assert.equal(t.fileFor('../etc/passwd'), null);
  assert.equal(t.fileFor('a'.repeat(40)), null);
});

test('Vbee: sync trả 200 kèm JSON lỗi → chuyển async và hỏi lại kết quả', async () => {
  const f = fakeFetch((url, init, n) => {
    if (url.endsWith('/v1/tts') && JSON.parse(init.body).mode === 'sync') return [200, '{"error":{"code":"BAD_REQUEST","message":"sync not supported"}}'];
    if (url.endsWith('/v1/tts')) return [200, '{"requestId":"r1","status":"PROCESSING"}'];
    if (url.includes('/requests/r1')) return n < 5 ? [200, '{"status":"PROCESSING"}'] : [200, '{"result":{"status":"COMPLETED","audioLink":"https://cdn.example/a.mp3"}}'];
    if (url === 'https://cdn.example/a.mp3') return [200, MP3, 'audio/mpeg'];
    return [404, ''];
  });
  const { t, errors } = mkTts(f);
  const r = await t.say('Câu một');
  assert.ok(r && r.url);
  assert.equal(errors.length, 0);
  const asyncCall = f.calls.find((c) => c.body && c.body.mode === 'async');
  assert.equal(asyncCall.body.webhookUrl, 'https://example.com/vbee-callback');
  // Tải audioLink không kèm khoá
  const dl = f.calls.find((c) => c.url === 'https://cdn.example/a.mp3');
  assert.equal(dl.headers.Authorization, undefined);
  // Câu sau đi thẳng async
  f.calls.length = 0;
  await t.say('Câu hai');
  assert.equal(f.calls.some((c) => c.body && c.body.mode === 'sync'), false);
});

test('Vbee: sai khoá → tắt, báo lỗi một lần, không ném lỗi', async () => {
  const f = fakeFetch(() => [401, '{"error":{"code":"UNAUTHORIZED","message":"Unauthorized"}}']);
  const { t, errors } = mkTts(f);
  assert.equal(await t.say('a'), null);
  assert.equal(await t.say('b'), null);
  assert.equal(t.active, false);
  assert.match(t.disabled, /UNAUTHORIZED/);
  assert.equal(errors.length, 1);
  assert.equal(errors.join('').includes('secret-token'), false);
});

test('Vbee: lỗi mạng / FAILED không tắt hẳn, mỗi loại báo một lần', async () => {
  let mode = 'net';
  const f = async (url, init) => {
    if (mode === 'net') throw new TypeError('fetch failed');
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.mode === 'sync') return new Response('{"error":{"code":"BAD_REQUEST","message":"voice not realtime"}}', { status: 400 });
    if (body.mode === 'async') return new Response('{"requestId":"x"}', { status: 200 });
    return new Response('{"status":"FAILED"}', { status: 200 });
  };
  const { t, errors } = mkTts(f);
  assert.equal(await t.say('a'), null);
  assert.equal(await t.say('b'), null);
  assert.equal(errors.length, 1);
  assert.equal(t.active, true);
  mode = 'failed';
  assert.equal(await t.say('c'), null);
  assert.equal(errors.length, 2);
});

test('Vbee: timeout, hàng đợi tối đa 5, bỏ câu quá cũ', async () => {
  let clock = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = async () => { await gate; return new Response(MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }); };
  const { t } = mkTts(f, { now: () => clock });
  const ps = [];
  for (let i = 0; i < 8; i++) ps.push(t.say('câu ' + i));
  // câu 0 đang chạy; 1, 2 bị đẩy ra vì hàng đợi chỉ 5
  clock = 25000; // mọi câu trong hàng đợi quá 20 giây
  release();
  const rs = await Promise.all(ps);
  assert.equal(rs[1], null);
  assert.equal(rs[2], null);
  assert.equal(rs.filter(Boolean).length, 0); // câu 0 xong nhưng trễ quá → bỏ; còn lại quá cũ
  // thiếu khoá thì không làm gì
  const none = createTts({ dir: tmpDir() });
  assert.equal(none.configured, false);
  assert.equal(await none.say('x'), null);
});

test('Vbee: quá thời gian chờ thì bỏ câu, báo lỗi', async () => {
  const f = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const { t, errors } = mkTts(f, { timeoutMs: 50 });
  assert.equal(await t.say('chậm'), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /quá 0.05 giây/);
  assert.equal(t.active, true);
});

// ---------- Chạy server thật ----------
const PORT = 3993;
const VBEE_PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;

function startFakeVbee() {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer fake-token') { res.writeHead(401); return res.end('{"error":{"code":"UNAUTHORIZED","message":"bad"}}'); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(MP3);
    });
  });
  return new Promise((r) => s.listen(VBEE_PORT, '127.0.0.1', () => r(s)));
}

function startServer(dataDir, extraEnv) {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT), HOST: '127.0.0.1', DISH_DATA_DIR: dataDir, DISH_NO_ENV: '1', ADMIN_TOKEN: 'tok123456',
    VBEE_APP_ID: 'app', VBEE_TOKEN: 'fake-token', VBEE_API_URL: `http://127.0.0.1:${VBEE_PORT}/v1/tts`, TIKTOK_USERNAME: '',
  }, extraEnv || {});
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.output = () => out;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => fetch(`${BASE}/health`).then(() => resolve(p)).catch(() => {
      if (Date.now() - t0 > 8000) { p.kill(); reject(new Error('server không chạy: ' + out)); } else setTimeout(poll, 100);
    });
    poll();
  });
}
const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); });

function openWs(q = '?token=tok123456') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${q}`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    msgs.push(m);
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  ws.wait = (pred, ms = 4000) => {
    const hit = msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('hết giờ chờ message: ' + pred.toString() + '\n' + JSON.stringify(msgs.filter((m) => m.t !== 'state')).slice(0, 2000))), ms);
    });
  };
  ws.msgs = msgs;
  return new Promise((r) => ws.on('open', () => r(ws)));
}
const ev = (q) => fetch(`${BASE}/event?token=tok123456&${q}`).then((r) => r.json());

test('server: /event like/follow/share, CSV, TTS, rate limit, lưu và khôi phục phiên', { timeout: 30000 }, async () => {
  const vbee = await startFakeVbee();
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{hỏng'); // file hỏng → .bak, chạy bằng mặc định
  let srv = await startServer(dataDir);
  try {
    assert.ok(fs.existsSync(path.join(dataDir, 'settings.json.bak')));
    assert.equal(srv.output().includes('tok123456'), false); // không in token
    assert.equal(srv.output().includes('fake-token'), false);

    const ws = await openWs();
    const hello = await ws.wait((m) => m.t === 'hello');
    assert.equal(hello.canControl, true);
    assert.deepEqual(hello.state.tts, { mode: 'vbee' });
    // Luật cố định cho test, không phụ thuộc mặc định (sự kiện ngẫu nhiên có thể làm lệch số chén)
    ws.send(JSON.stringify({ t: 'control', action: 'settings', payload: {
      dishesPerCoin: 1, likesPerDish: 30, dishesPerFollow: 5, dishesPerShare: 3, randomEvents: false, punishVote: false, rescueGifts: [],
    } }));
    await ws.wait((m) => m.t === 'fx' && m.fx.type === 'settings');

    assert.deepEqual(await ev('type=chat&user=Lan&text=vk'), { ok: true });
    assert.deepEqual(await ev('type=like&user=Lan&count=60'), { ok: true });
    assert.deepEqual(await ev('type=follow&user=Lan'), { ok: true });
    assert.deepEqual(await ev('type=share&user=Lan'), { ok: true });
    assert.deepEqual(await ev('type=follow&user=Lan'), { ok: false }); // 1 lần/vòng
    await ws.wait((m) => m.t === 'fx' && m.fx.type === 'add' && m.fx.source === 'like');
    await ws.wait((m) => m.t === 'fx' && m.fx.type === 'add' && m.fx.source === 'share');
    // 1 (comment) + 2 (60 tim) + 5 (follow) + 3 (share)
    const st = await ws.wait((m) => m.t === 'state' && m.state.piles.vk === 11);
    assert.equal(st.state.tts.mode, 'vbee');

    // Quà ≥ ttsMinCoins → fx tts có url phát được
    await ev('type=gift&user=Lan&coins=30&gift=Donut');
    // Câu đọc tách đoạn, gửi đúng thứ tự: quà + bên, rồi lời cảm ơn
    const fx = await ws.wait((m) => m.t === 'fx' && m.fx.type === 'tts');
    assert.equal(fx.fx.text, 'Bánh donut cho Vợ!');
    const fx2 = await ws.wait((m) => m.t === 'fx' && m.fx.type === 'tts' && m !== fx);
    assert.equal(fx2.fx.text, 'Cảm ơn Lan nhé!');
    const audio = await fetch(BASE + fx.fx.url);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal((await fetch(`${BASE}/tts/${'0'.repeat(40)}.mp3`)).status, 404);
    assert.equal((await fetch(`${BASE}/tts/..%2Fsettings.json`)).status, 404);
    assert.equal((await fetch(`${BASE}/tts/abc.mp3`)).status, 404);

    // ttsTest
    ws.send(JSON.stringify({ t: 'control', action: 'ttsTest' }));
    await ws.wait((m) => m.t === 'fx' && m.fx.type === 'tts' && /Xin chào/.test(m.fx.text));

    // CSV: cần token, chặn trang khác, có BOM
    assert.equal((await fetch(`${BASE}/export.csv`)).status, 401);
    assert.equal((await fetch(`${BASE}/export.csv?token=sai`)).status, 401);
    assert.equal((await fetch(`${BASE}/export.csv?token=tok123456`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    const csv = await fetch(`${BASE}/export.csv?token=tok123456`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="nguoi-ung-ho-/);
    const buf = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.match(buf.toString('utf8'), /1,Lan,Vợ,41,30/);

    // Không có token: chỉ xem
    const viewer = await openWs('');
    const vh = await viewer.wait((m) => m.t === 'hello');
    assert.equal(vh.canControl, false);
    viewer.close();

    // Rate limit: > 50 message/giây → đóng 1008
    const spam = await openWs();
    const closed = new Promise((r) => spam.on('close', (code) => r(code)));
    for (let i = 0; i < 60; i++) spam.send('{"t":"noop"}');
    assert.equal(await closed, 1008);

    // state.json được ghi (debounce 1 giây)
    await new Promise((r) => setTimeout(r, 1300));
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.v, 1);
    assert.equal(saved.piles.vk, 41);
    ws.close();
  } finally {
    await stop(srv);
  }

  // Khởi động lại: khôi phục ván ở trạng thái dừng
  srv = await startServer(dataDir, { VBEE_TOKEN: 'sai-khoa', VBEE_VOICE: 'giong_khac' }); // giọng khác để không trúng cache
  try {
    const ws = await openWs();
    const hello = await ws.wait((m) => m.t === 'hello');
    assert.equal(hello.state.restored, 1);
    assert.equal(hello.state.phase, 'paused');
    assert.equal(hello.state.piles.vk, 41);
    // Khoá sai: lúc tạo sẵn câu cố định đã gặp 401 → chuyển sang giọng trình duyệt, server vẫn chạy
    const st = await ws.wait((m) => m.t === 'state' && m.state.tts.mode === 'browser');
    assert.match(st.state.tts.error, /UNAUTHORIZED/);
    ws.send(JSON.stringify({ t: 'control', action: 'ttsTest' }));
    const fb = await ws.wait((m) => m.t === 'fx' && m.fx.type === 'tts');
    assert.equal(fb.fx.url, null);
    assert.equal((await fetch(`${BASE}/health`)).status, 200);
    assert.equal(srv.output().includes('sai-khoa'), false);
    ws.close();
  } finally {
    await stop(srv);
    vbee.close();
  }
});

test('server: cổng đã bị chiếm thì thoát mã 1, body quá lớn trả 413', { timeout: 20000 }, async () => {
  const vbee = await startFakeVbee();
  const srv = await startServer(tmpDir());
  try {
    // Body > 100 KB: client vẫn nhận được JSON 413 chứ không bị ngắt kết nối
    const r = await fetch(`${BASE}/event?token=tok123456`, { method: 'POST', body: JSON.stringify({ type: 'chat', user: 'x'.repeat(200000), text: 'vk' }) });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { ok: false, error: 'Body quá lớn' });
    assert.equal((await fetch(`${BASE}/health`)).status, 200);

    // Bản thứ hai cùng cổng: báo rõ và thoát, không ghi gì vào thư mục data
    const dir2 = tmpDir();
    const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DISH_DATA_DIR: dir2, DISH_NO_ENV: '1', TIKTOK_USERNAME: '' });
    const p2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p2.stdout.on('data', (d) => { out += d; });
    p2.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((res) => { const t = setTimeout(() => { p2.kill(); res('treo'); }, 5000); p2.once('exit', (c) => { clearTimeout(t); res(c); }); });
    assert.equal(code, 1);
    assert.match(out, new RegExp(`Cổng ${PORT} đang được dùng`));
    assert.equal(fs.existsSync(path.join(dir2, 'state.json')), false);
  } finally {
    await stop(srv);
    vbee.close();
  }
});

test('ttsLine: quà lúc chờ (queued:true) vẫn được cảm ơn', () => {
  const line = ttsLine({ type: 'add', team: 'vk', n: 500, queued: true, source: 'gift', giftName: 'Thiên hà', coins: 500, user: { name: 'Lan' } },
    { labels: { vk: 'Vợ', ck: 'Chồng' }, minCoins: 10 });
  assert.equal(line, 'Cảm ơn Lan tặng Thiên hà, Vợ thêm 500 chén!');
});

test('spellAbbr: chữ viết tắt toàn phụ âm đọc theo tên chữ cái', () => {
  assert.equal(spellAbbr('comment vk cho Vợ, ck cho Chồng'), 'comment vê ca cho Vợ, xê ca cho Chồng');
  assert.equal(spellAbbr('Thích không, chồng ơi'), 'Thích không, chồng ơi');
  assert.equal(spellAbbr('nv'), 'en nờ vê');
});

test('speakable: không đọc link, số điện thoại, tag và từ cấm của streamer', () => {
  assert.equal(speakable('Lan 0912345678'), 'bạn');
  assert.equal(speakable('shop abc.com'), 'bạn');
  assert.equal(speakable('Minh Anh'), 'Minh Anh');
  setBannedWords(['xấu']);
  assert.equal(speakable('Bé xấu'), 'bạn');
  setBannedWords([]);
});

test('tts: gói Vbee không có sync thì chỉ báo một lần, ghi nhớ để lần sau đi thẳng async', async () => {
  const { createTts } = await import('../tts.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-nosync-'));
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push(body ? body.mode : 'GET');
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (body && body.mode === 'sync') return json({ error: { code: 'BAD_REQUEST', message: 'This feature is not supported in user package' } }, 400);
    if (body && body.mode === 'async') return json({ requestId: `r${calls.length}` });
    if (String(url).includes('/requests/')) return json({ status: 'COMPLETED', audioLink: 'http://audio/x.mp3' });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200 });
  };
  const logs = [];
  const mk = () => createTts({ appId: 'a', token: 't', dir, fetch: fakeFetch, log: (m) => logs.push(m), pollMs: 1, sleep: async () => {} });
  const t1 = mk();
  const r = await Promise.all(['một', 'hai', 'ba'].map((x) => t1.say(`Câu ${x}`, 'v')));
  assert.ok(r.every(Boolean));
  assert.equal(logs.filter((m) => /không có chế độ sync/.test(m)).length, 1);
  assert.ok(fs.existsSync(path.join(dir, '.no-sync')));
  calls.length = 0;
  const t2 = mk();
  assert.ok(await t2.say('Câu bốn', 'v'));
  assert.ok(!calls.includes('sync')); // lần sau không thử sync nữa
});
