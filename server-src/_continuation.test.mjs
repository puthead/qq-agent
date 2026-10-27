import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from './brain.js';
import { GroupContext } from './group-context.js';
import { GroupScheduler } from './group-scheduler.js';
import { Waker } from './wake.js';
import { ReplyGate } from './throttle.js';
import { routeMessage, handleTurn, queueLate, runGroupChimeTurn } from './index.js';

const key = 'group:synthetic';
const cfg = { dryRun: false, vision: { enabled: false }, ownerIds: ['1'] };
const message = (extra = {}) => ({ key, isGroup: true, userId: '1', name: '甲', messageId: 'next', text: '作画风格呢', time: Date.now(), images: [], atIds: [], ...extra });
function focus(extra = {}) {
  const g = new GroupContext();
  g.noteReplyTarget(key, { userIds: ['1'], messageIds: ['old'], text: '蓝白色的长发，背景简单一点', at: Date.now() - 20000, ...extra });
  return g;
}
function waker() {
  const w = new Waker({ names: ['小助手'], ownerIds: ['1'] });
  w.setConfig(key, { question: false, probability: 0 });
  return w;
}
const mem = () => ({ context: () => '', renderPerson: () => '', recentTurns: () => [], logTurn() {}, touch() {} });
const response = content => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
async function withModel(scene, continuation, work, { fail = false } = {}) {
  const requests = [], old = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1 && fail) throw new Error('synthetic timeout');
    return response(requests.length === 1 ? JSON.stringify({ mode: 'answer', confidence: .95, effort: 'low', addressedTo: 'self', ...scene }) : '偏水彩一点');
  };
  try {
    const brain = new Brain({ apiKey: 'test', memory: mem(), role: { build: () => '角色规则' }, tools: false, dialogue: { sceneEnabled: true } });
    const result = await brain.reply({ key, userId: '1', text: '画得柔和一些呢', situation: '刚才在和甲商量一个虚构海报',
      routing: { targetMessageId: 'next', continuation }, record: false, dryRun: true });
    await work(result, requests);
  } finally { globalThis.fetch = old; }
}
function deps(g = focus(), overrides = {}) {
  const sent = [];
  return { key, sent, groupCtx: g, waker: waker(), memory: mem(), gate: new ReplyGate({ groupCooldownMs: 0, globalPerMinute: -1 }),
    bot: { send: async (_k, s) => { sent.push(s); return { ok: true }; }, setTyping() {} },
    human: { say: async (s, opts) => { await opts.send(s); return { sent: 1, parts: [s] }; } },
    brain: { reply: async () => ({ text: '偏水彩一点', actions: [] }) }, chime: {}, ...overrides };
}

test('两句原始漏答均进入续聊候选，主人和普通群友同样适用，不走随机门槛', () => {
  for (const text of ['你有没有什么想法，要什么风格', '作画风格呢', '还想再柔和一点']) {
    const g = focus(), m = message({ text }); g.add(key, m);
    const r = routeMessage(m, waker(), g);
    assert.equal(r.reason, 'continuation'); assert.equal(r.continuation.strong, true);
  }
  const g = focus({ userIds: ['2'] }), m = message({ userId: '2' }); g.add(key, m);
  assert.equal(routeMessage(m, waker(), g).reason, 'continuation');
});

test('明确@第三人、引用别人、机器人和跨群消息不因近期聊过而续聊', () => {
  for (const extra of [{ atIds: ['3'] }, { replyTo: 'third' }, { quoted: { senderId: '3' } }, { isBot: true }, { key: 'group:other' }]) {
    const g = focus(), m = message(extra); g.add(m.key, m);
    const w = waker(); w.setConfig(m.key, { question: false, probability: 0 });
    assert.equal(routeMessage(m, w, g).wake, false);
  }
  assert.equal(routeMessage(message(), waker(), focus(), ['1']).wake, false);
});

test('明确@不需续聊识别；无实际回复不能靠“为什么”唤起随机豁免', () => {
  assert.equal(routeMessage(message({ isAtMe: true }), waker(), new GroupContext()).reason, 'atMention');
  assert.equal(routeMessage(message({ text: '为什么呢' }), waker(), new GroupContext()).wake, false);
});

