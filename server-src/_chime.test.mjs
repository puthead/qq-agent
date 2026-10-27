/**
 * 群聊接话自测：时间限制 / 次数限制 / 活跃度分档 / 死群不接 / 白黑名单 / 跨天归零 / 落盘重载
 *                  模型说「不接」、模型真说了、干跑
 *   node src/_chime.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let n = 0;
const ok = (msg) => { n++; console.log('  ✓ ' + msg); };

// transport-onebot.js 里会用到全局 WebSocket，import 前先给个替身
globalThis.WebSocket = class { constructor() {} on() { return this; } close() {} send() {} terminate() {} };

const { GroupChime } = await import('./group-chime.js');
const { GroupContext } = await import('./group-context.js');
const { groupChimeTurn } = await import('./index.js');

/** 能拨的时钟 */
const clock = (iso = '2026-10-20T21:00:00+08:00') => {
  let t = new Date(iso).getTime();
  const now = () => t;
  now.jump = (ms) => { t += ms; };
  now.set = (v) => { t = new Date(v).getTime(); };
  return now;
};

const GROUP = 'group:207483783';

/** 造一个「热热闹闹」的群：几条消息、几个人 */
const heat = (c, key = GROUP, { count = 8, people = 3 } = {}) => {
  for (let i = 0; i < count; i++) c.observe(key, { userId: String(100 + (i % people)) });
};

// ── 1. 硬条件：这些情况下不许开口 ───────────────────────────
{
  const now = clock('2026-10-20T21:00:00+08:00');

  const off = new GroupChime({ enabled: false, now, random: () => 0 });
  heat(off);
  assert.equal(off.allowed(GROUP), false);
  assert.equal(off.shouldChime(GROUP).ok, false, '关掉就一句都不许说');

  const c = new GroupChime({ now, random: () => 0, chance: 1 });
  heat(c);
  assert.equal(c.allowed('group:999'), true);
  assert.equal(c.shouldChime(GROUP).ok, true, '默认配置下够热闹就该说话');

  const few = new GroupChime({ now, random: () => 0, chance: 1, minMessages: 20 });
  heat(few);
  assert.match(few.shouldChime(GROUP).reason, /不够热闹/);

  const one = new GroupChime({ now, random: () => 0, chance: 1, minSpeakers: 3 });
  heat(one, GROUP, { count: 9, people: 2 });
  assert.match(one.shouldChime(GROUP).reason, /只有 2 个人在说/, '一个人刷屏不算热闹');
  ok('开没开、条数、发言人数都挡得住');
}

// ── 2. 时间限制：夜里闭嘴、同群间隔、不接之后歇一会儿 ────────
{
  const now = clock('2026-10-20T03:30:00+08:00');
  const c = new GroupChime({ now, random: () => 0, chance: 1, quietHours: [0, 8] });
  heat(c);
  assert.equal(c.shouldChime(GROUP).reason, '夜里不说');
  assert.equal(c.shouldChime(GROUP, { force: true }).ok, true, 'force 只跳过时间类条件');

  // 跨零点的夜间区间也要认
  now.set('2026-10-20T23:30:00+08:00');
  const x = new GroupChime({ now, random: () => 0, chance: 1, quietHours: [23, 7] });
  heat(x);
  assert.equal(x.shouldChime(GROUP).reason, '夜里不说');

  now.set('2026-10-20T21:00:00+08:00');
  const g = new GroupChime({ now, random: () => 0, chance: 1, minGapMinutes: 20 });
  heat(g);
  assert.equal(g.shouldChime(GROUP).ok, true);
  g.noteSpoke(GROUP);
  now.jump(5 * 60000);
  assert.match(g.shouldChime(GROUP).reason, /刚说过/, '同一个群刚说完，5 分钟不能再插');

  now.jump(16 * 60000);  // 21 分钟
  heat(g);
  assert.equal(g.shouldChime(GROUP).ok, true, '隔够 20 分钟又可以了');

  // 说了「不接」：同样隔一会儿再问，但不计次
  now.jump(60000);
  const d = new GroupChime({ now, random: () => 0, chance: 1, declineGapMinutes: 5 });
  heat(d);
  d.noteDeclined(GROUP);
  assert.equal(d.total, 0, '不接不算说过');
  assert.match(d.shouldChime(GROUP).reason, /刚问过它/);
  now.jump(5 * 60000);
  heat(d);
  assert.equal(d.shouldChime(GROUP).ok, true);

  // 在群里正经回了一句（被 @）：也要重新算间隔
  const r = new GroupChime({ now, random: () => 0, chance: 1, minGapMinutes: 20 });
  heat(r);
  r.noteReply(GROUP);
  assert.equal(r.shouldChime(GROUP).ok, false);
  assert.equal(r.total, 0, '被 @ 回复不算插话次数');
  ok('夜里闭嘴、同群冷热、问过不接、被 @ 之后都算对了');
}

