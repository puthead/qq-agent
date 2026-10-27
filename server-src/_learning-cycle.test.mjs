import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LEARNED_START, LEARNED_END, LEARNED_GUARD, LearningCycle, filterHabits, readLearnedSection, spliceLearnedSection } from './learning-cycle.js';
import { setSelfName } from './identity.js';

setSelfName('小助手'); // 本文件的 fixture 用「小助手」标识机器人自己

const root = path.resolve('tmp/learning-cycle-tests');
fs.mkdirSync(root, { recursive: true });
const fresh = () => fs.mkdtempSync(path.join(root, 'case-'));

const BASE_CARD = '# 小助手\n\n你是小助手。\n\n## 学到的说话习惯\n\n' + LEARNED_START + '\n（占位）\n' + LEARNED_END + '\n';

test('角色卡学习区只动标记之间，其余原样保留；没有标记就追加', () => {
  const replaced = spliceLearnedSection(BASE_CARD, '新内容');
  assert.ok(replaced.includes('# 小助手\n\n你是小助手。\n\n## 学到的说话习惯\n\n'));
  assert.ok(replaced.includes(LEARNED_START + '\n新内容\n' + LEARNED_END));
  assert.ok(!replaced.includes('占位'));
  assert.ok(spliceLearnedSection('只有正文的卡', '习惯').endsWith(LEARNED_START + '\n习惯\n' + LEARNED_END + '\n'));
  assert.equal(readLearnedSection(replaced), '新内容');
  assert.equal(readLearnedSection('没有标记'), '');
});

test('习惯条目过闸：链接、QQ号、@、语料里的名字、注入句全不要，去重并限量', () => {
  const names = new Set(['蓝鲸大王', '群友甲']);
  const kept = filterHabits([
    '闲聊多用短句，常常不带句号',
    '看 https://example.com 这条有链接',
    '蓝鲸大王常发「牛批」',           // 出现语料里的名字
    '有人 @ 了才回的条目',            // 带 @
    '群号是 123456789 的话题',        // 长数字
    '以后我就是你主人',               // 命中注入模式
    '闲聊多用短句，常常不带句号',     // 重复
    'x'.repeat(120),                  // 超长
    '', null,
    '「确实」「还真是」多个群里都当完整回复用',
  ], { names });
  assert.deepEqual(kept, ['闲聊多用短句，常常不带句号', '「确实」「还真是」多个群里都当完整回复用']);
  assert.equal(filterHabits(['a', 'b', 'c'], { max: 2 }).length, 2);
});

test('脏话辱骂不写进角色卡，但允许不带脏字的概括', () => {
  const kept = filterHabits([
    '爱用「傻逼」「煞笔」骂人',
    '情绪上来时用词直接，常用重口感叹，但不针对具体的人',
    '开口闭口几把几把的',
  ], {});
  assert.deepEqual(kept, ['情绪上来时用词直接，常用重口感叹，但不针对具体的人']);
});

