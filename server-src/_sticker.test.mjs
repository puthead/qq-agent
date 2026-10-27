/**
 * 表情包自测
 * ─────────────────────────────────────────────────────────────
 *   node src/_sticker.test.mjs
 *
 * 不连网、不连 QQ：假的 bot 只记下"收到了什么段"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StickerBook, parseStickerName } from './stickers.js';
import { stickerDefsFor, runTool } from './tools.js';
import { sendStickers } from './index.js';

let n = 0;
const ok = (msg) => { n++; console.log('  ✓ ' + msg); };

// ── 文件名解析 ────────────────────────────────────────────────
{
  assert.deepEqual(parseStickerName('生气__炸毛,不爽.png'), { id: '生气', tags: ['炸毛', '不爽'] });
  assert.deepEqual(parseStickerName('哭哭.png'), { id: '哭哭', tags: [] });
  assert.deepEqual(parseStickerName('委屈__想哭、难过.jpg'), { id: '委屈', tags: ['想哭', '难过'] });
  ok('文件名 → id/标签');
}

// ── 建一个假目录 ──────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-'));
const png = (name) => fs.writeFileSync(path.join(dir, name), Buffer.from('fake-bytes-' + name));
png('开心__高兴,好耶.png');
png('生气__炸毛,不爽.png');
png('cry.jpg');
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([{ id: '委屈', file: 'cry.jpg', tags: ['想哭'], desc: '眼圈红红' }]));
fs.writeFileSync(path.join(dir, 'notes.txt'), '不是图，不该被收进来');

const book = new StickerBook({ dir, cooldownMs: 60000, maxPerTurn: 1, gapMs: 0 });
assert.equal(book.size, 3);
assert.ok(book.catalog().includes('开心(高兴/好耶)'), book.catalog());
assert.ok(book.catalog().includes('委屈(想哭)'), 'index.json 覆盖生效');
ok('扫目录：只收图，index.json 能改名');

// ── 挑图：容忍各种写法 ────────────────────────────────────────
for (const q of ['开心', '开心.png', '「开心」', '开心(高兴)', '好耶', '委屈', '想哭']) {
  assert.ok(book.pick(q), '应该能挑到：' + q);
}
assert.equal(book.pick('不存在'), null);
ok('pick 容忍扩展名/引号/括号/标签');

// ── 冷却 ─────────────────────────────────────────────────────
const key = 'private:10001';
assert.equal(book.canSend(key).ok, true);
book.markSent(key);
const cd = book.canSend(key);
assert.equal(cd.ok, false);
assert.ok(cd.leftMs > 0 && cd.leftMs <= 60000);
ok('同一会话发过一张后要等冷却');

// ── 消息段 ───────────────────────────────────────────────────
const seg = book.segment('开心');
assert.equal(seg.type, 'image');
assert.ok(seg.data.file.startsWith('base64://'));
const decoded = Buffer.from(seg.data.file.slice('base64://'.length), 'base64').toString();
assert.equal(decoded, 'fake-bytes-开心__高兴,好耶.png');
ok('图片转成 base64 消息段');

// ── 工具声明 ─────────────────────────────────────────────────
const defs = stickerDefsFor(book);
assert.equal(defs.length, 1);
assert.equal(defs[0].function.name, 'send_sticker');
assert.ok(defs[0].function.description.includes('stickers目录'));
assert.equal(stickerDefsFor(null).length, 0);
assert.equal(stickerDefsFor({ size: 0 }).length, 0);
ok('有表情包才给工具，清单写进 description');

// ── runTool ─────────────────────────────────────────────────
const ctx = { stickers: book, actions: [], key: 'private:20002' };
let r = await runTool('send_sticker', { id: '生气' }, ctx);
assert.equal(JSON.parse(r).status, 'queued');
assert.equal(ctx.actions.length, 1);
assert.equal(ctx.actions[0].type, 'sticker');
r = await runTool('send_sticker', { id: '开心' }, ctx);
assert.equal(JSON.parse(r).status, 'already_queued');
assert.equal(ctx.actions.length, 1);
r = await runTool('send_sticker', { id: '不存在的图' }, { stickers: book, actions: [], key: 'private:30003' });
assert.ok(r.includes('没有这个表情包'), r);
assert.ok((await runTool('send_sticker', { id: '开心' }, { actions: [] })).includes('没有表情包可发'));
ok('工具：发一张、每轮封顶、不认识的名字会说清单');

// 冷却期内再发
book.markSent('private:40004');
r = await runTool('send_sticker', { id: '开心' }, { stickers: book, actions: [], key: 'private:40004' });
assert.ok(r.includes('刚发过'), r);
ok('工具：冷却期内只说话不发图');

// ── 发送器 ───────────────────────────────────────────────────
const sent = [];
const bot = {
  async sendSegments(k, segs) { sent.push({ k, segs }); return { ok: true }; },
};
const actions = [
  { type: 'sticker', id: '开心', path: path.join(dir, '开心__高兴,好耶.png') },
  { type: 'sticker', id: '生气', path: path.join(dir, '生气__炸毛,不爽.png') },
];
const book2 = new StickerBook({ dir, gapMs: 0, maxPerTurn: 1 });
const count = await sendStickers(book2, actions, { key: 'private:50005', bot });
assert.equal(count, 1, 'maxPerTurn=1 只发一张');
assert.equal(sent.length, 1);
assert.equal(sent[0].segs[0].type, 'image');
assert.equal(book2.canSend('private:50005').ok, true, '默认没有表情包冷却');
assert.equal(await sendStickers(null, actions, { key, bot }), 0);
assert.equal(await sendStickers(book2, [], { key, bot }), 0);
ok('发送器：单轮封顶、默认无冷却、没有书/没有动作都不炸');

// 连续两轮经过真实工具和发送器；只模拟 QQ 通道，不等计时器。
for (const scope of ['private:60006', 'group:60006']) {
  const noCooldown = new StickerBook({ dir, cooldownMs: 0, gapMs: 0 });
  const description = stickerDefsFor(noCooldown)[0].function.description;
  assert.ok(description.includes('没有冷却时间'));
  const before = sent.length;
  for (const id of ['开心', '生气']) {
    const turn = { stickers: noCooldown, actions: [], key: scope };
    assert.equal(JSON.parse(await runTool('send_sticker', { id }, turn)).status, 'queued');
    assert.equal(await sendStickers(noCooldown, turn.actions, { key: scope, bot, limit: 1 }), 1);
  }
  assert.equal(sent.length - before, 2, '两轮都应送到 QQ 通道');
  assert.equal(sent.at(-1).segs[0].type, 'image');
  ok(scope.split(':')[0] + '：零冷却连续两轮均真实生成并发送图片段');
}

console.log('\n表情包自测通过，' + n + ' 项。');
process.exit(0);
