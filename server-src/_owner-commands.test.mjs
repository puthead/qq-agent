import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OwnerCommands, parseOwnerCommand } from './owner-commands.js';
import { LEARNED_START, LEARNED_END } from './learning-cycle.js';
import { setSelfName } from './identity.js';

setSelfName('小助手'); // 本文件断言机器人署名「小助手」

const root = path.resolve('tmp/owner-commands-tests');
fs.mkdirSync(root, { recursive: true });

const msg = (over = {}) => ({ key: 'private:10000', userId: '10000', name: '主人', text: '/状态', isGroup: false, ...over });

test('指令解析：全角斜杠也认，认不出的一律放行当聊天', () => {
  assert.equal(parseOwnerCommand('/状态')?.name, 'status');
  assert.equal(parseOwnerCommand('／帮助')?.name, 'help');
  assert.equal(parseOwnerCommand('/学习状态')?.name, 'learnstatus');
  assert.equal(parseOwnerCommand('/HELP')?.name, 'help');
  assert.equal(parseOwnerCommand('/学习状态 后面还写了字')?.name, 'learnstatus');
  assert.equal(parseOwnerCommand('/不认识的指令'), null);
  assert.equal(parseOwnerCommand('状态'), null, '没有斜杠不是指令');
  assert.equal(parseOwnerCommand('/状态这是普通聊天里提到斜杠'), null, '指令词后面必须空格或结束，粘连的不算');
  assert.equal(parseOwnerCommand(''), null);
  assert.equal(parseOwnerCommand(null), null);
});

function setup(t) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  const sent = [];
  const logged = [];
  const memory = { logTurn: (r) => logged.push(r) };
  const bot = { send: async (key, text) => { sent.push({ key, text }); return { ok: true }; } };
  return { dir, sent, logged, memory, bot };
}

test('只有主人私聊能触发指令；群聊和外人发同样的字都当普通聊天', async (t) => {
  const { dir, sent, logged, memory, bot } = setup(t);
  const oc = new OwnerCommands({ ownerIds: ['10000'], memory, bot, dataDir: dir });
  assert.equal(oc.handle(msg({ isGroup: true, key: 'group:1', userId: '10000', text: '/状态' })), false);
  assert.equal(oc.handle(msg({ userId: '99999', key: 'private:99999' })), false);
  assert.equal(oc.handle(msg({ text: '今天状态不错' })), false);
  assert.equal(sent.length, 0);
  assert.equal(oc.handle(msg()), true);
  await oc.lastDispatch;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'private:10000');
  assert.ok(/NapCat/.test(sent[0].text));
  assert.ok(logged.some((r) => r.text === '/状态'), '指令本体也入账');
  assert.ok(logged.some((r) => r.who === '小助手' && r.reply.includes('NapCat')), '回复也入账');
});

test('六个指令各自给出对应内容', async (t) => {
  const { dir, sent, memory, bot } = setup(t);
  fs.writeFileSync(path.join(dir, 'service-status.json'), JSON.stringify({ pid: 1234, uptimeSeconds: 7380, napcatConnected: true, conversations: 6 }));
  const cardPath = path.join(dir, 'role.md');
  fs.writeFileSync(cardPath, '卡\n' + LEARNED_START + '\n· 短句多\n' + LEARNED_END + '\n');
  const remembered = [];
  const learning = {
    enabled: true, busy: false, intervalHours: 2, cardPath,
    status: () => ({ enabled: true, busy: false, intervalHours: 2, lastRunAt: Date.now() - 3600e3, lastOkAt: Date.now() - 3500e3, lastError: '', runCount: 3, failCount: 1, nextDueAt: Date.now() + 3600e3, habits: 1, digestSessions: 1 }),
    digests: () => ({ 'group:123': [{ t: Date.now() - 3600e3, text: '在聊副本' }] }),
    run: async ({ trigger }) => { remembered.push(trigger); return { ok: true, groups: 1, rows: 5, chars: 400, habits: 1, cardUpdated: true, digestSessions: 1, memories: 2 }; },
  };
  const oc = new OwnerCommands({ ownerIds: ['10000'], memory, bot, dataDir: dir, learning });

  oc.handle(msg({ text: '/帮助' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('/学习状态'));
  oc.handle(msg({ text: '/状态' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('PID 1234') && sent.at(-1).text.includes('连着') && sent.at(-1).text.includes('6 个'));
  oc.handle(msg({ text: '/学习' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('说话习惯 1 条已写进角色卡'));
  assert.deepEqual(remembered, ['manual']);
  oc.handle(msg({ text: '/学习状态' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('累计 3 次、失败 1 次'));
  oc.handle(msg({ text: '/总结' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('群 123') && sent.at(-1).text.includes('在聊副本'));
  oc.handle(msg({ text: '/习惯' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('短句多'));
});

test('/学习 在忙、没开和失败时都照实说，不谎报成功', async (t) => {
  const { dir, sent, memory, bot } = setup(t);
  const oc = new OwnerCommands({
    ownerIds: ['10000'], memory, bot, dataDir: dir,
    learning: { enabled: true, busy: true, run: async () => { throw new Error('不该被调'); } },
  });
  oc.handle(msg({ text: '/学习' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('还在跑'));

  const off = new OwnerCommands({ ownerIds: ['10000'], memory, bot, dataDir: dir, learning: { enabled: false } });
  off.handle(msg({ text: '/学习' })); await off.lastDispatch;
  assert.ok(sent.at(-1).text.includes('没开'));

  const bad = new OwnerCommands({
    ownerIds: ['10000'], memory, bot, dataDir: dir,
    learning: { enabled: true, busy: false, run: async () => ({ ok: false, error: '模型超时' }) },
  });
  bad.handle(msg({ text: '/学习' })); await bad.lastDispatch;
  assert.ok(sent.at(-1).text.includes('没跑成') && sent.at(-1).text.includes('模型超时'));
});

test('没有学习模块或空数据时也不炸，照常给一句实话', async (t) => {
  const { dir, sent, memory, bot } = setup(t);
  const oc = new OwnerCommands({ ownerIds: ['10000'], memory, bot, dataDir: dir, learning: null });
  oc.handle(msg({ text: '/学习状态' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('没接上'));
  oc.handle(msg({ text: '/总结' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('还没有'));
  oc.handle(msg({ text: '/习惯' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('空的') || sent.at(-1).text.includes('还没'));
  oc.handle(msg({ text: '/状态' })); await oc.lastDispatch;
  assert.ok(sent.at(-1).text.includes('PID'));
});
