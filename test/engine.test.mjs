// Test engine luật chơi: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../public/engine.js');
const { createEngine, detectTeam, cleanName, sanitizeSettings, DEFAULTS, TEAMS } = globalThis.DishGame;

// Engine với đồng hồ giả và số ngẫu nhiên giả.
// Test viết theo bộ luật cũ (1 xu = 1 chén, tắt sự kiện ngẫu nhiên / bình chọn…) để không phụ thuộc mặc định đang dùng.
const LEGACY = {
  dishesPerCoin: 1, resultSeconds: 8, likesPerDish: 30, dishesPerFollow: 5, dishesPerShare: 3,
  rescueGifts: [], randomEvents: false, punishVote: false, voteSeconds: 20, warmupAuto: false,
};
function make(settings, extra) {
  const clock = { t: 1_000_000 };
  const fx = [];
  const rnd = { v: 0 };
  const e = createEngine(Object.assign({
    settings: Object.assign({}, LEGACY, settings),
    now: () => clock.t,
    random: () => rnd.v,
    onEffect: (f) => fx.push(f),
  }, extra || {}));
  const adv = (ms) => { clock.t += ms; e.tick(); };
  const chat = (user, text) => e.handle({ type: 'chat', user: { id: user, name: user }, text });
  const gift = (user, coins, giftName, team) => e.handle({ type: 'gift', user: { id: user, name: user }, coins, giftName, team });
  const of = (type) => fx.filter((f) => f.type === type);
  return { e, clock, fx, rnd, adv, chat, gift, of, st: () => e.getState() };
}

// ---------- API cũ ----------
test('API cũ vẫn còn', () => {
  assert.equal(typeof createEngine, 'function');
  assert.deepEqual(TEAMS, ['vk', 'ck']);
  assert.equal(DEFAULTS.roundSeconds, 180);
  assert.equal(cleanName(''), 'Ẩn danh');
  assert.equal(cleanName('a'.repeat(30)).length, 18);
  assert.equal(sanitizeSettings({ roundSeconds: 5 }).roundSeconds, 15);
});

test('luật cơ bản: comment, quà, đổi người rửa', () => {
  const g = make();
  assert.equal(g.chat('a', 'vk'), true);
  assert.equal(g.st().phase, 'running');
  g.chat('b', 'ck'); g.adv(1); g.chat('c', 'ck');
  assert.deepEqual(g.st().piles, { vk: 1, ck: 2 });
  assert.equal(g.st().washer, 'ck');
  g.gift('a', 5);
  assert.deepEqual(g.st().piles, { vk: 6, ck: 2 });
  assert.equal(g.st().washer, 'vk');
});

// ---------- A1 ----------
test('A1: pha ended không cộng chén, chỉ ghi nhớ bên', () => {
  const g = make({ autoNextRound: false, roundSeconds: 15 });
  g.chat('a', 'vk');
  g.adv(15000); assert.equal(g.st().phase, 'result');
  g.adv(8000); assert.equal(g.st().phase, 'ended');
  g.chat('b', 'ck'); g.gift('b', 100);
  assert.deepEqual(g.st().queued, { vk: 0, ck: 0 });
  assert.equal(g.e.teamOfUser('b'), 'ck');
  g.e.control('start');
  assert.deepEqual(g.st().piles, { vk: 0, ck: 0 });
  assert.equal(g.st().round, 2);
});

test('A1: pha result gộp theo bên, 1 fx queued mỗi bên khi vòng mới', () => {
  const g = make({ roundSeconds: 15, commentCooldownMs: 0 });
  g.chat('a', 'vk');
  g.adv(15000); assert.equal(g.st().phase, 'result');
  const before = g.fx.length;
  for (let i = 0; i < 500; i++) g.chat('u' + i, i % 2 ? 'ck' : 'vk');
  g.gift('u0', 50);
  // Comment lúc chờ không phát fx; quà thì có 1 fx queued:true để báo/đọc cảm ơn ngay.
  assert.deepEqual(g.fx.slice(before).map((f) => `${f.type}:${f.queued}`), ['add:true']);
  assert.deepEqual(g.st().queued, { vk: 300, ck: 250 });
  g.adv(8000);
  assert.equal(g.st().round, 2);
  const q = g.of('add').filter((f) => f.source === 'queued');
  assert.equal(q.length, 2);
  assert.equal(q.find((f) => f.team === 'vk').n, 300);
  assert.equal(q.find((f) => f.team === 'ck').n, 250);
  assert.equal(q.find((f) => f.team === 'vk').coins, 50);
  assert.deepEqual(g.st().piles, { vk: 300, ck: 250 });
  assert.deepEqual(g.st().queued, { vk: 0, ck: 0 });
  assert.equal(g.st().top.vk[0].name, 'u0');
});

// ---------- A2 ----------
test('A2: pause gộp hàng chờ, không đổi người rửa, cộng khi tiếp tục', () => {
  const g = make();
  g.chat('a', 'vk');
  g.e.control('pause');
  g.gift('b', 10, 'Hoa', 'ck');
  assert.equal(g.st().washer, 'vk');
  assert.deepEqual(g.st().piles, { vk: 1, ck: 0 });
  assert.deepEqual(g.st().queued, { vk: 0, ck: 10 });
  g.e.control('start');
  assert.equal(g.st().phase, 'running');
  assert.deepEqual(g.st().piles, { vk: 1, ck: 10 });
  assert.equal(g.st().washer, 'ck');
  assert.deepEqual(g.st().queued, { vk: 0, ck: 0 });
});