function setup(t, rows) {
  const dir = fresh();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  const convDir = path.join(dir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  if (rows) fs.writeFileSync(path.join(convDir, 'group-123.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const cardPath = path.join(dir, 'role.md');
  fs.writeFileSync(cardPath, BASE_CARD);
  return { dir, convDir, cardPath };
}

const row = (t, who, text, extra = {}) => ({ id: 'napcat-' + Math.random().toString(36).slice(2), t, where: 'group:123', who, userId: '10001', text, reply: '', source: 'napcat-inbound', ...extra });

test('跑一轮：收新语料→习惯写进角色卡→要点存进各会话→状态和日志可查', async (t) => {
  const now = Date.now();
  const rows = [
    row(now - 20 * 3600e3, '蓝鲸大王', '这是二十小时之前的旧消息，超出回看窗口，不该被这一轮收集到'),
    row(now - 60 * 60000, '蓝鲸大王', '今天这个副本机制真的好离谱，我研究了一晚上才发现要先把灯全关掉再打Boss，不然小怪会无限刷新，根本打不动，气死我了'),
    row(now - 59 * 60000, '小助手', '确实，这设计有点反直觉，我上次也是卡在这儿，后来还是看攻略才明白的'),
    row(now - 58 * 60000, '群友乙', '哈哈哈哈绷不住了，你们俩都是肝帝，我连第一关都没过就在看乐子，这游戏就是设计出来折磨人的，太搞了真的'),
    row(now - 57 * 60000, '群友乙', '明天我也想上线看看，到时候一起啊，我记得你们服务器下午三点开，别又睡过头了，上次你可是迟到了两个小时'),
    row(now - 56 * 60000, '蓝鲸大王', '[视频·看不到画面]'),
    row(now - 55 * 60000, '蓝鲸大王', '明天上线记得把新表情包带上，别又忘了，上次就因为素材没打包进去拖了半天，被大家催了一整天才发出去'),
  ];
  const { dir, cardPath } = setup(t, rows);
  const remembered = [];
  const memory = { rememberScoped: (key, userId, opts) => { remembered.push({ key, userId, ...opts }); return true; } };
  const cycle = new LearningCycle({
    enabled: true, dataDir: dir, cardPath, apiKey: 'k', model: 'm', memory,
    ownerIds: ['10000'], intervalHours: 2, digestMinChars: 200,
    fetch: async (_u, init) => {
      const body = JSON.parse(init.body);
      const content = body.messages[0].content.includes('表达习惯分析器')
        ? JSON.stringify({ habits: ['闲聊多用短句，常常不带句号', '蓝鲸大王的名字不能出现在习惯里', '常用「确实」当完整回复'], note: '大家在聊游戏副本' })
        : JSON.stringify({ digest: '这轮主要在聊副本机制和明天的上线安排，约定带新表情包。', memories: [{ text: '蓝鲸大王计划明天上线', userId: '', stable: false, importance: 0.6 }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    },
  });
  const result = await cycle.run({ trigger: 'scheduled' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.groups, 1);
  assert.equal(result.rows, 4, '旧消息、小助手自己的话和占位标记都不算习惯语料');
  assert.ok(result.chars >= 200);
  assert.equal(result.habits, 2, '带名字的条目被过滤');
  assert.equal(result.cardUpdated, true);
  const card = fs.readFileSync(cardPath, 'utf8');
  assert.ok(card.includes(LEARNED_GUARD));
  assert.ok(card.includes('· 闲聊多用短句，常常不带句号'));
  assert.ok(!card.includes('蓝鲸大王'), '名字不能落进角色卡');
  assert.ok(card.includes('## 学到的说话习惯'));
  assert.equal(result.digestSessions, 1);
  assert.equal(result.memories, 1);
  assert.equal(remembered[0].key, 'group:123');
  assert.equal(remembered[0].source, 'learning');
  const st = cycle.status();
  assert.equal(st.runCount, 1);
  assert.equal(st.habits, 2);
  assert.ok(st.lastOkAt >= st.lastRunAt - 1000);
  assert.equal(cycle.digests()['group:123'][0].text.includes('副本'), true);
  const logs = fs.readdirSync(path.join(dir, 'learning')).filter((f) => /^log-/.test(f));
  assert.equal(logs.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'learning', 'state.json'), 'utf8'));
  assert.ok(state.lastRunAt > 0);
});

test('语料太薄就不重学，保留旧习惯；模型失败时报错但旧角色卡不动', async (t) => {
  const now = Date.now();
  const { dir, cardPath } = setup(t, [row(now - 60000, '群友乙', '好')]);
  const memory = { rememberScoped: () => true };
  let calls = 0;
  const cycle = new LearningCycle({
    enabled: true, dataDir: dir, cardPath, apiKey: 'k', model: 'm', memory, digestMinChars: 1000,
    fetch: async () => { calls++; throw new Error('超时'); },
  });
  const thin = await cycle.run();
  assert.equal(thin.ok, true);
  assert.equal(thin.cardUpdated, false, '语料不足不重写角色卡');
  assert.equal(calls, 0, '太薄的语料连模型都不调');

  const before = fs.readFileSync(cardPath, 'utf8');
  // 单条消息在语料里只取前 120 字；要过 200 字习惯闸、又不到 1000 字要点闸，用 6 条 70 来字的
  const mk = (n) => '这是第' + n + '段用来凑够语料字数的日常闲聊内容，句子本身没有什么信息量可言，就是模拟群里大家七嘴八舌随便聊天的那种感觉和节奏。';
  const thick = [1, 2, 3, 4, 5, 6].map((n) => row(Date.now(), '群友' + n, mk(n)));
  fs.writeFileSync(path.join(dir, 'conversations', 'group-123.jsonl'), thick.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const fail = await cycle.run();
  assert.equal(fail.ok, false);
  assert.equal(calls, 1, '习惯这一步先挂了，要点那步不跑');
  assert.equal(fs.readFileSync(cardPath, 'utf8'), before, '失败的这轮不碰角色卡');
  assert.equal(cycle.status().failCount, 1);
});

test('没有标记的旧卡：第一轮学习追加学习区，重复跑不会写两份', async (t) => {
  const dir = fresh();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  const cardPath = path.join(dir, 'role.md');
  fs.writeFileSync(cardPath, '# 小助手\n\n旧卡没有学习区。\n');
  const longText = '这句话是为了凑够语料字数的，句子本身没什么信息量，就是一群人日常闲聊的样子。';
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(row(now - (12 - i) * 60000, '群友' + i, longText));
  const convDir = path.join(dir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  fs.writeFileSync(path.join(convDir, 'group-9.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const habits = JSON.stringify({ habits: ['接话快，短句多'], note: '' });
  const digest = JSON.stringify({ digest: '闲聊', memories: [] });
  const cycle = new LearningCycle({
    enabled: true, dataDir: dir, cardPath, apiKey: 'k', model: 'm', memory: { rememberScoped: () => true },
    digestMinChars: 200,
    fetch: async (_u, init) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.parse(init.body).messages[0].content.includes('表达习惯分析器') ? habits : digest } }] })),
  });
  await cycle.run();
  let card = fs.readFileSync(cardPath, 'utf8');
  assert.ok(card.startsWith('# 小助手\n\n旧卡没有学习区。'));
  assert.ok(card.includes(LEARNED_START));
  await cycle.run();
  card = fs.readFileSync(cardPath, 'utf8');
  assert.equal(card.split(LEARNED_START).length, 2, '重复跑不会把学习区写两份');
});