test('窗口到期、消息过旧、插入过多聊天、已处理消息均不重复候选', () => {
  assert.equal(focus({ at: Date.now() - 121000 }).continuationCandidate(key, message()), null);
  assert.equal(focus().continuationCandidate(key, message({ time: Date.now() - 50000 })), null);
  const g = focus(); for (let i = 0; i < 9; i++) g.add(key, message({ messageId: 'i' + i }));
  assert.equal(g.continuationCandidate(key, message()), null);
  const h = focus(), m = message(); h.add(key, m); h.markEvaluated(key, [m.messageId]);
  assert.equal(h.continuationCandidate(key, m), null);
});

test('OneBot秒精度时间不会漏掉同秒到达的追问', () => {
  const g = focus({ at: Date.now() });
  assert.ok(g.continuationCandidate(key, message({ time: Math.floor(Date.now() / 1000) * 1000 })));
});

test('新群友短时加入可以判读但不走强降级；第三人消息削弱本地置信度', () => {
  const g = focus(), other = message({ userId: '2' });
  assert.equal(g.continuationCandidate(key, other).strong, false);
  assert.equal(focus({ at: Date.now() - 31000 }).continuationCandidate(key, other), null);
  g.add(key, message({ userId: '3', messageId: 'insert' }));
  assert.equal(g.continuationCandidate(key, message()).strong, false);
});

test('仅候选不延长窗口，别人收尾不关闭原对话', () => {
  const g = focus(), original = g.conversations.get(key).at;
  for (let i = 0; i < 10; i++) g.continuationCandidate(key, message());
  assert.equal(g.conversations.get(key).at, original);
  g.endConversation(key, g.continuationCandidate(key, message({ userId: '2' })));
  assert.equal(g.conversations.has(key), true);
  g.endConversation(key, g.continuationCandidate(key, message()));
  assert.equal(g.conversations.has(key), false);
});

test('同一场景判断用于寻址和生成，恰好两次调用，保留当前原话与回复对象', async () => {
  await withModel({}, focus().continuationCandidate(key, message()), (r, requests) => {
    assert.equal(r.text, '偏水彩一点'); assert.equal(requests.length, 2);
    assert.equal(requests[0].tools, undefined);
    assert.match(requests[0].messages.at(-1).content, /"continuation"/);
    assert.match(JSON.stringify(requests[1]), /画得柔和一些呢/);
    assert.match(requests[1].messages[0].content, /本轮为续聊/);
    assert.ok(!JSON.stringify(requests[1]).includes('不看你之前说过什么'));
  });
});

for (const addressedTo of ['other', 'ended', 'unclear']) test(`场景判为${addressedTo}不生成、不调用工具，只一次判读`, async () => {
  await withModel({ addressedTo }, focus().continuationCandidate(key, message()), (r, requests) => {
    assert.equal(r.skipped, addressedTo); assert.equal(r.text, ''); assert.equal(requests.length, 1); assert.deepEqual(r.actions, []);
  });
});

test('场景超时只给明确同人的连续对话降级，不让不明对象抢话', async () => {
  await withModel({}, { strong: true }, (r, q) => { assert.equal(q.length, 2); assert.equal(r.skipped, undefined); }, { fail: true });
  await withModel({}, { strong: false }, (r, q) => { assert.equal(q.length, 1); assert.equal(r.skipped, 'uncertain'); }, { fail: true });
});

test('不接受非法寻址枚举或低置信度结论为确定续聊', async () => {
  await withModel({ addressedTo: 'run_tools' }, { strong: false }, (r, q) => { assert.equal(r.skipped, 'uncertain'); assert.equal(q.length, 1); });
  await withModel({ confidence: .3 }, { strong: true }, (r, q) => { assert.equal(r.skipped, 'uncertain'); assert.equal(q.length, 1); });
});

test('成功发送才建立对话；失败和干跑不延长；重复投递不重复回答', async () => {
  const g = new GroupContext(), m = message({ isAtMe: true }); g.add(key, m);
  const d = deps(g); await handleTurn(d, [m], cfg);
  assert.equal(g.conversations.get(key).userIds[0], '1'); assert.equal(g.inFlight.size, 0);
  await handleTurn(d, [m], cfg); assert.equal(d.sent.length, 1);
  const h = new GroupContext(), bad = deps(h, { bot: { send: async () => ({ ok: false, error: 'synthetic' }), setTyping() {} } });
  await assert.rejects(() => handleTurn(bad, [m], cfg), /发送失败/);
  assert.equal(h.conversations.size, 0); assert.equal(h.inFlight.size, 0);
  await handleTurn(deps(h), [m], { ...cfg, dryRun: true }); assert.equal(h.conversations.size, 0);
});