// ---------- A3 ----------
test('A3: đổi roundSeconds khi paused giữ phần đã trôi', () => {
  const g = make({ roundSeconds: 100 });
  g.e.control('start');
  g.adv(30000);
  g.e.control('pause');
  assert.equal(g.st().remainingMs, 70000);
  g.e.control('settings', { roundSeconds: 60 });
  assert.equal(g.st().remainingMs, 30000);
  g.e.control('settings', { roundSeconds: 20 });
  assert.equal(g.st().remainingMs, 1000, 'tối thiểu 1s');
});

test('A3: đổi resultSeconds khi result', () => {
  const g = make({ roundSeconds: 15, resultSeconds: 10 });
  g.e.control('start'); g.adv(15000);
  g.adv(3000);
  assert.equal(g.st().resultRemainingMs, 7000);
  g.e.control('settings', { resultSeconds: 5 });
  assert.equal(g.st().resultRemainingMs, 2000);
  g.e.control('settings', { resultSeconds: 2 });
  assert.equal(g.st().resultRemainingMs, 1000);
});

// ---------- A4 ----------
test('A4: detectTeam chuẩn hoá, zero-width, hai bên → null', () => {
  assert.equal(detectTeam('v​k'), 'vk');
  assert.equal(detectTeam('ｖｋ'), 'vk');
  assert.equal(detectTeam('𝐯𝐤'), 'vk');
  assert.equal(detectTeam('vkkkk'), 'vk');
  assert.equal(detectTeam('ckck'), 'ck');
  assert.equal(detectTeam('team vợ nha'), 'vk');
  assert.equal(detectTeam('Chồng ơi'), 'ck');
  assert.equal(detectTeam('vk với ck'), null);
  assert.equal(detectTeam('vợ chồng'), null);
  assert.equal(detectTeam('vo'), 'vk');
  assert.equal(detectTeam('vo di'), null);
  assert.equal(detectTeam('chong'), 'ck');
  assert.equal(detectTeam('vô chống'), null);
  assert.equal(detectTeam(''), null);
  assert.equal(detectTeam({}), null);
});

test('A4/B3: detectTeam với từ khoá tuỳ chỉnh', () => {
  const kw = { vk: ['anh', 'a'], ck: ['em', 'e'] };
  assert.equal(detectTeam('anh ơi', kw), 'vk');
  assert.equal(detectTeam('em đây', kw), 'ck');
  assert.equal(detectTeam('anh em', kw), null);
  assert.equal(detectTeam('vk', kw), null);
  const kw2 = { vk: ['mẹ'], ck: ['dâu'] };
  assert.equal(detectTeam('me', kw2), 'vk');
  assert.equal(detectTeam('me oi', kw2), null);
  assert.equal(detectTeam('dau', kw2), 'ck');
  assert.equal(detectTeam('phe dâu', kw2), 'ck');
});

// ---------- A5 ----------
test('A5: dishesPerCoin < 1 cộng dồn phần lẻ theo người', () => {
  const g = make({ dishesPerCoin: 0.5 });
  g.chat('a', 'vk'); g.chat('b', 'ck');
  g.gift('a', 1);
  assert.equal(g.st().piles.vk, 1);
  g.gift('a', 1);
  assert.equal(g.st().piles.vk, 2);
  g.gift('b', 1); g.gift('a', 1);
  assert.equal(g.st().piles.ck, 1, 'phần lẻ của b riêng');
  assert.equal(g.st().piles.vk, 2);
  g.gift('a', 3);
  assert.equal(g.st().piles.vk, 4);
});

test('A5: dishesPerCoin ≥ 1 giữ cách tính cũ', () => {
  const g = make({ dishesPerCoin: 2 });
  g.chat('a', 'vk'); g.gift('a', 3);
  assert.equal(g.st().piles.vk, 7);
});

// ---------- A6 ----------
test('A6: tick dọn lastComment, teamOf giới hạn kích thước', () => {
  const g = make({ commentCooldownMs: 1000 }, { maxTeams: 3 });
  g.chat('a', 'vk'); g.chat('b', 'vk'); g.chat('c', 'ck');
  g.chat('a', 'ck'); // a làm mới, thành mới nhất
  g.chat('d', 'vk');
  assert.equal(g.st().players, 3);
  assert.equal(g.e.teamOfUser('b'), null, 'b cũ nhất bị xoá');
  assert.equal(g.e.teamOfUser('a'), 'ck');
  assert.equal(g.e.teamOfUser('d'), 'vk');
  // Sau 60s comment cũ được dọn: không thể quan sát trực tiếp, chỉ kiểm cooldown vẫn đúng.
  g.adv(61000);
  g.chat('a', 'ck');
  assert.equal(g.st().piles.ck, 2);
});

test('A6: teamOf mặc định giới hạn 50.000', () => {
  const g = make({ commentCooldownMs: 0 });
  for (let i = 0; i < 50010; i++) g.e.handle({ type: 'gift', user: { id: 'u' + i }, coins: 0, team: 'vk' });
  assert.equal(g.st().players, 50000);
  assert.equal(g.e.teamOfUser('u0'), null);
  assert.equal(g.e.teamOfUser('u50009'), 'vk');
});

