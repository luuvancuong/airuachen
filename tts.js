// Ai rửa chén? — giọng đọc Vbee (https://api-docs.vbee.vn), không cần thư viện ngoài.
// Thử mode sync trước (nhanh, ≤ 300 ký tự), lỗi thì chuyển async + hỏi lại kết quả (~2–3 giây mỗi câu mới).
// Câu đã tạo được cache nên đọc ngay; server cắt câu thành đoạn và tạo sẵn để đọc trong ~1 giây.
// File mp3 cache trong data/tts/<sha1>.mp3. Khoá chỉ nằm ở server, không bao giờ in ra log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_API = 'https://api.vbee.vn/v1/tts';
// Giọng Minh Quân kiểu YouTuber (người dùng chọn), credit ×1. Đổi bằng VBEE_VOICE hoặc ô Mã giọng.
export const DEFAULT_VOICE = 'hn_male_minhquan_yt-stable';
export const HASH_RE = /^[a-f0-9]{40}$/;

class VbeeError extends Error {
  constructor(message, { code = 'ERROR', status = 0, fatal = false } = {}) {
    super(message);
    this.code = code; this.status = status; this.fatal = fatal;
  }
}

// Đọc lỗi dạng {"error":{"code","message"}} (có khi bọc trong result).
function parseError(status, buf) {
  let j = null;
  try { j = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { /* không phải JSON */ }
  const e = (j && (j.error || (j.result && j.result.error))) || {};
  const code = String(e.code || j?.error_code || (status === 401 ? 'UNAUTHORIZED' : status === 429 ? 'TTS_CCR_MAX_LIMIT_REACHED' : 'HTTP_' + status));
  const msg = String(e.message || j?.error_message || j?.message || `HTTP ${status}`).slice(0, 200);
  const credit = /credit|balance|quota|hết/i.test(msg);
  return new VbeeError(`${code}: ${msg}`, { code, status, fatal: code === 'UNAUTHORIZED' || status === 401 || status === 403 || credit });
}

export function createTts(o = {}) {
  const appId = o.appId || '';
  const token = o.token || '';
  const dir = o.dir;
  const speed = Math.min(1.9, Math.max(0.25, Number(o.speed) || 1.1)); // hơi nhanh cho sôi động
  const mode = ['sync', 'async'].includes(o.mode) ? o.mode : 'auto';
  const webhook = o.webhook || 'https://example.com/vbee-callback'; // bắt buộc với async, không cần nhận được
  const API = o.api || DEFAULT_API; // đổi được để test với server Vbee giả
  const doFetch = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log || console.log;
  const onError = o.onError || (() => {});
  const maxQueue = o.maxQueue || 5;
  const maxAgeMs = o.maxAgeMs || 20000;
  const timeoutMs = o.timeoutMs || 15000;
  const pollMs = o.pollMs || 250;  // Vbee async xong sau ~2–3 giây, hỏi dày để không cộng thêm trễ
  const concurrency = o.concurrency || 3;
  const maxFiles = o.maxFiles || 200;
  const configured = Boolean(appId && token && dir);

  // Gói Vbee không có sync thì ghi nhớ vào file đánh dấu, lần mở server sau đi thẳng async (không tốn request thử)
  const noSyncFile = dir ? path.join(dir, '.no-sync') : null;
  let syncBroken = mode === 'async' || (mode === 'auto' && !!noSyncFile && fs.existsSync(noSyncFile));
  let disabled = null;            // lỗi không thể tự hết (sai khoá, hết credit)
  const reported = new Set();     // mỗi loại lỗi chỉ báo một lần
  const queue = [];
  const warmQueue = [];
  const inflight = new Map();     // hash → Promise<hash>: cùng một câu chỉ gọi Vbee một lần
  let active = 0;

  const headers = () => ({ Authorization: `Bearer ${token}`, 'App-Id': appId, 'Content-Type': 'application/json' });
  const hashOf = (text, voice) => crypto.createHash('sha1').update(`${voice}|${speed}|${text}`).digest('hex');
  const fileOf = (hash) => path.join(dir, `${hash}.mp3`);

  function report(err) {
    const key = err.code || 'ERROR';
    log(`[tts] lỗi Vbee: ${err.message}`);
    if (reported.has(key)) return;
    reported.add(key);
    onError(err.fatal ? `Giọng đọc Vbee lỗi (${err.message}). Chuyển sang giọng trình duyệt.` : `Giọng đọc Vbee lỗi: ${err.message}`);
  }

  async function call(url, init, deadline) {
    const left = deadline - now();
    if (left <= 0) throw new VbeeError(`quá ${timeoutMs / 1000} giây`, { code: 'TIMEOUT' });
    try {
      const res = await doFetch(url, Object.assign({ signal: AbortSignal.timeout(left) }, init));
      return { res, buf: new Uint8Array(await res.arrayBuffer()) };
    } catch (e) {
      if (e instanceof VbeeError) throw e;
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new VbeeError(timeout ? `quá ${timeoutMs / 1000} giây` : `không gọi được API (${(e && e.message) || e})`, { code: timeout ? 'TIMEOUT' : 'NETWORK' });
    }
  }

  async function syncTts(text, voice, deadline) {
    const body = JSON.stringify({ text, mode: 'sync', voiceCode: voice, outputFormat: 'mp3', bitrate: 64, speed });
    const { res, buf } = await call(API, { method: 'POST', headers: headers(), body }, deadline);
    // Sync có thể trả 200 mà body là JSON lỗi: byte đầu '{' thì coi là lỗi.
    if (res.ok && buf.length > 0 && buf[0] !== 0x7b) return buf;
    throw parseError(res.ok ? 400 : res.status, buf);
  }

  async function asyncTts(text, voice, deadline) {
    const body = JSON.stringify({ text, mode: 'async', voiceCode: voice, outputFormat: 'mp3', bitrate: 64, speed, webhookUrl: webhook });
    const first = await call(API, { method: 'POST', headers: headers(), body }, deadline);
    if (!first.res.ok) throw parseError(first.res.status, first.buf);
    let j;
    try { j = JSON.parse(Buffer.from(first.buf).toString('utf8')); } catch { throw new VbeeError('phản hồi async không phải JSON', { code: 'BAD_RESPONSE' }); }
    const id = j.requestId || (j.result && j.result.requestId);
    if (!id) throw parseError(400, first.buf);
    for (;;) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      const r = await call(`${API}/requests/${encodeURIComponent(id)}`, { method: 'GET', headers: headers() }, deadline);
      if (!r.res.ok) throw parseError(r.res.status, r.buf);
      let s;
      try { s = JSON.parse(Buffer.from(r.buf).toString('utf8')); } catch { throw new VbeeError('phản hồi trạng thái không phải JSON', { code: 'BAD_RESPONSE' }); }
      const st = String(s.status || (s.result && s.result.status) || '').toUpperCase();
      const link = s.audioLink || (s.result && s.result.audioLink);
      if (st === 'COMPLETED' && link) {
        // audioLink chỉ sống 3 phút: tải ngay. Không gửi header khoá sang host khác.
        const a = await call(link, { method: 'GET' }, deadline);
        if (!a.res.ok || !a.buf.length) throw new VbeeError(`tải audio lỗi HTTP ${a.res.status}`, { code: 'DOWNLOAD' });
        return a.buf;
      }
      if (s.error || (s.result && s.result.error)) throw parseError(400, r.buf);
      if (st === 'FAILED') throw new VbeeError(`không tạo được audio (${String(s.error_message || s.message || 'FAILED').slice(0, 200)})`, { code: 'FAILED' });
    }
  }

  async function synth(text, voice) {
    const deadline = now() + timeoutMs;
    if (!syncBroken && Array.from(text).length <= 300) {
      try { return await syncTts(text, voice, deadline); } catch (e) {
        if (e.fatal || e.code === 'TIMEOUT' || e.code === 'NETWORK') throw e;
        if (e.status === 429) { await sleep(2000); return syncTts(text, voice, deadline); }
        if (mode === 'sync') throw e;
        // Gói/giọng không hỗ trợ sync: từ giờ dùng async. Vài câu đầu gửi cùng lúc có thể cùng gặp lỗi này: chỉ báo một lần.
        if (!syncBroken) {
          syncBroken = true;
          log(`[tts] gói Vbee không có chế độ sync (${e.message}), dùng async (mỗi câu mới ~2–3 giây). Đã ghi nhớ, lần sau không thử lại.`);
          try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(noSyncFile, ''); } catch { /* bỏ qua */ }
        }
      }
    }
    try { return await asyncTts(text, voice, deadline); } catch (e) {
      if (e.status === 429) { await sleep(2000); return asyncTts(text, voice, deadline); }
      throw e;
    }
  }

  // Giữ tối đa maxFiles file, xoá file cũ nhất.
  function prune() {
    try {
      const files = fs.readdirSync(dir).filter((f) => /^[a-f0-9]{40}\.mp3$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
      for (const x of files.slice(0, Math.max(0, files.length - maxFiles))) fs.unlinkSync(path.join(dir, x.f));
    } catch { /* bỏ qua */ }
  }

  // Trả hash của file mp3 (có sẵn trong cache hoặc vừa tạo).
  function produce(text, voice) {
    const hash = hashOf(text, voice);
    if (inflight.has(hash)) return inflight.get(hash);
    const p = produceNow(text, voice, hash).finally(() => inflight.delete(hash));
    inflight.set(hash, p);
    return p;
  }

  async function produceNow(text, voice, hash) {
    const file = fileOf(hash);
    if (fs.existsSync(file)) {
      try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* bỏ qua */ }
      return hash;
    }
    const buf = await synth(text, voice);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
    prune();
    return hash;
  }

  // Tối đa `concurrency` câu gọi Vbee cùng lúc; câu cần đọc ngay luôn được lấy trước câu tạo sẵn.
  function pump() {
    while (active < concurrency) {
      const item = queue.shift() || warmQueue.shift();
      if (!item) return;
      if (disabled || (item.at !== null && now() - item.at > maxAgeMs)) { item.resolve(null); continue; }
      active += 1;
      run(item).finally(() => { active -= 1; pump(); });
    }
  }

  async function run(item) {
    try {
      const hash = await produce(item.text, item.voice);
      // Đọc trễ quá thì bỏ (file vẫn giữ trong cache cho lần sau).
      item.resolve(item.at !== null && now() - item.at > maxAgeMs ? null : { hash, url: `/tts/${hash}.mp3`, text: item.text });
    } catch (e) {
      const err = e instanceof VbeeError ? e : new VbeeError(String((e && e.message) || e));
      if (err.fatal) disabled = err.message;
      report(err);
      item.resolve(null);
    }
  }

  // Câu đã có trong cache: trả ngay, không phải xếp hàng sau câu đang tạo.
  function cached(text, voice) {
    const hash = hashOf(text, voice);
    if (!fs.existsSync(fileOf(hash))) return null;
    try { const t = new Date(); fs.utimesSync(fileOf(hash), t, t); } catch { /* bỏ qua */ }
    return { hash, url: `/tts/${hash}.mp3`, text };
  }

  // Xếp một câu cần đọc ngay. Trả Promise {hash, url, text} hoặc null (bỏ qua / lỗi / quá trễ).
  function say(text, voice) {
    text = String(text || '').trim();
    if (!configured || disabled || !text) return Promise.resolve(null);
    voice = voice || o.voice || DEFAULT_VOICE;
    const hit = dir && cached(text, voice);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      if (queue.length >= maxQueue) queue.shift().resolve(null); // bỏ câu cũ nhất
      queue.push({ text, voice, at: now(), resolve });
      pump();
    });
  }

  // Tạo sẵn câu cố định khi rảnh, không giới hạn tuổi.
  function warm(text, voice) {
    text = String(text || '').trim();
    voice = voice || o.voice || DEFAULT_VOICE;
    if (!configured || disabled || !text || warmQueue.length >= 160) return Promise.resolve(null);
    if (fs.existsSync(fileOf(hashOf(text, voice)))) return Promise.resolve(null); // đã có sẵn
    return new Promise((resolve) => {
      warmQueue.push({ text, voice, at: null, resolve });
      pump();
    });
  }

  // Đường dẫn file theo hash, chỉ khi hash hợp lệ và file có thật.
  function fileFor(hash) {
    if (!dir || !HASH_RE.test(String(hash))) return null;
    const f = fileOf(hash);
    return fs.existsSync(f) ? f : null;
  }

  return {
    say, warm, fileFor,
    get configured() { return configured; },
    get active() { return configured && !disabled; },
    get disabled() { return disabled; },
  };
}
