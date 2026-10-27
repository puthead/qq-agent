/**
 * 主人私聊文件读写自测：群聊/陌生人/主动消息一律拒绝，主人私聊可用
 *   node --test server-src/_file-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toolDefsFor, runTool } from './tools.js';
import { Brain } from './brain.js';
import { Role } from './role.js';

const root = path.resolve('tmp/file-tools-tests');
fs.mkdirSync(root, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(root, 'case-'));
// '你好鲸鲸' 的 GBK 字节（gb2312 常用字，严格 UTF-8 解码必失败，会走 GBK 回退）
const GBK_BYTES = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xbe, 0xa8, 0xbe, 0xa8]);

const ownerCtx = (extra = {}) => ({ isOwner: true, key: 'private:10000', userId: '10000', ...extra });
const DENY = /只对主人的私聊开放/;

test('工具清单只在 files=true 时下发', () => {
  assert.ok(!toolDefsFor().some(d => ['read_file', 'write_file'].includes(d.function.name)), '默认不给');
  const names = toolDefsFor({ files: true }).map(d => d.function.name);
  assert.ok(names.includes('read_file') && names.includes('write_file'), 'files=true 要给');
});

test('执行端权限门：群聊/非主人/主动消息/身份不齐一律拒绝', async () => {
  const targets = [
    ['read_file', { path: root }],
    ['write_file', { path: path.join(temp(), 'x.txt'), content: 'hi' }],
  ];
  for (const ctx of [
    ownerCtx({ key: 'group:123', userId: '111' }),
    ownerCtx({ isOwner: false }),
    ownerCtx({ key: 'private:999', userId: '10000' }),
    ownerCtx({ proactive: true }),
    {},
  ]) {
    for (const [name, args] of targets) assert.match(await runTool(name, args, ctx), DENY, name + ' ' + JSON.stringify(ctx));
  }
});

test('主人私聊：读文本、截断续读、目录清单、缺失与过大', async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'a.txt'), '一二三四五六七八九十'.repeat(400), 'utf8');
  const first = await runTool('read_file', { path: path.join(dir, 'a.txt') }, ownerCtx());
  assert.ok(first.includes('共 4000 字'), first);
  assert.ok(first.includes('后面还有 1000 字'), first);
  assert.ok(first.includes('offset=3000'), first);
  const next = await runTool('read_file', { path: path.join(dir, 'a.txt'), offset: 3000 }, ownerCtx());
  assert.ok(next.includes('从第 3001 字起') && !next.includes('后面还有'), next);
  const list = await runTool('read_file', { path: dir }, ownerCtx());
  assert.ok(list.includes('a.txt') && list.includes('共 1 项'), list);
  assert.match(await runTool('read_file', { path: path.join(dir, '无.txt') }, ownerCtx()), /没有这个文件或文件夹/);
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.match(await runTool('read_file', { path: path.join(dir, 'big.bin') }, ownerCtx()), /超过单次 2MB 上限/);
});

test('主人私聊：GBK 自动回退，二进制和 UTF-8 各走各路', async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'gbk.txt'), GBK_BYTES);
  assert.equal(await runTool('read_file', { path: path.join(dir, 'gbk.txt') }, ownerCtx()).then(t => t.includes('你好鲸鲸')), true);
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.alloc(100));
  assert.match(await runTool('read_file', { path: path.join(dir, 'bin.dat') }, ownerCtx()), /二进制/);
  fs.writeFileSync(path.join(dir, 'u8.txt'), '你好鲸鲸', 'utf8');
  assert.ok((await runTool('read_file', { path: path.join(dir, 'u8.txt') }, ownerCtx())).includes('你好鲸鲸'));
});

test('主人私聊：写文件、追加、覆盖、干跑不落盘、超限拒绝', async () => {
  const dir = temp();
  const target = path.join(dir, '子目录', '笔记.txt');
  assert.match(await runTool('write_file', { path: target, content: '第一行' }, ownerCtx()), /已写入/);
  assert.equal(fs.readFileSync(target, 'utf8'), '第一行');
  assert.match(await runTool('write_file', { path: target, content: '第二行', append: true }, ownerCtx()), /已追加/);
  assert.equal(fs.readFileSync(target, 'utf8'), '第一行第二行');
  await runTool('write_file', { path: target, content: '覆盖' }, ownerCtx());
  assert.equal(fs.readFileSync(target, 'utf8'), '覆盖');
  assert.match(await runTool('write_file', { path: target, content: '不应存在' }, ownerCtx({ dryRun: true })), /干跑/);
  assert.equal(fs.readFileSync(target, 'utf8'), '覆盖');
  assert.match(await runTool('write_file', { path: target, content: 'x'.repeat(200001) }, ownerCtx()), /20 万字/);
  assert.equal(fs.readFileSync(target, 'utf8'), '覆盖');
});

test('brain 组装：主人私聊给文件工具，群聊和主动消息不给', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), { status: 200 });
  };
  const mem = { touch() {}, renderPerson: () => '', renderRecent: () => '', remember() {}, logTurn() {} };
  const brain = new Brain({ apiKey: 'k', role: new Role({}), memory: mem, thinking: false, ownerIds: ['10000'] });
  await brain.reply({ key: 'group:1', userId: '111', userName: '甲', text: '帮我读个文件' });
  assert.ok(!bodies.at(-1).tools?.some(t => ['read_file', 'write_file'].includes(t.function.name)), '群聊不给');
  await brain.reply({ key: 'private:999', userId: '999', userName: '路人', text: '帮我读个文件' });
  assert.ok(!bodies.at(-1).tools?.some(t => ['read_file', 'write_file'].includes(t.function.name)), '陌生人私聊不给');
  await brain.reply({ key: 'private:10000', userId: '10000', userName: '主人', text: '在吗', proactive: true });
  assert.ok(!bodies.at(-1).tools?.some(t => ['read_file', 'write_file'].includes(t.function.name)), '主动消息不给');
  await brain.reply({ key: 'private:10000', userId: '10000', userName: '主人', text: '帮我读个文件' });
  const names = bodies.at(-1).tools?.map(t => t.function.name) || [];
  assert.ok(names.includes('read_file') && names.includes('write_file'), '主人私聊要给：' + names);
  assert.ok(bodies.at(-1).messages[0].content.includes('【文件读写】'), '系统提示要有能力纪律');
});

test('端到端：主人私聊里模型调 read_file 能真读到，结果进工具消息', async () => {
  const dir = temp();
  const file = path.join(dir, '密.txt');
  fs.writeFileSync(file, '鲸鲸今天也要好好吃饭', 'utf8');
  const bodies = [];
  const steps = [
    () => ({ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }] } }),
    () => ({ message: { content: '读到啦：鲸鲸今天也要好好吃饭' } }),
  ];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [steps[n++](JSON.parse(init.body))] }), { status: 200 });
  };
  const mem = { touch() {}, renderPerson: () => '', renderRecent: () => '', remember() {}, logTurn() {} };
  const brain = new Brain({ apiKey: 'k', role: new Role({}), memory: mem, thinking: false, ownerIds: ['10000'] });
  const r = await brain.reply({ key: 'private:10000', userId: '10000', userName: '主人', text: '看看 ' + file });
  assert.deepEqual(r.usedTools, ['read_file']);
  const toolMsg = bodies.at(-1).messages.find(m => m.role === 'tool');
  assert.ok(toolMsg?.content.includes('鲸鲸今天也要好好吃饭'), '工具消息要有文件内容');
  assert.equal(r.text, '读到啦：鲸鲸今天也要好好吃饭');
});