// ── 3. 次数限制：每群每天 + 全体每天 ────────────────────────
{
  const now = clock('2026-10-20T21:00:00+08:00');
  const c = new GroupChime({ now, random: () => 0, chance: 1, minGapMinutes: 0, maxPerGroupPerDay: 2, maxPerDay: 3 });
  heat(c);
  for (let i = 0; i < 2; i++) {
    assert.equal(c.shouldChime(GROUP).ok, true, '第 ' + (i + 1) + ' 次');
    c.noteSpoke(GROUP);
  }
  assert.equal(c.shouldChime(GROUP).reason, '这个群今天说够了');
  // 别的群还有额度，但全体上限只剩 1 次
  const other = 'group:832641029';
  heat(c, other);
  assert.equal(c.shouldChime(other).ok, true);
  c.noteSpoke(other);
  heat(c, 'group:333');
  assert.equal(c.shouldChime('group:333').reason, '今天全体说够了');
  ok('每群上限、全体上限，以及 force 也越不过上限');

  // force 也得守每日上限
  assert.equal(c.shouldChime(other, { force: true }).ok, false);

  // 过了零点归零
  now.set('2026-10-21T09:00:00+08:00');
  heat(c);
  assert.equal(c.shouldChime(GROUP).ok, true, '新的一天重新算');
  ok('跨天自动归零');
}

// ── 4. 掷骰子 / 白名单 / 黑名单 ─────────────────────────────
{
  const now = clock('2026-10-20T21:00:00+08:00');
  const salt = (v) => new GroupChime({ now, chance: 0.25, random: () => v });
  const a = salt(0.9); heat(a);
  assert.match(a.shouldChime(GROUP).reason, /掷骰子/);
  const b = salt(0.1); heat(b);
  assert.equal(b.shouldChime(GROUP).ok, true, '骰子过了就一定会问模型');

  const white = new GroupChime({ now, chance: 1, random: () => 0, allowGroups: ['207483783'] });
  heat(white);
  assert.equal(white.allowed(GROUP), true, '白名单里的群号简写也认');
  assert.equal(white.allowed('group:832641029'), false);

  const black = new GroupChime({ now, chance: 1, random: () => 0, blockGroups: [GROUP] });
  heat(black);
  assert.equal(black.shouldChime(GROUP).ok, false);
  assert.equal(black.allowed('group:832641029'), true);
  ok('概率、白名单、黑名单');
}

// ── 5. 落盘：重启之后今天说过几次还得记得 ───────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chime-'));
  const now = clock('2026-10-20T21:00:00+08:00');
  const a = new GroupChime({ now, random: () => 0, chance: 1, dataDir: dir, maxPerGroupPerDay: 1 });
  heat(a);
  assert.equal(a.shouldChime(GROUP).ok, true);
  a.noteSpoke(GROUP);
  assert.ok(fs.existsSync(path.join(dir, 'group-chime.json')), '状态要落盘');

  const b = new GroupChime({ now, random: () => 0, chance: 1, dataDir: dir, maxPerGroupPerDay: 1 });
  heat(b);
  assert.equal(b.total, 1, '重启后次数还在');
  assert.equal(b.shouldChime(GROUP, { force: true }).reason, '这个群今天说够了');
  ok('落盘 + 重载');
}