// ---------- A7 ----------
test('A7: lý do kết thúc vòng', () => {
  const g = make({ roundSeconds: 15 });
  g.e.control('start');
  g.e.control('endRound');
  assert.equal(g.st().lastResult.reason, 'manual');
  assert.equal(g.of('result')[0].reason, 'manual');
  g.adv(8000);
  g.adv(15000);
  assert.equal(g.st().lastResult.reason, 'timeout');
});

// ---------- A8 ----------
test('A8: clearTeams xoá danh sách chọn bên nhưng giữ ván', () => {
  const g = make();
  g.chat('a', 'vk'); g.chat('b', 'ck');
  assert.equal(g.e.control('clearTeams'), true);
  assert.equal(g.st().players, 0);
  assert.deepEqual(g.st().piles, { vk: 1, ck: 1 });
  assert.equal(g.st().phase, 'running');
});

// ---------- B1 ----------
test('B1: tim cộng chén theo likesPerDish, có trần mỗi vòng', () => {
  const g = make({ likesPerDish: 30, likeCapPerRound: 100 });
  const like = (u, n) => g.e.handle({ type: 'like', user: { id: u }, count: n });
  assert.equal(like('x', 100), false, 'chưa chọn bên → bỏ qua');
  g.chat('a', 'vk');
  like('a', 20); assert.equal(g.st().piles.vk, 1);
  like('a', 20); assert.equal(g.st().piles.vk, 2);
  like('a', 100); assert.equal(g.st().piles.vk, 4, 'trần 100 tim = 3 chén');
  assert.equal(like('a', 30), false);
  const f = g.of('add').filter((x) => x.source === 'like');
  assert.equal(f.length, 2);
});

test('B1: follow / share mỗi người 1 lần mỗi vòng, 0 = tắt', () => {
  const g = make({ roundSeconds: 15, dishesPerShare: 0 });
  g.chat('a', 'ck');
  assert.equal(g.e.handle({ type: 'follow', user: { id: 'a' } }), true);
  assert.equal(g.e.handle({ type: 'follow', user: { id: 'a' } }), false);
  assert.equal(g.e.handle({ type: 'share', user: { id: 'a' } }), false);
  assert.equal(g.e.handle({ type: 'follow', user: { id: 'z' } }), false);
  assert.equal(g.st().piles.ck, 6);
  assert.equal(g.of('add').at(-1).source, 'follow');
  g.adv(15000); g.adv(8000);
  g.e.handle({ type: 'follow', user: { id: 'a' } });
  assert.equal(g.st().piles.ck, 5, 'vòng mới tính lại');
});

// ---------- B2 ----------
test('B2: tỉ số và lịch sử, xoá khi reset', () => {
  const g = make({ roundSeconds: 15, resultSeconds: 2 });
  for (let i = 0; i < 12; i++) {
    g.e.control('start');
    if (i % 3 === 0) g.chat('c' + i, 'ck');
    g.adv(15000); g.adv(2000);
  }
  const s = g.st();
  assert.equal(s.score.vk + s.score.ck, 12);
  assert.equal(s.history.length, 10);
  assert.equal(s.history.at(-1).round, 12);
  assert.ok(['vk', 'ck'].includes(s.history[0].loser));
  assert.ok(s.history[0].piles && s.history[0].reason);
  g.e.control('reset');
  assert.deepEqual(g.st().score, { vk: 0, ck: 0 });
  assert.equal(g.st().history.length, 0);
});

// ---------- B3 ----------
test('B3: labels / keywords được làm sạch', () => {
  const s = sanitizeSettings({ labels: { vk: '  Anh\u0000 ', ck: 'x'.repeat(20) }, keywords: { vk: ['Anh', 'a!', '', 'b', 'c', 'd', 'e', 'f'], ck: 'em, anh , ê' } });
  assert.equal(s.labels.vk, 'Anh');
  assert.equal(Array.from(s.labels.ck).length, 12);
  assert.deepEqual(s.keywords.vk, ['anh', 'a', 'b', 'c', 'd']);
  assert.deepEqual(s.keywords.ck, ['em', 'ê'], 'bỏ từ trùng bên kia');
  const d = sanitizeSettings({});
  assert.deepEqual(d.labels, { vk: 'Vợ', ck: 'Chồng' });
  assert.deepEqual(d.keywords, { vk: ['vk', 'vợ'], ck: ['ck', 'chồng'] });
  const g = make({ keywords: { vk: ['anh'], ck: ['em'] } });
  g.chat('a', 'anh'); g.chat('b', 'vk');
  assert.deepEqual(g.st().piles, { vk: 1, ck: 0 });
});

// ---------- B4 ----------
test('B4: giờ vàng nhân chén, fx một lần', () => {
  const g = make({ roundSeconds: 60, goldenSeconds: 30, goldenMult: 3 });
  g.chat('a', 'vk');
  assert.equal(g.st().golden, false);
  g.adv(30000);
  assert.equal(g.st().golden, true);
  assert.equal(g.of('golden').length, 1);
  g.chat('a', 'vk');
  assert.equal(g.st().piles.vk, 4);
  g.adv(1000);
  assert.equal(g.of('golden').length, 1);
  g.adv(30000); g.adv(8000);
  assert.equal(g.st().golden, false);
  g.adv(30000);
  assert.equal(g.of('golden').length, 2, 'vòng sau báo lại');
});

