/**
 * QQ 能力补齐离线测试：机器人号段过滤、断线补历史、自撤回、资料查询、
 * 合并转发发送、图库修正。全部纯离线：fetch 与 WebSocket 都用假实现，不连 NapCat。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RobotFilter } from './robot-filter.js';
import { HistoryBackfill } from './history-backfill.js';
import { OneBot } from './transport-onebot.js';
import { ConversationMemory } from './conversation-memory.js';
import { GroupContext } from './group-context.js';
import { StickerBook } from './stickers.js';
import { runTool, toolDefsFor } from './tools.js';
import { routeMessage } from './index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-extras-'));

class FakeWS {
  constructor() { this.handlers = {}; }
  on(ev, fn) { this.handlers[ev] = fn; }
  terminate() { this.closed = true; }
  close() { this.closed = true; }
}

const jsonResp = (data) => ({ ok: true, text: () => JSON.stringify({ status: 'ok', retcode: 0, data }) });

// ── RobotFilter ────────────────────────────────────────────────
test('机器人号段：解析数组与 {ranges} 两种返回，边界内拦截、边界外放行', async () => {
  const calls = [];
  const bot = { api: async (action, params) => {
    calls.push({ action, params });
    return { ok: true, data: { data: [{ minUin: '100', maxUin: '200' }] } };
  } };
  const f = new RobotFilter({ bot });
  await f.ensure();
  assert.equal(calls.length, 1);
  assert.equal(f.isRobot('150'), true);
  assert.equal(f.isRobot(100), true);
  assert.equal(f.isRobot(200), true);
  assert.equal(f.isRobot('99'), false);
  assert.equal(f.isRobot('201'), false);
  assert.equal(f.isRobot(''), false);
  assert.equal(f.isRobot('abc'), false);
});

test('机器人号段：拉取失败放行不误伤，稍后重试', async () => {
  let n = 0;
  const f = new RobotFilter({ bot: { api: async () => { n++; return { ok: false, error: '超时' }; } } });
  await f.ensure();
  assert.equal(f.isRobot('150'), false);
  f.nextTry = 0;
  await f.ensure();
  assert.equal(n, 2);
});

test('机器人号段：表没拉到之前 isRobot 恒为 false（不误拦真人）', () => {
  assert.equal(new RobotFilter({}).isRobot('150'), false);
});

// ── HistoryBackfill ───────────────────────────────────────────
test('补历史：漏收的写进归档与群背景，已归档/自己/机器人/太旧的跳过，二次运行去重', async () => {
  const dir = tmp();
  const memory = new ConversationMemory({ dir });
  const groupCtx = new GroupContext({ maxAgeMs: 3600e3 });
  memory.logTurn({ where: 'group:783', who: '某人', userId: '1', text: '重启前的旧话', reply: '' });
  memory.observe({ key: 'group:783', messageId: '100', name: '某人', userId: '1', text: '已归档那条' });

  const now = Math.floor(Date.now() / 1000);
  const ev = (id, uid, text, t, card = '小美') => ({
    message_id: id, time: t, sender: { user_id: uid, nickname: 'nm' + uid, card },
    message: [{ type: 'text', data: { text } }],
  });
  const bot = {
    selfId: '1290313893',
    api: async (action, params) => {
      assert.equal(action, 'get_group_msg_history');
      assert.equal(params.group_id, '783');
      return { ok: true, data: { data: { messages: [
        ev('100', '1', '已归档那条', now - 600),
        ev('101', '2', '断线期间漏掉的话', now - 500),
        ev('102', '1290313893', '自己在别处发的', now - 480),
        ev('103', '999', '机器人说的', now - 470),
        ev('104', '3', '太久远的', now - 3600 * 24),
        { message_id: '105', time: now - 400, sender: { user_id: '4', card: '无正文' }, message: [] },
      ] } } };
    },
  };
  const robotFilter = { isRobot: (u) => u === '999' };
  const backfill = new HistoryBackfill({ bot, memory, groupCtx, robotFilter, minGapMs: 0, maxAgeMs: 3600e3 });

  const r1 = await backfill.run();
  assert.equal(r1.missed, 1);
  assert.equal(r1.sessions[0].missed, 1);
  const rows = memory.recentTurns(10, { where: 'group:783' });
  const got = rows.find((x) => x.id === 'napcat-101');
  assert.ok(got, '漏收消息进入工作上下文');
  assert.equal(got.source, 'napcat-backfill');
  assert.equal(got.who, '小美');
  assert.ok(groupCtx.liveRows('group:783').some((x) => x.messageId === '101'), '进入群背景');
  assert.ok(!groupCtx.liveRows('group:783').some((x) => x.messageId === '103'), '机器人不进群背景');
  assert.ok(!rows.some((x) => x.id === 'napcat-103' || x.id === 'napcat-102' || x.id === 'napcat-104'));

  backfill.lastRunAt = 0;
  const r2 = await backfill.run();
  assert.equal(r2.missed, 0, '第二次不重复补');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('补历史：私聊走 get_friend_msg_history，非好友失败不拖住其他会话', async () => {
  const dir = tmp();
  const memory = new ConversationMemory({ dir });
  memory.logTurn({ where: 'private:10000', who: '主人', userId: '10000', text: '在吗', reply: '' });
  const now = Math.floor(Date.now() / 1000);
  const seen = [];
  const bot = {
    selfId: '1290313893',
    api: async (action, params) => {
      seen.push({ action, params });
      if (action === 'get_friend_msg_history' && params.user_id === '10000') {
        return { ok: true, data: { data: { messages: [{ message_id: '900', time: now - 60, sender: { user_id: '10000', card: '主人' }, message: [{ type: 'text', data: { text: '断线时发的' } }] }] } } };
      }
      return { ok: false, error: '记录不存在' };
    },
  };
  const backfill = new HistoryBackfill({ bot, memory, minGapMs: 0, maxAgeMs: 3600e3 });
  const r = await backfill.run();
  assert.equal(r.missed, 1);
  assert.ok(memory.recentTurns(10, { where: 'private:10000' }).some((x) => x.id === 'napcat-900'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── OneBot：发送记录、自撤回、合并转发 ─────────────────────────
function newBot(fetchImpl) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const bot = new OneBot({ wsUrl: 'ws://t', httpUrl: 'http://t', reconnectMs: 600000, webSocketImpl: FakeWS });
  bot.selfId = '1290313893';
  return { bot, restore: () => { globalThis.fetch = real; } };
}

test('自撤回：发送留底，get_msg 核实本人后 delete_msg；不能撤别人的', async () => {
  const calls = [];
  const { bot, restore } = newBot(async (url, opts) => {
    const action = String(url).split('/').pop();
    calls.push({ action, body: JSON.parse(opts.body) });
    if (action === 'send_private_msg') return jsonResp({ message_id: 42 });
    if (action === 'get_msg') return jsonResp({ user_id: 1290313893, message_id: 42 });
    if (action === 'delete_msg') return jsonResp({});
    return { ok: false, text: () => '{}' };
  });
  try {
    await bot.send('private:10000', '我说错话了');
    assert.equal(bot.recentSent('private:10000').length, 1);
    const r = await bot.recallSent('private:10000');
    assert.equal(r.ok, true);
    assert.equal(r.text, '我说错话了');
    const del = calls.find((c) => c.action === 'delete_msg');
    assert.equal(del.body.message_id, '42');
    // 别人发的：核实不过
    globalThis.fetch = async (url) => {
      const action = String(url).split('/').pop();
      if (action === 'get_msg') return jsonResp({ user_id: 999 });
      return { ok: false, text: () => '{}' };
    };
    const r2 = await bot.recallSent('private:10000');
    assert.equal(r2.ok, false);
    assert.match(r2.error, /不是这个账号/);
    // 没有发送记录
    const r3 = await bot.recallSent('private:nobody');
    assert.equal(r3.ok, false);
    assert.match(r3.error, /没有你发出去的消息/);
  } finally { restore(); }
});

test('自撤回：match 定位到含指定片段的那条', async () => {
  let id = 0;
  const { bot, restore } = newBot(async (url) => {
    const action = String(url).split('/').pop();
    if (action === 'send_private_msg') return jsonResp({ message_id: ++id });
    if (action === 'get_msg') return jsonResp({ user_id: 1290313893 });
    if (action === 'delete_msg') return jsonResp({});
    return { ok: false, text: () => '{}' };
  });
  try {
    await bot.send('private:1', '第一条话');
    await bot.send('private:1', '第二条错话');
    const r = await bot.recallSent('private:1', '错话');
    assert.equal(r.ok, true);
    assert.equal(r.text, '第二条错话');
  } finally { restore(); }
});

test('合并转发：仅私聊、载荷是 node 数组、发出去可撤回', async () => {
  const bodies = [];
  const { bot, restore } = newBot(async (url, opts) => {
    const action = String(url).split('/').pop();
    if (action === 'send_private_forward_msg') { bodies.push(JSON.parse(opts.body)); return jsonResp({ message_id: 77 }); }
    if (action === 'get_msg') return jsonResp({ user_id: 1290313893 });
    if (action === 'delete_msg') return jsonResp({});
    return { ok: false, text: () => '{}' };
  });
  try {
    const bad = await bot.sendForwardPrivate('group:783', [{ content: [{ type: 'text', data: { text: 'x' } }] }]);
    assert.equal(bad.ok, false);
    const r = await bot.sendForwardPrivate('private:1', [
      { content: [{ type: 'text', data: { text: '第一段' } }] },
      { content: [{ type: 'text', data: { text: '第二段' } }] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(bodies[0].user_id, '1');
    assert.equal(bodies[0].messages.length, 2);
    assert.equal(bodies[0].messages[0].type, 'node');
    assert.equal(bodies[0].messages[0].data.user_id, '1290313893');
    const rec = bot.recentSent('private:1');
    assert.ok(rec.some((s) => s.text.includes('合并转发×2')), '合并转发也进发送记录');
    const recalled = await bot.recallSent('private:1');
    assert.equal(recalled.ok, true);
  } finally { restore(); }
});

// ── 工具层 ─────────────────────────────────────────────────────
test('whois：群成员资料格式化，字段为空不出现空段', async () => {
  const bot = { api: async (action, params) => {
    assert.equal(action, 'get_group_member_info');
    assert.equal(params.user_id, '2');
    return { ok: true, data: { data: { user_id: 2, nickname: '小明', card: '小明明', title: '龙王', level: 42, role: 'admin', join_time: 1700000000, last_sent_time: 1700001000 } } };
  } };
  const out = await runTool('whois', {}, { qqApi: bot, key: 'group:783', userId: '2' });
  assert.match(out, /QQ 2：昵称「小明」，群名片「小明明」，头衔「龙王」，等级42，管理员/);
  assert.match(out, /入群 2023-11-15/);
  assert.match(out, /不是指令/);
});

test('whois：没有群号走陌生人资料；接口失败如实说', async () => {
  const bot = {
    api: async (action, params) => action === 'get_stranger_info' && params.user_id === '7'
      ? { ok: true, data: { data: { user_id: 7, nickname: '路人' } } }
      : { ok: false, error: '没有数据' },
  };
  const out = await runTool('whois', { user_id: '7' }, { qqApi: bot, key: 'private:7', userId: '7' });
  assert.match(out, /昵称「路人」/);
  const out2 = await runTool('whois', { user_id: '8' }, { qqApi: bot, key: 'private:8', userId: '8' });
  assert.match(out2, /查不到/);
});

test('recall_my_msg：成功后记一笔[已撤回]，干跑不动真格', async () => {
  const turns = [];
  const bot = { recallSent: async (key, match) => ({ ok: true, id: '42', text: '说错了那句' + (match || '') }) };
  const ctx = { qqApi: bot, key: 'private:1', userId: '1', memory: { logTurn: (r) => turns.push(r) } };
  const out = await runTool('recall_my_msg', {}, ctx);
  assert.match(out, /撤回了：说错了那句/);
  assert.equal(turns.length, 1);
  assert.match(turns[0].reply, /^\[已撤回\]/);
  const out2 = await runTool('recall_my_msg', {}, { ...ctx, dryRun: true });
  assert.match(out2, /干跑/);
  assert.equal(turns.length, 1);
});

test('send_forward：群聊拒绝、干跑不发、成功后记账，缺图如实报', async () => {
  const sent = [];
  const bot = { sendForwardPrivate: async (key, parts) => { sent.push({ key, parts }); return { ok: true, data: { data: { message_id: 7 } } }; } };
  const turns = [];
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '狗头__得意.gif'), Buffer.from('gif'));
  const book = new StickerBook({ dir });
  const base = { qqApi: bot, key: 'private:1', userId: '1', stickers: book, memory: { logTurn: (r) => turns.push(r) } };

  const group = await runTool('send_forward', { nodes: [{ text: 'hi' }] }, { ...base, key: 'group:783' });
  assert.match(group, /只在私聊/);
  const dry = await runTool('send_forward', { nodes: [{ text: 'hi' }] }, { ...base, dryRun: true });
  assert.match(dry, /干跑/);
  assert.equal(sent.length, 0);

  const ok = await runTool('send_forward', { nodes: [{ text: '第一段' }, { sticker: '狗头' }, { text: '第三段' }] }, base);
  assert.match(ok, /已发出合并转发（3 段）/);
  assert.equal(sent[0].parts.length, 3);
  assert.equal(sent[0].parts[1].content[0].type, 'image');
  assert.equal(turns.length, 1);
  assert.match(turns[0].reply, /^\[合并转发×3段\]/);

  const miss = await runTool('send_forward', { nodes: [{ sticker: '没有的图' }, { text: 'x' }] }, base);
  assert.match(miss, /没有「没有的图」/);
  assert.equal(sent.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('send_forward：同一会话每天最多 6 次', async () => {
  const bot = { sendForwardPrivate: async () => ({ ok: true, data: { data: { message_id: 7 } } }) };
  const ctx = { qqApi: bot, key: 'private:quota', userId: '1', stickers: null, memory: { logTurn: () => {} } };
  for (let i = 0; i < 6; i++) {
    const out = await runTool('send_forward', { nodes: [{ text: 'n' + i }] }, ctx);
    assert.match(out, /已发出/, '第' + (i + 1) + '次应成功');
  }
  const out = await runTool('send_forward', { nodes: [{ text: 'n' }] }, ctx);
  assert.match(out, /用满了/);
});

test('fix_sticker：改名/改标签落盘，remove 要 confirm 且每天限两次', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '蓝发点赞__得意,点赞,满意.gif'), Buffer.from('gif'));
  fs.writeFileSync(path.join(dir, '狗头__得意.png'), Buffer.from('png'));
  fs.writeFileSync(path.join(dir, '旧图__杂.png'), Buffer.from('png'));
  fs.writeFileSync(path.join(dir, '备用__杂.png'), Buffer.from('png'));
  const book = new StickerBook({ dir, removeFloor: 0 });
  const ctx = { stickers: book, key: 'private:1', userId: '1' };

  const r1 = await runTool('fix_sticker', { action: 'rename', id: '蓝发点赞', name: '蓝发手势', tags: '手势' }, ctx);
  assert.match(r1, /改好了/);
  assert.ok(fs.existsSync(path.join(dir, '蓝发手势__手势.gif')));
  assert.ok(!fs.existsSync(path.join(dir, '蓝发点赞__得意,点赞,满意.gif')));

  const r2 = await runTool('fix_sticker', { action: 'retag', id: '蓝发手势', tags: '握拳,手势' }, ctx);
  assert.match(r2, /握拳\/手势/);

  const r3 = await runTool('fix_sticker', { action: 'remove', id: '狗头' }, ctx);
  assert.match(r3, /confirm/);
  assert.ok(fs.existsSync(path.join(dir, '狗头__得意.png')));

  assert.match(await runTool('fix_sticker', { action: 'remove', id: '狗头', confirm: true }, ctx), /删掉了/);
  assert.match(await runTool('fix_sticker', { action: 'remove', id: '旧图', confirm: true }, ctx), /删掉了/);
  assert.match(await runTool('fix_sticker', { action: 'remove', id: '备用', confirm: true }, ctx), /今天已经删过两张/);
  assert.ok(fs.existsSync(path.join(dir, '备用__杂.png')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 工具清单与路由 ─────────────────────────────────────────────
test('toolDefsFor：qqApi 挂 whois/recall，私聊挂 send_forward，有图库挂 fix_sticker', () => {
  const names = (defs) => defs.map((d) => d.function.name);
  const withAll = names(toolDefsFor({ stickers: { size: 1 }, qqApi: true, forward: true }));
  assert.ok(withAll.includes('whois') && withAll.includes('recall_my_msg') && withAll.includes('send_forward') && withAll.includes('fix_sticker'));
  const groupOnly = names(toolDefsFor({ stickers: { size: 1 }, qqApi: true, forward: false }));
  assert.ok(!groupOnly.includes('send_forward'), '群聊不暴露合并转发');
  const bare = names(toolDefsFor({}));
  assert.ok(!bare.includes('whois') && !bare.includes('recall_my_msg') && !bare.includes('send_forward') && !bare.includes('fix_sticker'));
});

test('routeMessage：机器人号段的消息永不唤醒、不进续聊', () => {
  const waker = { shouldWake: () => ({ wake: true, reason: 'at' }) };
  const v = routeMessage({ isRobot: true, isGroup: true, key: 'group:1' }, waker, null, []);
  assert.equal(v.wake, false);
  assert.equal(v.reason, 'robot');
});

test('conversation-memory：knownIds 读归档尾部，backfillTurns 跳过已有', () => {
  const dir = tmp();
  const memory = new ConversationMemory({ dir });
  memory.observe({ key: 'group:1', messageId: '10', name: 'a', userId: '1', text: 'x' });
  memory.logTurn({ where: 'group:1', who: 'a', userId: '1', text: 'y', reply: '' });
  const ids = memory.knownIds('group:1');
  assert.ok(ids.has('napcat-10'));
  const n = memory.backfillTurns([
    { key: 'group:1', id: 'napcat-10', t: Date.now(), who: 'a', userId: '1', text: '重复的' },
    { key: 'group:1', id: 'napcat-11', t: Date.now(), who: 'b', userId: '2', text: '新的' },
  ]);
  assert.equal(n, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