// ── 6. 群背景可以换措辞（插话要说「没人叫你」） ──────────────
{
  const gc = new GroupContext({ maxMessages: 10, maxChars: 400 });
  gc.add(GROUP, { name: '甲', text: '今晚吃啥' });
  gc.add(GROUP, { name: '乙', text: '火锅吧' });
  assert.ok(gc.render(GROUP).includes('以上用于理解本轮话题和接话关系'), '默认背景说明强调接话关系');
  const custom = gc.render(GROUP, {
    header: '【这个群刚才在聊】',
    footer: '【没有人 @ 你】',
  });
  assert.ok(custom.startsWith('【这个群刚才在聊】'), custom);
  assert.ok(custom.endsWith('【没有人 @ 你】'), custom);
  assert.ok(gc.render('group:空空').length === 0);
  ok('群背景的抬头/落款能换');
}

// ── 7. 插话这一轮：不接 / 真说 / 干跑 / 撞车被挡 ─────────────
{
  const mk = ({ groupCtx, reply, gate = null, chime }) => {
    const calls = { said: [], logged: [], declined: 0, spoke: 0 };
    const deps = {
      bot: { setTyping() {}, send: async () => ({ ok: true }), sendSegments: async () => ({ ok: true }) },
      brain: { stickers: null, reply: async (a) => { calls.seen = a; return reply; } },
      human: { say: async (out) => { calls.said.push(out); return { sent: 1, parts: [out] }; } },
      memory: { logTurn: (r) => calls.logged.push(r), recentTurns: () => [] },
      gate,
      groupCtx,
      chime: chime || { noteSpoke: () => { calls.spoke++; }, noteDeclined: () => { calls.declined++; } },
      key: GROUP,
    };
    return { deps, calls };
  };
  const gc = new GroupContext({ maxMessages: 10, maxChars: 400 });
  gc.add(GROUP, { name: '甲', text: '今天雨下得好大' });
  gc.add(GROUP, { name: '乙', text: '我这鞋全湿了' });

  // 没有背景材料：不叫模型
  {
    const { deps, calls } = mk({ groupCtx: new GroupContext({}), reply: { text: '嗯' } });
    const r = await groupChimeTurn(deps);
    assert.equal(r.spoke, false);
    assert.equal(r.reason, '没材料');
    assert.equal(calls.said.length, 0);
  }

  // 模型说「不接」：什么都不发，记一笔 declined
  {
    const { deps, calls } = mk({ groupCtx: gc, reply: { text: '[不接]', usedTools: [], reasoning: '' } });
    const r = await groupChimeTurn(deps);
    assert.equal(r.spoke, false);
    assert.equal(calls.said.length, 0, '不接就一个字都别发');
    assert.equal(calls.declined, 1);
    assert.equal(calls.spoke, 0);
  }

  // 模型说了句：发出去、记账、计次
  {
    const { deps, calls } = mk({ groupCtx: gc, reply: { text: '这雨下得跟谁欠它钱一样', usedTools: [], reasoning: '' } });
    const r = await groupChimeTurn(deps);
    assert.equal(r.spoke, true);
    assert.deepEqual(calls.said, ['这雨下得跟谁欠它钱一样']);
    assert.equal(calls.spoke, 1);
    assert.equal(calls.logged.length, 1);
    assert.equal(calls.logged[0].where, GROUP);
    assert.equal(calls.logged[0].reply, '这雨下得跟谁欠它钱一样');
    assert.ok(gc.render(GROUP).includes('这雨下得跟谁欠它钱一样'), '自己插的话也要进群背景');
    assert.ok(calls.seen.situation.includes('没有人 @ 你'), calls.seen.situation);
    assert.ok(calls.seen.text.includes('今天雨下得好大'), '要看到群里刚才在聊什么');
    assert.equal(calls.seen.record, false, '插话不要当成一轮正经对话写进账本');
  }

  // 干跑：只打印，不发也不计次
  {
    const { deps, calls } = mk({ groupCtx: gc, reply: { text: '湿就湿了', usedTools: [], reasoning: '' } });
    const r = await groupChimeTurn(deps, { dryRun: true });
    assert.equal(r.spoke, false);
    assert.equal(calls.said.length, 0);
    assert.equal(calls.spoke, 0);
  }

  // 生成完才发现刚有人 @ 她了 / 刚说完：这句就不插了
  {
    let asked = 0;
    const gate = {
      check: () => { asked++; return asked === 1 ? { ok: true } : { ok: false, reason: '正在说' }; },
      begin() {},
      finish() {},
    };
    const { deps, calls } = mk({ groupCtx: gc, reply: { text: '嗯嗯', usedTools: [], reasoning: '' }, gate });
    const r = await groupChimeTurn(deps);
    assert.equal(r.spoke, false);
    assert.match(r.reason, /被挡/);
    assert.equal(calls.said.length, 0);
    assert.equal(calls.spoke, 0, '被挡下来不算她说过');
  }
  // 干跑：带上活跃度一起给模型看
  {
    const { deps, calls } = mk({ groupCtx: gc, reply: { text: '湿就湿了', usedTools: [], reasoning: '' } });
    const verdict = { tier: 'hot', stats: { messages: 42, speakers: 6, idleMs: 30000, windowMinutes: 10 } };
    await groupChimeTurn({ ...deps, verdict }, { dryRun: true });
    assert.ok(calls.seen.situation.includes('聊得正热闹'), calls.seen.situation);
    assert.ok(calls.seen.situation.includes('42 条'), calls.seen.situation);
  }
  ok('插话：不接 / 真说 / 干跑 / 撞车被挡');
}

