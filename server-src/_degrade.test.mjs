/**
 * 带图请求失败时的降级自测：去掉图重试一次，并且别让她编图里的内容
 *   node src/_degrade.test.mjs
 */
import assert from 'node:assert/strict';

const bodies = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  bodies.push(body);
  // 第一次带图的请求 500，第二次（没图）正常回
  if (bodies.length === 1) return new Response('{"error":"image too large"}', { status: 500 });
  return new Response(JSON.stringify({ choices: [{ message: { content: '图没收到，你说说画的啥', reasoning_content: '' } }] }), { status: 200 });
};

const { Brain } = await import('./brain.js');
const { Memory } = await import('./memory.js');
const { Role } = await import('./role.js');

const mem = { touch() {}, renderPerson: () => '', renderRecent: () => '', remember() {}, logTurn() {} };
const brain = new Brain({ apiKey: 'k', role: new Role({}), memory: mem, tools: false, thinking: false });

const r = await brain.reply({ key: 'group:1', userId: '1', userName: '甲', text: '这个图片你能看见吗', images: ['data:image/gif;base64,AAAA'] });
assert.equal(bodies.length, 2, '带图失败要重试一次');
const first = bodies[0].messages.at(-1);
const second = bodies[1].messages.at(-1);
assert.ok(Array.isArray(first.content) && first.content.some((c) => c.type === 'image_url'), '第一次该带图');
assert.equal(typeof second.content, 'string', '第二次把图去掉');
assert.ok(second.content.includes('图没传上去'), '降级要明说看不见：' + second.content);
assert.ok(!JSON.stringify(second).includes('image_url'), '降级后不许再带 image_url');
assert.ok(r.text.includes('图没收到'));
console.log('  ✓ 带图失败 → 去掉图重试，并交代看不见');

// 纯文字请求失败照旧抛错，不许无限重试
const calls = [];
globalThis.fetch = async (url, init) => { calls.push(1); return new Response('boom', { status: 500 }); };
await assert.rejects(() => brain.reply({ key: 'group:1', userId: '1', userName: '甲', text: '在吗' }));
assert.equal(calls.length, 1, '没图就别重试');
console.log('  ✓ 没图失败直接抛，不重试');
console.log('\n降级自测通过。');
process.exit(0);