test('B4: goldenSeconds 0 tắt', () => {
  const g = make({ roundSeconds: 20, goldenSeconds: 0 });
  g.chat('a', 'vk'); g.adv(19000); g.adv(10);
  g.chat('a', 'vk');
  assert.equal(g.st().piles.vk, 2);
  assert.equal(g.of('golden').length, 0);
});

test('B4: vòng ngắn thì giờ vàng tối đa nửa vòng', () => {
  const g = make({ roundSeconds: 20, goldenSeconds: 30 });
  g.e.control('start');
  assert.equal(g.st().golden, false);
  g.adv(10000);
  assert.equal(g.st().golden, true);
});

// ---------- B5 ----------
test('B5: quà cứu nguy trừ chén, sàn 0, đổi người rửa', () => {
  const g = make({ rescueGifts: ['Xà Phòng'], goldenSeconds: 0 });
  g.gift('a', 20, 'Hoa', 'vk');
  g.gift('b', 5, 'Hoa', 'ck');
  assert.equal(g.st().washer, 'vk');
  g.gift('a', 18, 'xa phong');
  assert.deepEqual(g.st().piles, { vk: 2, ck: 5 });
  assert.equal(g.st().washer, 'ck');
  const f = g.of('add').at(-1);
  assert.equal(f.source, 'rescue');
  assert.equal(f.n, -18);
  g.gift('b', 100, 'XÀ PHÒNG');
  assert.equal(g.st().piles.ck, 0);
  assert.equal(g.of('add').at(-1).n, -5);
  // Người chưa chọn bên cứu người đang rửa.
  assert.equal(g.st().washer, 'vk');
  g.gift('z', 1, 'Xà phòng');
  assert.equal(g.st().piles.vk, 1);
  assert.equal(g.st().totalCoins, 144);
});

// ---------- B6 ----------
test('B6: bảng ủng hộ cả buổi cộng qua các vòng', () => {
  const g = make({ roundSeconds: 15 });
  g.gift('a', 10, 'Hoa', 'vk'); g.gift('b', 3, 'Hoa', 'vk');
  g.adv(15000); g.adv(8000);
  g.gift('b', 20, 'Hoa', 'vk');
  for (let i = 0; i < 8; i++) g.gift('p' + i, 1, 'Hoa', 'vk');
  const top = g.st().sessionTop.vk;
  assert.equal(top.length, 5);
  assert.deepEqual(top[0], { name: 'b', dishes: 23, coins: 23 });
  assert.equal(top[1].name, 'a');
  assert.equal(g.st().top.vk.length, 3);
  assert.equal(g.st().top.vk[0].dishes, 20, 'top vòng chỉ tính vòng này');
  const all = g.e.getSupporters();
  assert.equal(all.length, 10);
  assert.deepEqual(all[0], { name: 'b', team: 'vk', dishes: 23, coins: 23 });
  g.e.control('reset');
  assert.equal(g.st().sessionTop.vk.length, 0);
});

// ---------- B8 ----------
test('B8: teamOfUser', () => {
  const g = make();
  assert.equal(g.e.teamOfUser('a'), null);
  g.chat('a', 'ck');
  assert.equal(g.e.teamOfUser('a'), 'ck');
});

// ---------- B9 ----------
test('B9: sự kiện ngẫu nhiên theo lịch, không trong 30s cuối', () => {
  const g = make({ roundSeconds: 300, randomEvents: true, goldenSeconds: 30, commentCooldownMs: 0 });
  g.rnd.v = 0; // trễ 60s, kind đầu tiên = drought
  g.e.control('start');
  g.chat('a', 'vk');
  g.adv(59000); assert.equal(g.of('event').length, 0);
  g.adv(1000);
  const ev = g.of('event');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'drought');
  assert.equal(g.st().activeEvent.kind, 'drought');
  g.chat('a', 'vk');
  assert.equal(g.st().piles.vk, 1, 'mất nước không cộng');
  g.adv(10000);
  assert.equal(g.st().activeEvent, null);
  g.chat('a', 'vk');
  assert.equal(g.st().piles.vk, 2);
  // Sự kiện kế tiếp 10s + 60s sau; rnd 0.3 → storm
  g.rnd.v = 0.3;
  g.adv(60000);
  assert.equal(g.of('event').at(-1).kind, 'storm');
  g.chat('a', 'vk');
  assert.equal(g.st().piles.vk, 5, 'bão ×3');
  g.adv(15000);
  // Còn 300-60-10-60-15 = 155s; sự kiện kế tiếp sau ~15s+60s+… rồi ngưng khi còn ≤ 30s.
  g.rnd.v = 0.99;
  const n = g.of('event').length;
  g.adv(127000); // còn 28s
  const after = g.of('event').length;
  g.adv(20000);
  assert.equal(g.of('event').length, after, 'không rút trong 30s cuối');
  assert.ok(after >= n);
});

test('B9: trượt tay và đổi chồng chén', () => {
  const g = make({ goldenSeconds: 0 });
  g.gift('a', 100, 'Hoa', 'vk'); g.gift('b', 30, 'Hoa', 'ck');
  g.e.control('event', { kind: 'slip' });
  assert.equal(g.st().piles.vk, 110);
  assert.equal(g.of('event').at(-1).n, 10);
  g.e.control('event', { kind: 'swapPiles' });
  assert.deepEqual(g.st().piles, { vk: 30, ck: 110 });
  assert.equal(g.st().washer, 'ck');
  const g2 = make();
  g2.e.control('start');
  g2.e.control('event', { kind: 'slip' });
  assert.equal(g2.st().piles.vk, 5, 'tối thiểu 5');
});