// ── 8. 活跃度分档：热闹群多接、一般群少接 ───────────────────
{
  const now = clock('2026-10-20T21:00:00+08:00');

  const calm = new GroupChime({ now, chance: 0.25, random: () => 0.4 });
  heat(calm, GROUP, { count: 6 });
  assert.equal(calm.activity(GROUP).tier, 'calm');
  assert.match(calm.shouldChime(GROUP).reason, /掷骰子/, '冷群的骰子更难过多');

  const hot = new GroupChime({ now, chance: 0.25, random: () => 0.4 });
  heat(hot, GROUP, { count: 40 });
  assert.equal(hot.activity(GROUP).tier, 'hot');
  assert.equal(hot.shouldChime(GROUP).ok, true, '同一个骰子，热闹群就过了');

  // 间隔：热闹群 20×0.5=10 分钟，一般群还是 20 分钟
  const gapHot = new GroupChime({ now, random: () => 0, chance: 1, minGapMinutes: 20 });
  heat(gapHot, GROUP, { count: 40 });
  gapHot.noteSpoke(GROUP);
  now.jump(11 * 60000);
  heat(gapHot, GROUP, { count: 40 });
  assert.equal(gapHot.shouldChime(GROUP).ok, true, '热闹群 11 分钟就能再接');

  const gapWarm = new GroupChime({ now, random: () => 0, chance: 1, minGapMinutes: 20 });
  heat(gapWarm, GROUP, { count: 8 });
  gapWarm.noteSpoke(GROUP);
  now.jump(11 * 60000);
  heat(gapWarm, GROUP, { count: 8 });
  assert.match(gapWarm.shouldChime(GROUP).reason, /刚说过/, '一般群 11 分钟还不行');

  // 每日上限：热闹群多 hotExtraPerDay 次
  const cap = new GroupChime({ now, random: () => 0, chance: 1, minGapMinutes: 0, maxPerGroupPerDay: 2, hotExtraPerDay: 2 });
  heat(cap, GROUP, { count: 40 });
  for (let i = 0; i < 4; i++) {
    assert.equal(cap.shouldChime(GROUP).ok, true, '热闹群第 ' + (i + 1) + ' 次');
    cap.noteSpoke(GROUP);
    // 每次都当有人接她：不然会被「连续自说自话」的熔断拦住，那是另一条规则
    cap.noteReply(GROUP);
  }
  assert.equal(cap.shouldChime(GROUP).reason, '这个群今天说够了');
  ok('热闹群概率更高、间隔更短、每日额度更多');
}

