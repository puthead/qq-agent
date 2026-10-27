/**
 * 说话额度自测：每分钟最多 3 条 / 分条不顶穿 / 表情包占额度 / 引用前文
 *   node src/_limits.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpeechBudget } from './throttle.js';
import { Humanizer } from './humanize.js';
import { GroupContext } from './group-context.js';
import { StickerBook } from './stickers.js';
import { handleTurn, sendStickers } from './index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const ok = (msg) => { n++; console.log('  ✓ ' + msg); };

// ── 1. 额度：按会话、滚动窗口、三个就满 ─────────────────────
{
  const b = new SpeechBudget({ perMinute: 3, windowMs: 1000 });
  assert.equal(b.left('private:1'), 3);
  b.record('private:1', 2);
  assert.equal(b.left('private:1'), 1, '发两条只剩一条');
  b.record('private:1', 1);
  assert.equal(b.check('private:1').ok, false, '三条之后要拦住');
  assert.equal(b.left('private:2'), 3, '别的会话不受影响');
  await sleep(1100);
  assert.equal(b.left('private:1'), 3, '窗口滚过去要恢复');
  b.record('group:9', 1);
  b.reset('group:9');
  assert.equal(b.left('group:9'), 3);
  ok('额度：满三条就停、跨会话隔离、窗口会滚');
}

// ── 2. 分条：额度只剩两条时，四句并成两条 ───────────────────
{
  const h = new Humanizer({ enabled: false, burstMax: 4 });
  const long = '第一句话比较长一点点\n第二句话也比较长一点点\n第三句话还是长\n第四句话同样长';
  assert.equal(h.split(long, 4).length, 4, '四句正常拆四条');
  const parts = h.split(long, 2);
  assert.equal(parts.length, 2, '额度两条时并成两条');
  assert.ok(parts[1].includes('第二句话'), parts[1]);

  const sent = [];
  const r = await h.say(long, { send: async (m) => sent.push(m), maxMessages: 2 });
  assert.equal(r.sent, 2);
  assert.equal(sent.length, 2);

  const arr = await h.say(['一', '二', '三'], { send: async () => {}, maxMessages: 2 });
  assert.deepEqual(arr.parts, ['一', '二 三'], '数组进来也要按额度合并');
  ok('分条：额度不够就把剩下的并成一条');
}

// ── 3. 引用前文：被引用那句之前的群里的话 ────────────────────
{
  const gc = new GroupContext({ enabled: true });
  gc.add('group:1', { messageId: 'm1', name: '甲', userId: 'O1', text: '前一句' });
  gc.add('group:1', { messageId: 'm2', name: '乙', userId: 'U2', text: '被引用的那句' });
  gc.add('group:1', { messageId: 'm3', name: '甲', userId: 'O1', text: '后面的话' });

  const rows = gc.contextBefore('group:1', 'm2', { before: 2, ownerIds: ['O1'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '前一句');
  assert.equal(rows[0].isOwner, true, '主人要标出来');
  assert.deepEqual(gc.contextBefore('group:1', 'nope'), [], '查不到就返回空');
  assert.deepEqual(gc.contextBefore('group:1', 'm1'), [], '第一条没有前文');
  ok('引用前文：取前两句、认主人、查不到不瞎编');
}

// ── 4. 表情包也占额度：没额度就一张都不发 ────────────────────
{
  const book = { maxPerTurn: 1, gapMs: 0, segment: () => ({ type: 'image', data: {} }), markSent() {} };
  let calls = 0;
  const bot = { sendSegments: async () => { calls++; return { ok: true }; } };
  assert.equal(await sendStickers(book, [{ type: 'sticker', id: '开心' }], { key: 'private:1', bot, limit: 0 }), 0);
  assert.equal(calls, 0, '额度为零别发图');
  assert.equal(await sendStickers(book, [{ type: 'sticker', id: '开心' }], { key: 'private:1', bot, limit: 1 }), 1);
  assert.equal(calls, 1);
  ok('表情包：占额度，没额度就不发');
}

// ── 5. 一轮：三条额度发完，下一轮不再调模型 ─────────────────
{
  const key = 'private:1';
  const cfg = { vision: { enabled: false, maxBytes: 1 }, dryRun: false, ownerIds: ['1'], limits: { perMinute: 3 } };
  const budget = new SpeechBudget({ perMinute: 3 });
  budget.record(key, 1); // 刚才已经说过一条，只剩两条

  const sent = [];
  const bot = {
    imageToDataUrl: async () => null,
    setTyping() {},
    send: async (m) => { sent.push(m); return { ok: true }; },
    sendSegments: async () => ({ ok: true }),
  };
  let brainCalls = 0;
  const brain = {
    reply: async () => {
      brainCalls++;
      return {
        text: '第一句话比较长一点点\n第二句话也比较长一点点\n第三句话还是长\n第四句话同样长',
        usedTools: [], reasoning: '', actions: [],
      };
    },
  };
  const human = new Humanizer({ enabled: false });
  const memory = { touch() {}, recentTurns: () => [], logTurn() {} };
  const items = [{ key, isGroup: false, name: '主人', userId: '1', text: '说四句', messageId: 'x1', images: [] }];
  const turn = () => handleTurn(
    { bot, brain, human, memory, waker: { wake() {} }, gate: null, budget, groupCtx: null },
    items, cfg,
  );

  await turn();
  assert.equal(brainCalls, 1);
  assert.equal(sent.length, 2, '只剩两条额度，四句要并成两条，实际 ' + sent.length);
  assert.equal(budget.left(key), 0, '三条用完');

  await turn();
  assert.equal(brainCalls, 1, '额度用完不该再调模型');
  assert.equal(sent.length, 2, '一条都不能多发');
  ok('一轮：额度剩两条就发两条，用完下一轮直接闭嘴');
}

// ── 6. 表情包默认不做冷却 ───────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stick-cool-'));
  const book = new StickerBook({ dir });
  assert.equal(book.cooldownMs, 0);
  book.markSent('private:1');
  assert.equal(book.canSend('private:1').ok, true);
  ok('表情包：默认无冷却，刚发过也能继续');
}

// ── 7. 想发图时正文留一条：两条额度 = 一条字 + 一张图 ────────
{
  const key = 'private:2';
  const cfg = { vision: { enabled: false, maxBytes: 1 }, dryRun: false, ownerIds: ['2'], limits: { perMinute: 3 } };
  const budget = new SpeechBudget({ perMinute: 3 });
  budget.record(key, 1); // 只剩两条
  const sent = [];
  const pics = [];
  const bot = {
    imageToDataUrl: async () => null,
    setTyping() {},
    send: async (m) => { sent.push(m); return { ok: true }; },
    sendSegments: async (_k, seg) => { pics.push(seg); return { ok: true }; },
  };
  const brain = {
    reply: async () => ({
      text: '第一句话比较长一点点\n第二句话也比较长一点点\n第三句话还是长',
      usedTools: [], reasoning: '', actions: [{ type: 'sticker', id: '开心' }],
    }),
  };
  const book = { maxPerTurn: 1, gapMs: 0, size: 1, segment: () => ({ type: 'image', data: {} }), markSent() {} };
  brain.stickers = book;
  await handleTurn(
    { bot, brain, human: new Humanizer({ enabled: false }),
      memory: { touch() {}, recentTurns: () => [], logTurn() {} },
      waker: { wake() {} }, gate: null, budget, groupCtx: null },
    [{ key, isGroup: false, name: '主人', userId: '2', text: '说三句再发图', messageId: 'x2', images: [] }],
    cfg,
  );
  assert.equal(sent.length, 1, '两条额度里正文只占一条，实际 ' + sent.length);
  assert.equal(pics.length, 1, '剩下一条留给表情包');
  assert.equal(budget.left(key), 0);
  ok('表情包：正文给它留一条，两条额度一条字一张图');
}

console.log('\n说话额度自测通过，' + n + ' 项。');
process.exit(0);