test('B9: pause giữ thời gian còn lại của sự kiện', () => {
  const g = make();
  g.e.control('start');
  g.e.control('event', { kind: 'storm' });
  g.adv(5000);
  g.e.control('pause');
  g.adv(60000);
  assert.equal(g.st().activeEvent.remainingMs, 10000);
  g.e.control('start');
  assert.equal(g.st().activeEvent.remainingMs, 10000);
});

// ---------- B10 ----------
test('B10: bình chọn hình phạt', () => {
  const g = make({ roundSeconds: 15, punishVote: true, voteSeconds: 20, resultSeconds: 5 });
  g.chat('a', 'vk');
  g.adv(15000);
  assert.equal(g.st().vote.open, true);
  assert.equal(g.st().resultRemainingMs, 25000);
  assert.equal(g.of('vote')[0].stage, 'open');
  g.chat('u1', '2'); g.chat('u2', '2'); g.chat('u3', '1');
  g.chat('u3', '3'); // đổi phiếu
  g.chat('u4', '9');
  assert.deepEqual(g.st().vote.counts, [0, 2, 1]);
  assert.deepEqual(g.st().queued, { vk: 0, ck: 0 }, 'comment số không tính chén');
  g.chat('u5', 'ck');
  assert.equal(g.st().queued.ck, 1);
  g.adv(20000);
  const closed = g.of('vote').at(-1);
  assert.equal(closed.stage, 'closed');
  assert.equal(closed.winner, 1);
  assert.equal(closed.text, 'Hát một bài');
  assert.equal(g.st().lastResult.punishment, 'Hát một bài');
  assert.equal(g.st().history.at(-1).punishment, 'Hát một bài');
  g.adv(5000);
  assert.equal(g.st().phase, 'running');
  assert.equal(g.st().vote, null);
});

test('B10: không ai bình chọn thì rút ngẫu nhiên', () => {
  const g = make({ roundSeconds: 15, punishVote: true, voteSeconds: 5 });
  g.e.control('start'); g.adv(15000);
  g.rnd.v = 0.99;
  g.adv(5000);
  assert.equal(g.of('vote').at(-1).winner, 2);
});

// ---------- B11 ----------
test('B11: mục tiêu quà cả phòng', () => {
  const g = make({ goalCoins: 100, goalText: 'Streamer rửa chén thật' });
  g.gift('a', 60, 'Hoa', 'vk');
  assert.equal(g.st().goal.reached, false);
  g.gift('b', 50, 'Hoa', 'ck');
  assert.deepEqual(g.st().goal, { coins: 100, text: 'Streamer rửa chén thật', reached: true });
  assert.equal(g.of('goal').length, 1);
  g.gift('b', 50, 'Hoa', 'ck');
  assert.equal(g.of('goal').length, 1);
  g.e.control('settings', { goalCoins: 500 });
  assert.equal(g.st().goal.reached, false);
  g.e.control('reset');
  assert.equal(g.st().totalCoins, 0);
});

// ---------- B12 ----------
test('B12: exportState / importState, running → paused', () => {
  const g = make({ roundSeconds: 100 });
  g.gift('a', 10, 'Hoa', 'vk'); g.gift('b', 4, 'Hoa', 'ck');
  g.e.control('endRound'); g.adv(8000);
  g.gift('a', 7, 'Hoa', 'vk');
  g.adv(40000);
  const saved = JSON.parse(JSON.stringify(g.e.exportState()));
  const h = make({ roundSeconds: 100 });
  assert.equal(h.e.importState(saved), true);
  const s = h.st();
  assert.equal(s.phase, 'paused');
  assert.equal(s.round, 2);
  assert.equal(s.remainingMs, 60000);
  assert.deepEqual(s.piles, { vk: 7, ck: 0 });
  assert.deepEqual(s.score, g.st().score);
  assert.equal(s.history.length, 1);
  assert.equal(s.totalCoins, 21);
  assert.equal(s.restored, 2);
  assert.equal(h.e.teamOfUser('a'), 'vk');
  assert.deepEqual(s.sessionTop.vk[0], { name: 'a', dishes: 17, coins: 17 });
  assert.equal(s.top.vk[0].dishes, 7);
  h.e.control('start');
  assert.equal(h.st().phase, 'running');
  assert.equal(h.st().restored, null);
});

test('B12: importState từ chối dữ liệu hỏng', () => {
  const g = make();
  assert.equal(g.e.importState(null), false);
  assert.equal(g.e.importState({ v: 2 }), false);
  assert.equal(g.e.importState({ v: 1, piles: { vk: 'x', ck: -5 }, phase: 'weird', teams: [[1, 'zz'], ['a', 'vk'], 'bad'], history: [null, { loser: 'vk', piles: {} }] }), true);
  const s = g.st();
  assert.equal(s.phase, 'ready');
  assert.deepEqual(s.piles, { vk: 0, ck: 0 });
  assert.equal(s.players, 1);
  assert.equal(s.history.length, 1);
});

test('getState có đủ field mới', () => {
  const s = make().st();
  for (const k of ['score', 'history', 'golden', 'queued', 'sessionTop', 'activeEvent', 'vote', 'totalCoins', 'goal', 'restored']) {
    assert.ok(k in s, k);
  }
  assert.ok(JSON.stringify(s));
});