// ── 9. 没人说话的群：一句都不接 ─────────────────────────────
{
  const now = clock('2026-10-20T21:00:00+08:00');

  const empty = new GroupChime({ now, random: () => 0, chance: 1 });
  assert.match(empty.shouldChime(GROUP).reason, /一直没人说话/, '从没人说话的群不接');

  const quiet = new GroupChime({ now, random: () => 0, chance: 1, idleMinutes: 6 });
  heat(quiet, GROUP, { count: 8 });
  now.jump(7 * 60000); // 窗口里还有 8 条，但已经 7 分钟没人说话
  assert.match(quiet.shouldChime(GROUP).reason, /没人说话/, '冷场 7 分钟就不接');

  now.jump(-7 * 60000);
  const alive = new GroupChime({ now, random: () => 0, chance: 1, idleMinutes: 6 });
  heat(alive, GROUP, { count: 8 });
  now.jump(5 * 60000);
  assert.equal(alive.shouldChime(GROUP).ok, true, '5 分钟以内还算有人说话');
  ok('没人说话的群、冷下来的群都不接');
}

// ── 10. 自说自话熔断：连着说两轮没人接就收手 ──────────────
{
  const now = clock('2026-10-20T21:00:00+08:00');
  const c = new GroupChime({ now, random: () => 0, chance: 1, minGapMinutes: 0, maxStreak: 2 });

  heat(c, GROUP, { count: 40 });
  assert.equal(c.shouldChime(GROUP).ok, true, '第 1 次');
  c.noteSpoke(GROUP);
  heat(c, GROUP, { count: 40 });
  assert.equal(c.shouldChime(GROUP).ok, true, '第 2 次');
  c.noteSpoke(GROUP);
  heat(c, GROUP, { count: 40 });
  assert.match(c.shouldChime(GROUP).reason, /没人搭腔/, '第 3 次该闭嘴');

  // 有人真在接她（followup）就继续聊，不算自说自话
  now.jump(9000);
  heat(c, GROUP, { count: 40 });
  assert.equal(c.shouldChime(GROUP, { followup: true }).ok, true, '有人接就还能说');

  // 有人点名找她：熔断复位，重新两次机会
  c.noteReply(GROUP);
  heat(c, GROUP, { count: 40 });
  assert.equal(c.shouldChime(GROUP).ok, true, '被 @ 之后重新算');

  // 沉默十分钟以上，旧账不压新话题
  c.noteSpoke(GROUP);
  c.noteSpoke(GROUP);
  now.jump(11 * 60000);
  heat(c, GROUP, { count: 40 });
  assert.equal(c.shouldChime(GROUP).ok, true, '隔了十分钟又能接');

  // 手动 force 不受熔断管
  c.noteSpoke(GROUP);
  c.noteSpoke(GROUP);
  heat(c, GROUP, { count: 40 });
  assert.equal(c.shouldChime(GROUP, { force: true }).ok, true, 'force 照说');
  ok('连续两轮没人理就闭嘴，被 @ / 隔太久 / force 都能解开');
}

console.log('\n群聊插话自测通过，' + n + ' 项。');
process.exit(0);
