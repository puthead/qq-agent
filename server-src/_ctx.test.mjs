/**
 * 上下文自测：引用解码 / 自己的话入账 / 私聊历史 / 表情包记账
 *   node src/_context.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const ok = (msg) => { n++; console.log('  ✓ ' + msg); };

// ── 假 WebSocket ─────────────────────────────────────────────
const sockets = [];
class FakeWS {
  constructor(url) { this.url = url; this.handlers = {}; sockets.push(this); }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); }
  close() { this.emit('close'); }
  terminate() {}
  send() {}
}
globalThis.WebSocket = FakeWS;

const { OneBot } = await import('./transport-onebot.js');
const { handleTurn, sendStickers } = await import('./index.js');
const { Memory } = await import('./memory.js');
const { GroupContext } = await import('./group-context.js');

const newBot = (opts = {}) => new OneBot({ wsUrl: 'ws://t', httpUrl: 'http://t', reconnectMs: 600000, ...opts });

// ── 1. 引用：查得到、认得出是不是我说的 ──────────────────────
{
  const got = [];
  const bot = newBot({ onMessage: (m) => got.push(m) });
  await sleep(20);
  const sock = sockets.at(-1);
  sock.emit('open');
  sock.emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 999 }));

  bot.api = async () => ({
    ok: true,
    data: { status: 'ok', data: { message_id: 'q1', user_id: 999, sender: { nickname: '小助手' }, message: [{ type: 'image', data: { file: 'a.png' } }], time: 1792500000 } },
  });
  sock.emit('message', JSON.stringify({
    post_type: 'message', self_id: 999, message_type: 'private', user_id: 111, message_id: 'm1',
    sender: { nickname: '主人' },
    message: [{ type: 'reply', data: { id: 'q1' } }, { type: 'text', data: { text: '你发这个图什么意思' } }],
  }));
  await sleep(30);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '你发这个图什么意思', '引用段不该混进正文');
  assert.equal(got[0].isQuoteMe, true, '引用了我的消息要认出来');
  assert.equal(got[0].quoted.isSelf, true);
  assert.equal(got[0].quoted.hasImage, true);
  assert.equal(got[0].quoted.text, '[图片]');

  bot.api = async () => ({
    ok: true,
    data: { status: 'ok', data: { message_id: 'q2', user_id: 222, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '今晚吃啥' } }] } },
  });
  sock.emit('message', JSON.stringify({
    post_type: 'message', self_id: 999, message_type: 'group', group_id: 7, user_id: 111, message_id: 'm2',
    sender: { nickname: '主人' },
    message: [{ type: 'reply', data: { id: 'q2' } }, { type: 'text', data: { text: '就这个' } }],
  }));
  await sleep(30);
  assert.equal(got.length, 2);
  assert.equal(got[1].quoted.isSelf, false);
  assert.equal(got[1].quoted.text, '今晚吃啥', '被引用的原话要能拿到');
  assert.equal(got[1].isQuoteMe, false);

  bot.api = async () => ({ ok: false, error: 'timeout' });
  sock.emit('message', JSON.stringify({
    post_type: 'message', self_id: 999, message_type: 'private', user_id: 111, message_id: 'm3',
    sender: { nickname: '主人' },
    message: [{ type: 'reply', data: { id: 'q9' } }, { type: 'text', data: { text: '嗯？' } }],
  }));
  await sleep(30);
  assert.equal(got.length, 3, '查询失败也要把消息交上来');
  assert.equal(got[2].quoted, null);
  assert.equal(got[2].text, '嗯？');
  ok('引用：自己发的能认出来，别人的能读到原话，查不到也不卡住');
}

// ── 2. 自己这个号发出去的消息要交上来 ────────────────────────
{
  const self = [];
  const got = [];
  const bot = newBot({ onMessage: (m) => got.push(m), onSelfMessage: (m) => self.push(m) });
  await sleep(20);
  const sock = sockets.at(-1);
  sock.emit('open');
  sock.emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 999 }));

  sock.emit('message', JSON.stringify({
    post_type: 'message_sent', self_id: 999, message_type: 'private', user_id: 111, message_id: 's1',
    sender: { nickname: '小助手' }, message: [{ type: 'image', data: { file: 'x.png' } }],
  }));
  await sleep(20);
  assert.equal(self.length, 1);
  assert.equal(self[0].text, '[图片]');
  assert.equal(self[0].key, 'private:111');
  assert.equal(got.length, 0, '自己发的不该当成对方说话');

  bot.api = async () => ({ ok: true, data: { status: 'ok', data: { message_id: 'own1' } } });
  await bot.send('private:111', '我自己说的');
  sock.emit('message', JSON.stringify({
    post_type: 'message_sent', self_id: 999, message_type: 'private', user_id: 111, message_id: 'own1',
    sender: { nickname: '小助手' }, message: [{ type: 'text', data: { text: '我自己说的' } }],
  }));
  await sleep(20);
  assert.equal(self.length, 1, '自己 API 发过的不要再记一遍');
  ok('自己的发送：手机发的会记账，API 发的不重复记');
}

// ── 3. 记忆：按会话取最近的原话 ──────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const m = new Memory({ dir });
  m.logTurn({ where: 'private:1', who: '主人', text: '话题A', reply: '回复A' });
  m.logTurn({ where: 'group:2', who: '甲', text: '群里的话', reply: '嗯' });
  m.logTurn({ where: 'private:1', who: '主人', text: '话题B', reply: '回复B' });
  assert.equal(m.recentTurns(10, { where: 'private:1' }).length, 2, '只取这个会话');
  assert.equal(m.recentTurns(10, { excludeWhere: 'private:1' }).length, 1, '排除这个会话');
  assert.ok(m.renderRecent(10, { where: 'private:1' }).includes('话题B'));
  ok('记忆：按会话过滤');
}

// ── 4. 一轮回复：私聊历史进 messages、引用进 situation、表情包记账 ──
{
  const key = 'private:111';
  const rows = [
    { t: Date.now() - 5000, where: 'group:2', who: '甲', text: '群里的话', reply: '嗯' },
    { t: Date.now() - 3000, where: key, who: '主人', text: '话题A', reply: '回复A' },
    { t: Date.now() - 1000, where: key, who: '主人', text: '话题B', reply: '回复B' },
  ];
  const logged = [];
  const memory = {
    touch() {},
    recentTurns: (n, opts = {}) => {
      let r = rows;
      if (opts.where) r = r.filter((x) => x.where.startsWith(opts.where));
      if (opts.excludeWhere) r = r.filter((x) => !x.where.startsWith(opts.excludeWhere));
      return r.slice(-n);
    },
    logTurn: (rec) => logged.push(rec),
  };
  const book = { maxPerTurn: 1, gapMs: 0, segment: () => ({ type: 'image', data: { file: 'base64://xx' } }), markSent() {} };
  let seen = null;
  let answer = { text: '回复C', usedTools: [], reasoning: '' };
  const brain = { reply: async (a) => { seen = a; return { ...answer, actions: answer.actions || [] }; } };
  const human = { say: async (out) => ({ sent: 1, parts: [out] }) };
  const bot = { imageToDataUrl: async () => null, setTyping() {}, send: async () => ({ ok: true }), sendSegments: async () => ({ ok: true }) };
  const waker = { wake() {} };
  const cfg = { vision: { enabled: false, maxBytes: 1 }, dryRun: false, ownerIds: ['111'] };

  const items = [{
    key, isGroup: false, name: '主人', userId: '111', text: '你发这个图什么意思', messageId: 'm9', images: [],
    quoted: { isSelf: true, text: '[图片]', hasImage: true, name: '小助手' },
  }];

  await handleTurn({ bot, brain, human, memory, waker, gate: null, groupCtx: null }, items, cfg);
  assert.equal(seen.history.length, 4, '私聊历史要传给模型，实际 ' + seen.history.length);
  assert.ok(!seen.history.some((h) => h.text === '群里的话'), '别的群的话不该混进来');
  assert.deepEqual(seen.history.map((h) => h.isSelf), [false, true, false, true]);
  assert.equal(seen.history.at(-1).text, '回复B', '最近一条是我上次说的话');
  assert.ok(seen.situation.includes('他引用了你自己之前发的那一条：[图片]'), seen.situation);
  assert.ok(seen.situation.includes('你在跟你主人（主人）私聊'), seen.situation);
  assert.deepEqual(seen.images, [], '没开看图就不该有图');

  answer = { text: '', actions: [{ type: 'sticker', id: '开心' }], usedTools: [], reasoning: '' };
  brain.stickers = book;
  await handleTurn({ bot, brain, human, memory, waker, gate: null, groupCtx: null }, items, cfg);
  const rec = logged.find((r) => String(r.reply || '').includes('[表情包]'));
  assert.ok(rec, '发出去的表情包要记一笔：' + JSON.stringify(logged));
  assert.equal(rec.where, key);
  assert.equal(rec.reply, '[表情包] 开心');
  assert.equal(rec.text, '');
  ok('一轮：历史进 messages、引用进 situation、表情包入账');
}

// ── 4.5 引用里的图：要真的送进 vision，不是只给一句「[图片]」 ──
{
  const calls = [];
  const got = [];
  const brain = { reply: async (a) => { got.push(a); return { text: '这是斯卡蒂吧', usedTools: [], reasoning: '', actions: [] }; } };
  const human = { say: async (out) => ({ sent: 1, parts: [out] }) };
  const bot = {
    imageToDataUrl: async (d) => { calls.push(d.file || d.url || ''); return 'data:image/gif;base64,AAAA'; },
    setTyping() {}, send: async () => ({ ok: true }), sendSegments: async () => ({ ok: true }),
  };
  const memory = { touch() {}, recentTurns: () => [], logTurn() {} };
  const cfg = { vision: { enabled: true, maxBytes: 1e6 }, dryRun: false };
  const turn = (items) => handleTurn({ bot, brain, human, memory, waker: { wake() {} }, gate: null, groupCtx: null }, items, cfg);

  // 他引用了一张别人的图问你「是你吗」——这轮自己没发图，图只在引用里
  await turn([{
    key: 'group:207483783', isGroup: true, name: '小高', userId: '1', text: '这个图片你能看见吗？是你吗',
    messageId: 'm20', images: [], replyTo: '2132746844',
    quoted: {
      id: '2132746844', isSelf: false, name: '忍耐蛋', text: '[图片·动画表情]', hasImage: true,
      images: [{ file: '7F9D.gif', url: 'http://x/7F9D.gif', summary: '[动画表情]' }],
    },
  }]);
  assert.deepEqual(calls, ['7F9D.gif'], '被引用的图要真的去取：' + JSON.stringify(calls));
  assert.equal(got[0].images.length, 1, '引用图要进 vision');
  assert.ok(got[0].images[0].startsWith('data:image/gif'), '取到的图原样传上去');
  assert.ok(got[0].situation.includes('他引用了「忍耐蛋」的那一条：[图片·动画表情]'), got[0].situation);
  assert.ok(got[0].situation.includes('后 1 张是他引用的'), got[0].situation);

  // 有 reply 段但那条查不到：要交代一句，别当没发生
  await turn([{ key: 'group:9', isGroup: true, name: '甲', userId: '2', text: '这个呢', messageId: 'm21', images: [], replyTo: 'q9', quoted: null }]);
  assert.ok(got[1].situation.includes('查不到'), got[1].situation);
  assert.deepEqual(got[1].images, [], '查不到就别硬塞图');

  // 这一轮自己发的图 + 引用图一起：总数不超过 4，引用图最多占两席
  await turn([{
    key: 'group:9', isGroup: true, name: '甲', userId: '2', text: '看看这俩', messageId: 'm22',
    images: [{ file: 'a.png' }, { file: 'b.png' }],
    quoted: { id: 'q3', isSelf: true, name: '小助手', text: '', hasImage: true, images: [{ file: 'q1.png' }, { file: 'q2.png' }] },
  }]);
  assert.equal(got[2].images.length, 4, '总数压在 4 张，实际 ' + got[2].images.length);
  assert.ok(got[2].situation.includes('前 2 张是他这轮发的'), got[2].situation);
  assert.ok(got[2].situation.includes('后 2 张是他引用的'), got[2].situation);

  // 这一轮图很多：引用还能露一张，剩下的照实说没取到，别编
  await turn([{
    key: 'group:9', isGroup: true, name: '甲', userId: '2', text: '一堆图', messageId: 'm23',
    images: [{ file: 'a.png' }, { file: 'b.png' }, { file: 'c.png' }],
    quoted: { id: 'q4', isSelf: false, name: '乙', text: '[图片]', hasImage: true, images: [{ file: 'q5.png' }, { file: 'q6.png' }] },
  }]);
  assert.equal(got[3].images.length, 4, '还是 4 张上限，实际 ' + got[3].images.length);
  assert.ok(got[3].situation.includes('后 1 张是他引用的'), got[3].situation);
  assert.ok(got[3].situation.includes('另有 1 张没取到'), got[3].situation);
  ok('引用图：进 vision、查不到会说明、总张数有上限');
}

// ── 5. 群聊：表情包也要进群背景 ──────────────────────────────
{
  const { GroupContext } = await import('./group-context.js');
  const gc = new GroupContext({ maxMessages: 10, maxChars: 400 });
  const logged = [];
  const memory = { touch() {}, recentTurns: () => [], logTurn: (r) => logged.push(r) };
  const book = { maxPerTurn: 1, gapMs: 0, segment: () => ({ type: 'image', data: { file: 'base64://xx' } }), markSent() {} };
  const brain = {
    stickers: book,
    reply: async () => ({ text: '', actions: [{ type: 'sticker', id: '得意' }], usedTools: [], reasoning: '' }),
  };
  const bot = { imageToDataUrl: async () => null, sendSegments: async () => ({ ok: true }) };
  const cfg = { vision: { enabled: false, maxBytes: 1 }, dryRun: false };
  const human = { say: async () => ({ sent: 0, parts: [] }) };
  const items = [{ key: 'group:3', isGroup: true, name: '甲', userId: '1', text: '小助手 来一张', messageId: 'g1', images: [] }];

  await handleTurn({ bot, brain, human, memory, waker: { wake() {} }, gate: null, groupCtx: gc }, items, cfg);
  assert.ok(gc.render('group:3', {}).includes('[表情包] 得意'), '群里自己发的图要进背景');
  assert.ok(logged.some((r) => r.reply === '[表情包] 得意'));
  ok('群聊：表情包进群背景');
}

// ── 6. 发送器回调（不改返回值，兼容老调用） ──────────────────
{
  const sent = [];
  const bot = { sendSegments: async (k, segs) => { sent.push(segs); return { ok: true }; } };
  const book = { maxPerTurn: 2, gapMs: 0, segment: () => ({ type: 'image', data: { file: 'base64://x' } }), markSent() {} };
  const ids = [];
  const count = await sendStickers(book, [{ type: 'sticker', id: '开心' }], { key: 'private:1', bot, onSent: (s) => ids.push(s.id) });
  assert.equal(count, 1);
  assert.deepEqual(ids, ['开心']);
  assert.equal(await sendStickers(book, [{ type: 'sticker', id: '开心' }], { key: 'private:1', bot, dryRun: true, onSent: () => ids.push('x') }), 0);
  assert.deepEqual(ids, ['开心'], '干跑不该回调');
  ok('发送器：onSent 回调，返回值不变');
}

// ── 7. 存图：把聊天里的图收进她自己的库 ─────────────────────
{
  const { StickerBook } = await import('./stickers.js');
  const { saveIncomingSticker } = await import('./index.js');
  const { runTool, stickerDefsFor } = await import('./tools.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stick-'));

  // 一张能通过 sniffImage 的最小 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const book = new StickerBook({ dir, gapMs: 0 });

  // 先放一张原有的，确认不会把她的旧图弄丢
  fs.writeFileSync(path.join(dir, '开心__高兴.jpg'), Buffer.concat([png, Buffer.from([9])]));
  assert.equal(book.size, 1);

  const first = book.save({ name: '猫猫无语', tags: ['无语'], buffer: png, mime: 'image/png' });
  assert.equal(first.ok, true);
  assert.equal(first.entry.id, '猫猫无语');
  assert.ok(fs.existsSync(path.join(dir, first.entry.file)), '文件要真的落盘');
  assert.ok(book.catalog().includes('猫猫无语'), '存完立刻能在清单里看到');

  const dup = book.save({ name: '另一个名字', tags: [], buffer: png, mime: 'image/png' });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true, '同一张图存两遍只留一份');
  assert.equal(book.size, 2);

  const png2 = Buffer.concat([png, Buffer.from([0])]);
  const clash = book.save({ name: '猫猫无语', tags: ['好笑'], buffer: png2, mime: 'image/png' });
  assert.equal(clash.entry.id, '猫猫无语2', '重名自动加序号');

  // 工具：走 saveImage 通道
  const seen = [];
  const toolOut = await runTool('save_sticker', { name: '猫猫笑了', tags: '好笑,开心' }, {
    stickers: book,
    saveImage: async (a) => { seen.push(a); return '存好了，叫「' + a.name + '」。'; },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { name: '猫猫笑了', tags: '好笑,开心', imageIndex: 1 });
  assert.ok(toolOut.includes('猫猫笑了'));
  assert.match(await runTool('save_sticker', { name: 'x' }, { stickers: book }), /这轮没有可保存的图片候选/, '无本轮候选不应否认整体存图能力');

  // 一轮里：别人发的图 + 她决定存
  const calls = [];
  const bot = {
    imageToDataUrl: async () => 'data:image/png;base64,xx',
    imageBytes: async (seg) => { calls.push(seg); return { buffer: Buffer.concat([png2, Buffer.from([7])]), mime: 'image/png' }; },
    send: async () => ({ ok: true }),
  };
  const said = await saveIncomingSticker({ bot, book, seg: { file: 'a.png', url: 'http://x/a.png' }, name: '那个图', tags: '好笑' });
  assert.ok(said.includes('存好了'), said);
  assert.equal(calls.length, 1, '真的去取图了');
  assert.ok(book.catalog().includes('那个图'));
  assert.ok((await saveIncomingSticker({ bot, book, seg: null, name: 'x' })).includes('没人发图'), '没图时别硬存');

  // 干跑不落盘
  const before = book.size;
  assert.ok((await saveIncomingSticker({ bot, book, seg: { file: 'b.png' }, name: '干跑图', dryRun: true })).includes('干跑'));
  assert.equal(book.size, before);

  // 只有开了存图通道才给工具
  assert.ok(!stickerDefsFor(book).some((d) => d.function.name === 'save_sticker'));
  assert.ok(stickerDefsFor(book, { canSave: true }).some((d) => d.function.name === 'save_sticker'));
  ok('存图：落盘、去重、重名、工具、干跑都对');
}

// ── 4.6 认人：主人换个群名片还认得出 ──
{
  const cfg = { vision: { enabled: false, maxBytes: 1 }, dryRun: false, ownerIds: ['O1'] };
  const seen = [];
  const brain = { reply: async (a) => { seen.push(a); return { text: '嗯', usedTools: [], reasoning: '', actions: [] }; } };
  const human = { say: async (out) => ({ sent: 1, parts: [out] }) };
  const bot = { imageToDataUrl: async () => null, setTyping() {}, send: async () => ({ ok: true }), sendSegments: async () => ({ ok: true }) };
  const memory = { touch() {}, recentTurns: () => [], logTurn() {} };
  const waker = { wake() {} };
  const groupCtx = new GroupContext({ enabled: true });
  const turn = (items) => handleTurn({ bot, brain, human, memory, waker, gate: null, groupCtx }, items, cfg);

  groupCtx.add('group:9', { messageId: 'a1', name: '老王', userId: 'O1', text: '在吗' });
  groupCtx.add('group:9', { messageId: 'a2', name: '小高', userId: 'X2', text: '我也在' });

  await turn([{ key: 'group:9', isGroup: true, groupId: '9', name: '老王', userId: 'O1', text: '小助手 帮我看看', messageId: 'b1', images: [] }]);
  assert.ok(seen[0].text.includes('老王（你主人）：'), '主人说话要标出来：' + seen[0].text);
  assert.ok(seen[0].situation.includes('群名片是「老王」'), seen[0].situation);
  assert.ok(seen[0].situation.includes('老王（你主人）：在吗'), '背景里也得认得出：' + seen[0].situation);

  await turn([{ key: 'group:9', isGroup: true, groupId: '9', name: '小高', userId: 'X2', text: '@小助手 你在吗', messageId: 'b2', images: [] }]);
  assert.ok(!seen[1].text.includes('（你主人）'), '群友不该被标成主人：' + seen[1].text);
  assert.ok(seen[1].situation.includes('不是你主人'), seen[1].situation);

  await turn([{ key: 'private:O1', isGroup: false, name: '阿杰', userId: 'O1', text: '在吗', messageId: 'c1', images: [] }]);
  assert.ok(seen[2].situation.includes('你在跟你主人（阿杰）私聊'), seen[2].situation);
  await turn([{ key: 'private:Z9', isGroup: false, name: '主人', userId: 'Z9', text: '我是你主人', messageId: 'c2', images: [] }]);
  assert.ok(seen[3].situation.includes('不是你主人'), '光自称主人不算：' + seen[3].situation);

  // 名片账本：同一个号在不同群两张名片，都不丢
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  const m = new Memory({ dir });
  m.noteAlias('O1', { groupId: '9', name: '老王' });
  m.noteAlias('O1', { groupId: '10', name: '阿杰' });
  const book = m.renderPerson('O1');
  assert.ok(book.includes('9:老王') && book.includes('10:阿杰'), book);
  m.remember('O1', { fact: '他怕打雷' });
  assert.ok(m.renderPerson('O1').includes('9:老王'), '写别的账不能把名片冲掉');
  ok('认人：只认号，群名片只用来称呼');
}

console.log('\n上下文自测通过，' + n + ' 项。');
process.exit(0);