// ---------- Sửa lỗi rà soát ----------
test('Kết thúc vòng lúc đang dừng: hàng chờ tính cho vòng đó, không dồn sang vòng sau', () => {
  const g = make({ resultSeconds: 2, goldenSeconds: 0 });
  g.chat('a', 'vk'); g.adv(2000);
  g.e.control('pause');
  for (let i = 0; i < 5; i++) g.chat(`q${i}`, 'ck');
  assert.deepEqual(g.st().queued, { vk: 0, ck: 5 });
  g.e.control('endRound');
  const r = g.st().lastResult;
  assert.deepEqual(r.piles, { vk: 1, ck: 5 });
  assert.equal(r.loser, 'ck');
  assert.deepEqual(g.st().queued, { vk: 0, ck: 0 });
  g.adv(3000);
  assert.equal(g.st().round, 2);
  assert.deepEqual(g.st().piles, { vk: 0, ck: 0 });
  assert.equal(g.st().washer, 'ck', 'người thua vòng 1 đứng rửa đầu vòng 2');
});

test('Quà lúc chờ vẫn phát fx add queued:true (để đọc cảm ơn), chén cộng khi vòng mới mở', () => {
  const g = make({ resultSeconds: 5, goldenSeconds: 0 });
  g.chat('a', 'vk'); g.e.control('endRound');
  g.gift('a', 500, 'Thiên hà');
  const now = g.of('add').filter((f) => f.queued);
  assert.equal(now.length, 1);
  assert.equal(now[0].source, 'gift');
  assert.equal(now[0].n, 500);
  assert.equal(now[0].giftName, 'Thiên hà');
  assert.deepEqual(g.st().piles, { vk: 1, ck: 0 }, 'chưa cộng vào chồng');
  g.chat('b', 'ck'); // comment lúc chờ không phát fx riêng
  assert.equal(g.of('add').filter((f) => f.queued).length, 1);
  g.adv(6000);
  assert.deepEqual(g.st().piles, { vk: 500, ck: 1 });
});

test('dishesPerCoin < 1: xu của lần tặng chưa đủ 1 chén vẫn vào bảng ủng hộ', () => {
  const g = make({ dishesPerCoin: 0.1 });
  g.chat('m', 'ck');
  for (let i = 0; i < 9; i++) g.gift('m', 1, 'Rose');
  assert.equal(g.st().totalCoins, 9);
  assert.deepEqual(g.e.getSupporters(), [{ name: 'm', team: 'ck', dishes: 1, coins: 9 }]);
  // Lúc tạm dừng: xu vào hàng chờ, cộng khi tiếp tục
  g.e.control('pause');
  g.gift('m', 1, 'Rose'); g.gift('m', 1, 'Rose');
  g.e.control('start');
  assert.equal(g.e.getSupporters()[0].coins, 11);
});

test('Khôi phục phiên có hàng chờ giữ tên người góp và số lượt', () => {
  const g = make();
  g.chat('a', 'vk');
  g.e.control('pause');
  g.chat('b', 'ck'); g.gift('c', 20, 'Rose', 'ck');
  const saved = JSON.parse(JSON.stringify(g.e.exportState()));
  const h = make();
  assert.equal(h.e.importState(saved), true);
  h.e.control('start');
  const q = h.of('add').find((f) => f.source === 'queued' && f.team === 'ck');
  assert.equal(q.n, 21);
  assert.equal(q.user.name, '2 người xem');
  assert.equal(q.count, 2);
  assert.equal(q.people, 2);
  assert.ok(h.e.getSupporters().some((x) => x.name === 'c' && x.coins === 20));
  // Bản lưu cũ không có queuedContrib: không in “0 người xem”
  delete saved.queuedContrib; delete saved.queuedCount;
  const k = make();
  k.e.importState(saved); k.e.control('start');
  const q2 = k.of('add').find((f) => f.source === 'queued');
  assert.equal(q2.user.name, 'Người xem');
  assert.equal(q2.count, 1);
});

test('goldenSeconds được kẹp tối đa nửa vòng ngay trong sanitizeSettings', () => {
  assert.equal(sanitizeSettings({ roundSeconds: 40, goldenSeconds: 30 }).goldenSeconds, 20);
  assert.equal(sanitizeSettings({ roundSeconds: 180, goldenSeconds: 30 }).goldenSeconds, 30);
  const g = make({ roundSeconds: 40, goldenSeconds: 30 });
  assert.equal(g.st().settings.goldenSeconds, 20);
  g.e.control('start'); g.adv(19000);
  assert.equal(g.st().golden, false);
  g.adv(2000);
  assert.equal(g.st().golden, true, 'đúng bằng số panel hiện');
});

test('id người xem bị cắt 64 ký tự', () => {
  const g = make();
  const long = 'x'.repeat(60000);
  g.e.handle({ type: 'chat', user: { id: long, name: 'A' }, text: 'vk' });
  assert.equal(g.e.teamOfUser(long.slice(0, 64)), 'vk');
  const ex = g.e.exportState();
  assert.equal(ex.teams[0][0].length, 64);
});

