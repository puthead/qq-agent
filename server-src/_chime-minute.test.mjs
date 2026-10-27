import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroupChime } from './group-chime.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chime-minute-'));
try {
  let t = Date.now();
  const opts = { dataDir: dir, now: () => t, maxPerMinute: 3,
    maxPerDay: -1, maxPerGroupPerDay: -1, quietHours: [0, 0], minGapMinutes: 0 };
  const c = new GroupChime(opts);
  const tickets = [c.reserveMinute(), c.reserveMinute(), c.reserveMinute()];
  assert.ok(tickets.every(Boolean));
  assert.equal(c.reserveMinute(), null, '并行发送也占用额度');
  c.finishMinute(tickets[0], false);
  const retry = c.reserveMinute();
  assert.ok(retry, '失败发送释放额度');
  for (const ticket of [retry, ...tickets.slice(1)]) c.finishMinute(ticket, true);
  c.finishMinute(retry, true);
  assert.equal(c.minuteSpokes.length, 3, '重复结束不能重复计数');
  assert.equal(c.shouldChime('group:other', { force: true }).code, 'cap-minute');
  const reloaded = new GroupChime(opts);
  assert.equal(reloaded.reserveMinute(), null, '重启保留一分钟额度');
  t += 59999;
  assert.equal(reloaded.reserveMinute(), null);
  t += 1;
  assert.ok(reloaded.reserveMinute(), '60 秒后恢复');
  for (let i = 0; i < 30; i++) c.noteSpoke('group:test');
  c.observe('group:test', { userId: '1' });
  c.observe('group:test', { userId: '2' });
  for (let i = 0; i < 6; i++) c.observe('group:test', { userId: '1' });
  assert.equal(c.shouldChime('group:test', { force: true }).ok, true, '不再有每日上限');
  console.log('滚动窗口、并发占位、失败释放、重启持久化、取消每日额度：通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