test('候选收尾只标处理，不落假回复、不调用发送，并关闭本人的旧对话', async () => {
  const g = focus(), m = message(); g.add(key, m); m.continuation = g.continuationCandidate(key, m);
  const d = deps(g, { brain: { reply: async () => ({ skipped: 'ended', text: '', actions: [] }) } });
  await handleTurn(d, [m], cfg); assert.equal(d.sent.length, 0); assert.equal(g.conversations.size, 0);
  assert.equal(g.liveRows(key).at(-1).evaluated, true);
});

const waitFor = async predicate => {
  const stop = Date.now() + 3000;
  while (!predicate() && Date.now() < stop) await new Promise(r => setTimeout(r, 10));
  assert.ok(predicate(), 'queue did not finish within 3s');
};

test('首次直接回复生成中补充消息进入队列，合并去重，完成后接续且不刷新长期焦点', async () => {
  const g = new GroupContext(), first = message({ messageId: 'first', isAtMe: true, text: '想做什么海报' }); g.add(key, first);
  let release, calls = 0;
  const blocked = new Promise(r => release = r);
  const d = deps(g, { brain: { reply: async input => { if (++calls === 1) { await blocked; return { text: '蓝白色的吧', actions: [] }; } assert.ok(input.routing.continuation); return { text: '偏水彩一点', actions: [] }; } } });
  const work = handleTurn(d, [first], cfg);
  await waitFor(() => calls === 1);
  const m = message(); g.add(key, m); m.continuation = routeMessage(m, waker(), g).continuation;
  assert.equal(m.continuation.inFlight, true); assert.equal(g.conversations.size, 0);
  await handleTurn(d, [m], cfg); queueLate(m);
  release(); await work; await waitFor(() => d.sent.length === 2);
  assert.equal(calls, 2); assert.deepEqual(d.sent, ['蓝白色的吧', '偏水彩一点']);
});

for (const fail of [false, true]) test(`普通消息在插话生成中到达，旧轮${fail ? '报错' : '取消'}后新轮仍调度一次`, async () => {
  let release, calls = 0;
  const blocked = new Promise(r => release = r);
  const s = new GroupScheduler({ delayMs: 2, run: async () => { if (++calls === 1) { await blocked; if (fail) throw new Error('synthetic'); } } });
  const work = s.execute(key); s.schedule(key); s.schedule(key);
  release(); if (fail) await assert.rejects(work); else await work;
  await waitFor(() => calls === 2); assert.equal(s.busy.size, 0); assert.equal(s.dirty.size, 0);
  s.drop(key);
});

test('直接请求接管时取消普通插话重调度，不重复回答同一消息', async () => {
  let release, calls = 0; const blocked = new Promise(r => release = r);
  const s = new GroupScheduler({ delayMs: 2, run: async () => { calls++; await blocked; } });
  const work = s.execute(key); s.schedule(key); s.drop(key); release(); await work;
  await new Promise(r => setTimeout(r, 15)); assert.equal(calls, 1); assert.equal(s.pending.size, 0);
});

test('插话生成中收到无@续聊，取消过时草稿后照常补答', async () => {
  const g = focus(), old = message({ messageId: 'ambient', text: '这张画很漂亮' }); g.add(key, old);
  let calls = 0;
  const d = deps(g, { brain: { reply: async input => {
    calls++;
    if (input.proactive) {
      const m = message(); g.add(key, m); m.continuation = routeMessage(m, waker(), g).continuation;
      assert.ok(m.continuation); queueLate(m);
      return { text: '过时草稿', actions: [] };
    }
    return { text: '偏水彩一点', actions: [] };
  } } });
  const r = await runGroupChimeTurn(d, cfg);
  assert.equal(r.reason, '生成期间已有新消息');
  await waitFor(() => d.sent.length === 1); assert.deepEqual(d.sent, ['偏水彩一点']); assert.equal(calls, 2);
});

test('续聊仍服从发送预算限制', async () => {
  let called = false; const g = focus(), m = message(); m.continuation = g.continuationCandidate(key, m);
  await handleTurn(deps(g, { budget: { left: () => 0 }, brain: { reply: async () => { called = true; } } }), [m], cfg);
  assert.equal(called, false);
});