test('Lời dẫn: điền biến, bỏ câu của tính năng đang tắt, kịch bản riêng, câu theo diễn biến', () => {
  const S = sanitizeSettings({ labels: { vk: 'Anh', ck: 'Em' }, keywords: { vk: 'anh', ck: 'em' }, rescueGifts: ['Ice Cream Cone'] });
  const all = Array.from({ length: 17 }, (_, i) => DishGame.hostLine(S, i));
  assert.ok(all.some((l) => l.includes('comment anh để thêm chén cho Anh')));
  assert.ok(all.some((l) => l.includes('quà cứu nguy') && l.includes('không bắt buộc')));
  assert.ok(all.every((l) => !/[{}]/.test(l)));
  const off = sanitizeSettings({ rescueGifts: [], punishVote: false, randomEvents: false, goldenSeconds: 0 });
  const offLines = Array.from({ length: 30 }, (_, i) => DishGame.hostLine(off, i)).join('|');
  assert.ok(!/cứu nguy|bình chọn|sự kiện bất ngờ|giờ vàng/.test(offLines));
  const own = sanitizeSettings({ hostLines: 'Xin chào {vk}!\n\nPhe {ck} đâu?' });
  assert.deepEqual(own.hostLines, ['Xin chào {vk}!', 'Phe {ck} đâu?']);
  assert.equal(DishGame.hostLine(own, 1), 'Phe Chồng đâu?');
  assert.equal(DishGame.hostLine(own, 2), 'Xin chào Vợ!');
  const st = { phase: 'running', piles: { vk: 30, ck: 12 }, remainingMs: 120000 };
  assert.equal(DishGame.hostStateLine(sanitizeSettings({}), st), 'Vợ đang nhiều hơn Chồng 18 chén nên đang phải rửa đó!');
  assert.equal(DishGame.hostStateLine(sanitizeSettings({}), Object.assign({}, st, { remainingMs: 60000 })), 'Vợ đang phải rửa, còn 60 giây, xem có đổi người không nha!');
  // Câu tự viết nhắc quà mà thiếu “không bắt buộc” thì được nối thêm
  assert.equal(DishGame.hostLine(sanitizeSettings({ hostLines: 'Ủng hộ phe {vk} nha!' }), 0), 'Ủng hộ phe Vợ nha, không bắt buộc nha.');
  assert.equal(DishGame.hostStateLine(sanitizeSettings({}), Object.assign({}, st, { remainingMs: 30000 })), null);
  assert.equal(sanitizeSettings({ hostIntervalSec: 3 }).hostIntervalSec, 30);
  // Câu nhắc quà bị bỏ khi noGift, và luôn có “không bắt buộc”
  const def = sanitizeSettings({});
  const giftLines = Array.from({ length: 16 }, (_, i) => DishGame.hostLine(def, i)).filter(DishGame.isGiftLine);
  assert.ok(giftLines.length >= 1 && giftLines.every((l) => /không bắt buộc/.test(l)));
  const noGift = Array.from({ length: 30 }, (_, i) => DishGame.hostLine(def, i, { noGift: true }));
  assert.ok(noGift.every((l) => !DishGame.isGiftLine(l)));
});

test('Từ cấm: tên người xem chứa từ cấm hiện là “Một bạn”', () => {
  const { e, st } = make({ bannedWords: 'xấu, quảng cáo' });
  e.handle({ type: 'chat', user: { id: 'a', name: 'Bé Xấu Xa' }, text: 'vk' });
  assert.equal(st().top.vk[0].name, 'Một bạn');
});

test('Giờ vàng chỉ nhân comment và tim, không nhân quà', () => {
  const { e, clock, st } = make({ roundSeconds: 60, goldenSeconds: 30, goldenMult: 2 });
  e.control('start');
  clock.t += 35000;
  e.tick();
  e.handle({ type: 'chat', user: { id: 'a', name: 'A' }, text: 'vk' });
  assert.equal(st().piles.vk, 2);
  e.handle({ type: 'gift', user: { id: 'b', name: 'B' }, coins: 10, team: 'ck' });
  assert.equal(st().piles.ck, 10);
});

test('Phòng vắng: máy tự chơi khởi động, dừng và về 0 khi có người chơi thật, không tính điểm, không lưu', () => {
  const { e, clock, fx, st } = make({ warmupAuto: true, idleSeconds: 20 });
  clock.t += 19000; e.tick();
  assert.equal(st().warmup, false);
  clock.t += 2000; e.tick();
  assert.equal(st().warmup, true);
  assert.ok(fx.some((f) => f.type === 'warmup' && f.on));
  for (let i = 0; i < 40; i++) { clock.t += 1000; e.tick(); }
  const bot = fx.filter((f) => f.type === 'add' && f.source === 'bot');
  assert.ok(bot.length > 5);
  assert.ok(bot.every((f) => f.user.name === 'Máy' && !f.coins));
  assert.ok(st().piles.vk + st().piles.ck > 0);
  assert.equal(st().phase, 'ready');
  assert.deepEqual(e.exportState().piles, { vk: 0, ck: 0 }); // chén của máy không lưu
  e.handle({ type: 'chat', user: { id: 'a', name: 'A' }, text: 'ck' });
  assert.equal(st().warmup, false);
  assert.equal(st().phase, 'running');
  assert.deepEqual(st().piles, { vk: 0, ck: 1 });
  assert.deepEqual(st().score, { vk: 0, ck: 0 });
  assert.equal(st().idleMs, 0);
  assert.ok(fx.some((f) => f.type === 'warmup' && f.on === false));
});

