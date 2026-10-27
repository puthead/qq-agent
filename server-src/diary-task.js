/**
 * 日记任务 · 每天定时帮她写一篇
 * ─────────────────────────────────────────────────────────────
 * diary.js 只负责存，diary-author.js 只负责生成。
 * 这个脚本负责把两边接起来：读配置 → 拼材料 → 生成 → 落盘。
 *
 * 用法：
 *   node src/diary-task.js                 # 写今天的一篇（今天写过就跳过）
 *   node src/diary-task.js --force         # 今天写过也再写一篇
 *   node src/diary-task.js --config ./config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeDiary, readModelConfig } from './diary-author.js';
import { Diary } from './diary.js';
import { Memory } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

async function main() {
  const cfgPath = arg('--config', path.join(__dirname, '..', 'config.json'));
  const c = readModelConfig(cfgPath);
  const force = process.argv.includes('--force');

  const diary = new Diary({ dir: c.diaryDir, maxChars: c.diaryMaxChars });
  const memory = new Memory({ dir: c.dataDir });

  // 今天已经写过就不再写（每天定时跑，避免重复）
  const todayCount = diary.day(today()).length;
  if (todayCount > 0 && !force) {
    console.log('[日记] 今天已经有 ' + todayCount + ' 篇了，跳过。');
    return;
  }

  let roleText = '';
  try { roleText = fs.readFileSync(c.roleCard, 'utf8'); }
  catch { console.log('[日记] 读不到角色卡 ' + c.roleCard + '，用通用人格写'); }

  // 材料一：她记得的人（最多三个人，避免 prompt 过长）
  const dump = memory.dump();
  const ids = Object.keys(dump.people || {}).slice(0, 3);
  const peopleText = ids.map((id) => memory.renderPerson(id)).filter(Boolean).join('\n');

  // 材料二：最近 20 小时真聊过的话
  const turns = memory.recentTurns(60, { sinceMs: 20 * 3600 * 1000 });
  const talkText = turns.length
    ? '【最近聊过的】\n' + turns.map((r) => {
        const bits = [];
        if (r.text) bits.push((r.who || '他') + '：' + r.text);
        if (r.reply) bits.push('你：' + r.reply);
        return '· ' + bits.join(' / ');
      }).join('\n')
    : '';

  // 材料三：她之前写过的
  const diaryText = diary.context(3, 3);
  const avoidText = diary.recent(8).map((r) => r.title || r.text.slice(0, 16)).filter(Boolean).join('；');

  const memoryText = [peopleText, talkText].filter(Boolean).join('\n\n');

  const out = await composeDiary({
    apiKey: c.apiKey,
    baseUrl: c.baseUrl,
    model: c.model,
    roleText,
    memoryText,
    diaryText,
    avoidText,
    maxChars: c.diaryMaxChars,
  });

  const row = diary.add({ text: out.text, title: out.title, mood: out.mood, tags: out.tags });
  console.log('[日记] ' + row.day + ' ' + row.time + (row.title ? '「' + row.title + '」' : ''));
  console.log('[日记] ' + row.text);
}

main().catch((e) => {
  console.error('[日记] 失败：' + (e?.message || e));
  process.exit(1);
});