test('Phòng vắng: tắt warmupAuto thì không tự chơi; idleMs tăng khi không ai tương tác', () => {
  const { e, clock, fx, st } = make({ warmupAuto: false, idleSeconds: 20 });
  clock.t += 60000; e.tick();
  assert.equal(st().warmup, false);
  assert.equal(st().idleMs, 60000);
  assert.ok(!fx.some((f) => f.source === 'bot'));
});

test('Streamer chọn phe: cộng streamerDishes dưới tên Streamer, mở vòng', () => {
  const { e, st, fx } = make({ streamerDishes: 7 });
  assert.equal(e.control('streamer', { team: 'vk' }), true);
  assert.equal(st().phase, 'running');
  assert.equal(st().piles.vk, 7);
  assert.equal(st().top.vk[0].name, 'Streamer');
  assert.ok(fx.some((f) => f.type === 'add' && f.source === 'streamer'));
  assert.equal(e.control('streamer', { team: 'xx' }), false);
});

test('Câu dẫn phòng vắng nói thật, xoay vòng', () => {
  const S = sanitizeSettings({});
  const ready = { phase: 'ready', piles: { vk: 0, ck: 0 }, remainingMs: 180000, idleMs: 30000 };
  assert.match(DishGame.hostStateLine(S, ready, 0), /bạn là người đầu tiên/);
  assert.notEqual(DishGame.hostStateLine(S, ready, 0), DishGame.hostStateLine(S, ready, 1));
  assert.match(DishGame.hostStateLine(S, Object.assign({}, ready, { warmup: true }), 0), /Máy đang tự chơi khởi động/);
  const quiet = { phase: 'running', piles: { vk: 3, ck: 1 }, remainingMs: 120000, idleMs: 70000 };
  assert.match(DishGame.hostStateLine(S, quiet, 1), /yên quá/);
});

test('Rà soát phòng vắng: quà người chưa chọn bên lúc máy tự chơi vào đúng người rửa của vòng 1; chat thường cũng hết vắng', () => {
  const { e, clock, st, rnd } = make({ warmupAuto: true, idleSeconds: 20, startWasher: 'vk', dishesPerCoin: 1 });
  rnd.v = 0.9; // máy cộng cho ck
  clock.t += 21000; e.tick();
  for (let i = 0; i < 60 && st().washer !== 'ck'; i++) { clock.t += 1000; e.tick(); }
  assert.equal(st().washer, 'ck'); // máy đẩy ck lên
  e.handle({ type: 'gift', user: { id: 'g', name: 'G' }, coins: 30 });
  assert.deepEqual(st().piles, { vk: 30, ck: 0 });
  clock.t += 40000;
  assert.ok(st().idleMs >= 40000);
  e.handle({ type: 'chat', user: { id: 'h', name: 'H' }, text: 'hello mọi người' });
  assert.equal(st().idleMs, 0);
});

test('Rà soát phòng vắng: streamer lúc tạm dừng có fx queued, không tính là người xem', () => {
  const { e, fx } = make({});
  e.handle({ type: 'chat', user: { id: 'a', name: 'A' }, text: 'vk' });
  e.control('pause');
  e.control('streamer', { team: 'vk' });
  assert.ok(fx.some((f) => f.type === 'add' && f.source === 'streamer' && f.queued));
  e.control('start');
  const q = fx.filter((f) => f.source === 'queued').pop();
  assert.equal(q.user.name, 'Người xem');
});

test('Lời dẫn lúc máy chơi: mở đầu hướng dẫn, đổi người giải thích luật, xoay vòng, không nhắc quà', () => {
  const S = sanitizeSettings({ labels: { vk: 'Anh', ck: 'Em' }, keywords: { vk: 'anh', ck: 'em' } });
  const st = { piles: { vk: 3, ck: 5 } };
  assert.match(DishGame.warmupLine(S, st, 'start'), /comment anh là Anh thêm một chén/i);
  assert.match(DishGame.warmupLine(S, st, 'swap', 0, 'ck'), /Em nhiều chén hơn nên phải vào rửa/);
  const ticks = Array.from({ length: 6 }, (_, i) => DishGame.warmupLine(S, st, 'tick', i));
  assert.equal(new Set(ticks).size, 6);
  assert.ok(ticks.some((l) => l.includes('Anh 3 chén, Em 5 chén')));
  assert.ok(ticks.every((l) => !DishGame.isGiftLine(l)));
});

test('Từ cấm có sẵn: chặn tục / lách chữ / cờ bạc, không chặn nhầm tên thường', () => {
  const bad = ['Đ.ị.t mẹ', 'v c l', 'thằng chó Hùng', 'shop nhà cái uy tín', 'Lan 18+', 'dmm', 'Fuck', 'óc chó', 'Tài Xỉu Online', 'zalo 0909', 'FB88 VIP'];
  const ok = ['Lồng đèn', 'Các bạn', 'Dâu tây', 'Hương88', 'Lan Vy', 'Minh Đức', 'Cá vàng', 'Đá bóng', 'Vợ yêu', 'Chó Mực', 'Con Nguyên', 'Đồ ngủ xinh'];
  for (const n of bad) assert.equal(DishGame.isBannedName(n), true, n);
  for (const n of ok) assert.equal(DishGame.isBannedName(n), false, n);
  assert.equal(DishGame.isBannedName('Bé Mập', ['mập']), true); // từ streamer thêm
  const { e, st } = make({});
  e.handle({ type: 'chat', user: { id: 'x', name: 'Vcl Hùng' }, text: 'vk' });
  assert.equal(st().top.vk[0].name, 'Một bạn');
});
