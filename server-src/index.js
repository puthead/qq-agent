/**
 * companion · 命令行入口
 * ─────────────────────────────────────────────────────────────
 * 把各层拼起来跑：
 *
 *   OneBot(收消息) → Waker(要不要醒) → Brain(生成回复，可带图、可调工具)
 *                                        ↓
 *                                   Humanizer(怎么发)
 *                                        ↓
 *                                   OneBot(发消息)
 *
 * 另外还挂着一个「主动」循环：闲久了、在合适的时间，她自己会开口。
 * 群里另有一条路：没人 @ 她、但群里聊得热闹时，她偶尔自己接一句（GroupChime 管闸门）。
 *
 * 用法：
 *   node src/index.js --config ./config.json
 *   node src/index.js --config ./config.json --dry-run        只打印，不真发
 *   node src/index.js --check                                 只检查角色卡
 *   node src/index.js --proactive-once                        立刻试一次主动说话
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Memory } from './memory.js';
import { ConversationMemory } from './conversation-memory.js';
import { startHealth } from './service-health.js';
import { Role } from './role.js';
import { Brain } from './brain.js';
import { Humanizer } from './humanize.js';
import { Waker } from './wake.js';
import { OneBot } from './transport-onebot.js';
import { ReplyGate, SpeechBudget, SendPacer } from './throttle.js';
import { GroupContext } from './group-context.js';
import { RecentMedia } from './recent-media.js';
import { createAvatarSession, isAvatarTopic } from './qq-avatar.js'; /* avatar-feature-20261025 */
import { prepareAvatarTurn } from './avatar-context.js';
import { expandAddressedBatch } from './group-addressing.js';
import { GroupStyle } from './group-style.js';
import { QQSocial } from './qq-social.js';
import { readForwards } from './forward-context.js';
import { GroupChime } from './group-chime.js';
import { GroupScheduler } from './group-scheduler.js';
import { StickerBook } from './stickers.js';
import { hasTextAnchor } from './dialogue-policy.js';
import { RobotFilter } from './robot-filter.js';
import { HistoryBackfill } from './history-backfill.js';
import { LearningCycle } from './learning-cycle.js';
import { OwnerCommands } from './owner-commands.js';
import { setSelfName, selfName } from './identity.js';
import { setMounts } from './transport-onebot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ──────────────────────────────────────────────────────
export function loadConfig(explicitPath) {
  const file = explicitPath || path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { console.error('⚠️ 读不到 ' + file + '，用默认值（复制 config.example.json 改名即可）'); }
  const dir = path.dirname(path.resolve(file));
  const rel = (p, def) => (p ? path.resolve(dir, p) : path.join(dir, def));
  const dataDir = rel(cfg.dataDir, 'data');

  const names = (cfg.names || []).map(String).filter(Boolean);
  setSelfName(names[0]);
  // Docker 里的 NapCat 用容器路径，配置里给了映射就覆盖默认
  setMounts(cfg.onebot?.mounts);

  return {
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
    model: cfg.model || 'deepseek-chat',

    roleCard: rel(cfg.roleCard, 'role.md'),
    roleMaxChars: cfg.roleMaxChars || 12000,
    dataDir,

    onebot: {
      wsUrl: cfg.onebot?.wsUrl || 'ws://127.0.0.1:3001',
      httpUrl: cfg.onebot?.httpUrl || 'http://127.0.0.1:3000',
      accessToken: cfg.onebot?.accessToken || '',
    },

    names,
    keywords: cfg.keywords || [],
    ownerIds: (cfg.ownerIds || []).map(String),

    wake: {
      probability: cfg.wake?.probability ?? 0.05,
      groupAtOnly: cfg.wake?.groupAtOnly !== false,
      nameMention: cfg.wake?.nameMention === true,
      privateWindowMs: cfg.wake?.privateWindowMs ?? 2500,
      groupWindowMs: cfg.wake?.groupWindowMs ?? 5000,
    },

    // 说话节奏：同一个人/同一个群刚聊过，就别马上又开口
    limits: {
      privateCooldownMs: cfg.limits?.privateCooldownMs ?? 1500,
      groupCooldownMs: cfg.limits?.groupCooldownMs ?? 20000,
      globalPerMinute: cfg.limits?.globalPerMinute ?? 8,
      // 每个会话每分钟最多发几条（文字、分条、表情包都算）
      perMinute: cfg.limits?.perMinute ?? 3,
    },

    // 群聊上下文：看得到刚才在聊什么，但只留一小截
    groupContext: {
      enabled: cfg.groupContext?.enabled !== false,
      maxMessages: cfg.groupContext?.maxMessages ?? 24,
      maxChars: cfg.groupContext?.maxChars ?? 1400,
      maxAgeMs: cfg.groupContext?.maxAgeMs ?? 20 * 60 * 1000,
      // 两条消息隔这么久，渲染时插个空行：人看记录也是靠这个知道换话题了
      topicGapMs: cfg.groupContext?.topicGapMs ?? 6 * 60 * 1000,
    },

    // 群味：学着群里人的说法（长度、标点、反应词、真实例句）
    qqSocial: {
      enabled: cfg.qqSocial?.enabled !== false,
      reactionCooldownMs: cfg.qqSocial?.reactionCooldownMs ?? 20000,
      pokeCooldownMs: cfg.qqSocial?.pokeCooldownMs ?? 120000,
    },
    readForwards: cfg.readForwards !== false,
    groupStyle: {
      enabled: cfg.groupStyle?.enabled !== false,
      minSamples: cfg.groupStyle?.minSamples ?? 8,
      maxSamples: cfg.groupStyle?.maxSamples ?? 80,
      minSpeakers: cfg.groupStyle?.minSpeakers ?? 2,
      maxGroups: cfg.groupStyle?.maxGroups ?? 40,
      maxAgeMs: cfg.groupStyle?.maxAgeMs ?? 14 * 86400000,
      saveEveryMs: cfg.groupStyle?.saveEveryMs ?? 30000,
      botIds: cfg.groupStyle?.botIds ?? [],
    },

    thinking: {
      enabled: cfg.thinking?.enabled !== false,
      effort: ['low', 'high', 'max'].includes(String(cfg.thinking?.effort || '')) ? String(cfg.thinking.effort) : '',
    },
    temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 1.0,
    dialogue: cfg.dialogue || {},
    context: cfg.context || {},
    banter: cfg.banter || {},
    memory: cfg.memory || {},

    tools: {
      enabled: cfg.tools?.enabled !== false,
      rounds: cfg.tools?.rounds ?? 4,
    },

    vision: {
      enabled: cfg.vision?.enabled !== false,
      maxBytes: cfg.vision?.maxBytes ?? 6 * 1024 * 1024,
      pythonPath: cfg.vision?.pythonPath || 'python',
    },

    // 表情包：她自己那一叠。目录里没图就当没有这个能力。默认跟着 dataDir
    stickers: {
      enabled: cfg.stickers?.enabled !== false,
      dir: cfg.stickers?.dir ? path.resolve(dir, cfg.stickers.dir) : path.join(dataDir, 'stickers'),
      cooldownMs: cfg.stickers?.cooldownMs ?? 0,
      maxPerTurn: cfg.stickers?.maxPerTurn ?? 1,
      maxBytes: cfg.stickers?.maxBytes ?? 4 * 1024 * 1024,
      gapMs: cfg.stickers?.gapMs ?? 900,
    },

    proactive: {
      enabled: cfg.proactive?.enabled === true,
      quietHours: cfg.proactive?.quietHours || [0, 8],
      minIdleHours: cfg.proactive?.minIdleHours ?? 3,
      maxPerDay: cfg.proactive?.maxPerDay ?? 2,
      chance: cfg.proactive?.chance ?? 0.4,
      checkMinutes: cfg.proactive?.checkMinutes ?? 15,
    },

    // 两小时学习循环：总结记忆要点、收集群语料学说话习惯，写进角色卡学习区
    learning: {
      enabled: cfg.learning?.enabled !== false,
      intervalHours: Number.isFinite(Number(cfg.learning?.intervalHours)) ? Math.max(0.5, Math.min(24, Number(cfg.learning.intervalHours))) : 2,
      maxCorpusChars: Number.isFinite(Number(cfg.learning?.maxCorpusChars)) ? Math.max(5000, Math.min(120000, Number(cfg.learning.maxCorpusChars))) : 40000,
      maxDigestSessions: Number.isFinite(Number(cfg.learning?.maxDigestSessions)) ? Math.max(0, Math.min(6, Number(cfg.learning.maxDigestSessions))) : 3,
      maxLookbackHours: Number.isFinite(Number(cfg.learning?.maxLookbackHours)) ? Math.max(2, Math.min(72, Number(cfg.learning.maxLookbackHours))) : 12,
      report: ['fail', 'always', 'never'].includes(cfg.learning?.report) ? cfg.learning.report : 'fail',
    },

    // 群聊插话：没人 @ 她的时候，偶尔自己接一句。
    // 「时间限制 / 次数限制」的硬闸门全在 GroupChime 里，这里只是把配置摊平。
    groupChime: {
      enabled: cfg.groupChime?.enabled === true,
      quietHours: cfg.groupChime?.quietHours || [0, 8],
      windowMinutes: cfg.groupChime?.windowMinutes ?? 10,
      minMessages: cfg.groupChime?.minMessages ?? 6,
      minSpeakers: cfg.groupChime?.minSpeakers ?? 2,
      // 群里这么久没人说话就不接：死群不回复
      idleMinutes: cfg.groupChime?.idleMinutes ?? 6,
      // 活跃度分档：每分钟几条算一般热闹 / 很热闹
      warmRate: cfg.groupChime?.warmRate ?? 0.7,
      hotRate: cfg.groupChime?.hotRate ?? 1.5,
      minGapMinutes: cfg.groupChime?.minGapMinutes ?? 15,
      maxPerGroupPerDay: cfg.groupChime?.maxPerGroupPerDay ?? 8,
      // 热闹群每天额外多几次
      hotExtraPerDay: cfg.groupChime?.hotExtraPerDay ?? 3,
      maxPerDay: cfg.groupChime?.maxPerDay ?? 16,
      maxPerMinute: cfg.groupChime?.maxPerMinute ?? -1,
      chance: cfg.groupChime?.chance ?? 0.25,
      declineGapMinutes: cfg.groupChime?.declineGapMinutes ?? 5,
      allowGroups: cfg.groupChime?.allowGroups || [],
      blockGroups: cfg.groupChime?.blockGroups || [],
      // 一个群安静下来多久才评估（人还在打下一句，就先别急着插）
      lingerMs: cfg.groupChime?.lingerMs ?? 6000,
      // 一直有人说话时，最多等这么久就评估一次，免得永远等不到安静
      maxWaitMs: cfg.groupChime?.maxWaitMs ?? 30000,
    },

    humanize: cfg.humanize || {},
    dryRun: process.argv.includes('--dry-run'),
  };
}

/**
 * dataDir 只允许一个实例。
 * 以前同时跑了两份（手工起的 + systemd 的），各自连着网关，一条消息回两遍。
 * 用 pid 文件挡住第二个。
 */
export function acquireLock(dir) {
  const file = path.join(dir, 'companion.lock');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }

  const alive = (pid) => {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
  };

  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(old.pid) !== process.pid && alive(Number(old.pid))) {
      console.error('⚠️ 已经有一个 companion 在跑（pid ' + old.pid + '，' + (old.startedAt || '启动时间不明') + '）。');
      console.error('   同一个 dataDir 只能有一个实例，否则一句话会被回两遍。这个进程退出。');
      process.exit(0);
    }
  } catch { /* 没有锁文件或已损坏，直接接管 */ }

  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  const release = () => {
    try {
      const now = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number(now.pid) === process.pid) fs.unlinkSync(file);
    } catch { /* 忽略 */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(0); });
  }
}

// ── 主程序 ────────────────────────────────────────────────────
async function main() {
  const cfgIdx = process.argv.indexOf('--config');
  const cfg = loadConfig(cfgIdx >= 0 ? process.argv[cfgIdx + 1] : null);

  // 同一个数据目录只允许一个实例：两个进程同时连网关，就会一句话回两遍
  acquireLock(cfg.dataDir);

  // 表情包目录：丢图进去就能用，不用改代码（服务端每 30 秒重扫一次）
  const stickers = cfg.stickers.enabled ? new StickerBook(cfg.stickers) : null;

  console.log('════════ companion ════════');
  console.log('  模型      ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('  角色卡    ' + cfg.roleCard);
  console.log('  数据目录  ' + cfg.dataDir);
  console.log('  OneBot    ' + cfg.onebot.wsUrl);
  console.log('  名字      ' + (cfg.names.join(' / ') || '（没配）'));
  console.log('  主人      ' + (cfg.ownerIds.join(', ') || '（没配）'));
  console.log('  工具      ' + (cfg.tools.enabled ? '开（搜索/抓网页/天气/时间/记）' : '关'));
  console.log('  看图      ' + (cfg.vision.enabled ? '开' : '关'));
  console.log('  表情包    ' + (!stickers ? '关'
    : stickers.size ? stickers.size + ' 张（' + cfg.stickers.dir + '）'
      : '目录里没图（' + cfg.stickers.dir + '），丢几张进去就能用'));
  console.log('  主动说话  ' + (cfg.proactive.enabled
    ? '开（静默 ' + cfg.proactive.minIdleHours + ' 小时后、每天最多 ' + cfg.proactive.maxPerDay + ' 次、'
      + cfg.proactive.quietHours[0] + '–' + cfg.proactive.quietHours[1] + ' 点不说话）'
    : '关'));
  console.log('  思考      ' + (cfg.thinking.enabled ? '开（力度 ' + (cfg.thinking.effort || '服务端默认') + '）' : '关'));
  console.log('  说话节奏  私聊 ' + cfg.limits.privateCooldownMs + 'ms / 群 '
    + Math.round(cfg.limits.groupCooldownMs / 1000) + 's / 全局 ' + cfg.limits.globalPerMinute + ' 次每分钟'
    + ' / 每个会话每分钟最多 ' + cfg.limits.perMinute + ' 条');
  console.log('  群上下文  ' + (cfg.groupContext.enabled
    ? '开（最多 ' + cfg.groupContext.maxMessages + ' 条 / ' + cfg.groupContext.maxChars + ' 字 / '
      + Math.round(cfg.groupContext.maxAgeMs / 60000) + ' 分钟）'
    : '关'));
  console.log('  群味      ' + (cfg.groupStyle.enabled
    ? '开 v2（每群 ' + cfg.groupStyle.maxSamples + ' 条 / 至少 ' + cfg.groupStyle.minSpeakers + ' 人；重复校正 / 表达反馈）'
    : '关'));
  console.log('  群插话    ' + (cfg.groupChime.enabled
    ? '开（没人 @ 也按上下文接一句：安静 ' + cfg.groupChime.idleMinutes + ' 分钟以上不接、同一群至少隔 '
      + cfg.groupChime.minGapMinutes + ' 分钟、连着说 ' + (cfg.groupChime.maxStreak ?? 2) + ' 轮没人搭腔就收着、每群每天 '
      + (cfg.groupChime.maxPerGroupPerDay < 0 ? '不限' : cfg.groupChime.maxPerGroupPerDay) + ' 次（热闹群 +'
      + cfg.groupChime.hotExtraPerDay + '）、全部每天 ' + (cfg.groupChime.maxPerDay < 0 ? '不限' : cfg.groupChime.maxPerDay) + ' 次、滚动一分钟最多 ' + cfg.groupChime.maxPerMinute + ' 轮、'
      + cfg.groupChime.quietHours[0] + '–' + cfg.groupChime.quietHours[1] + ' 点不说）'
    : '关'));
  console.log('  干跑      ' + (cfg.dryRun ? '是（不会真发）' : '否'));
  console.log('  主人指令  ' + (cfg.ownerIds.length
    ? '开（/帮助 查看清单；只认主人私聊）'
    : '关（没配 ownerIds）'));
  console.log('  学习循环  ' + (cfg.learning.enabled
    ? '开（每 ' + cfg.learning.intervalHours + ' 小时：总结记忆要点、收群语料学说话习惯、更新角色卡学习区）'
    : '关'));
  console.log('');

  const memory = new ConversationMemory({ ...cfg.memory, dir: cfg.dataDir });
  const role = new Role({ cardPath: cfg.roleCard, maxChars: cfg.roleMaxChars });

  // 角色卡体检
  const lint = role.lint();
  if (!lint.ok) {
    console.log('⚠️ 角色卡检查：');
    lint.warn.forEach((w) => console.log('   · ' + w));
    console.log('');
  }
  if (process.argv.includes('--check')) { console.log('检查完毕。'); return; }
  if (!cfg.apiKey) console.log('⚠️ 没配 apiKey，模型调用会失败\n');

  const brain = new Brain({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    role,
    memory,
    tools: cfg.tools.enabled,
    toolRounds: cfg.tools.rounds,
    ownerIds: cfg.ownerIds,
    stickers,
    thinking: cfg.thinking.enabled,
    effort: cfg.thinking.effort,
    temperature: cfg.temperature,
    dialogue: cfg.dialogue,
    context: cfg.context,
    banter: cfg.banter,
    vision: cfg.vision,
  });
  const human = new Humanizer(cfg.humanize);
  const gate = new ReplyGate(cfg.limits);
  const budget = new SpeechBudget({ perMinute: cfg.limits.perMinute });
  const groupCtx = new GroupContext(cfg.groupContext);
  const recentMedia = new RecentMedia();
  // 群味：群里人怎么说话（长度/标点/反应词/例句），落在 dataDir/group-style.json，重启接着学
  const groupStyle = cfg.groupStyle.enabled
    ? new GroupStyle({ ...cfg.groupStyle, dataDir: cfg.dataDir })
    : null;
  process.on('exit', () => groupStyle?.close());
  const social = new QQSocial(cfg.qqSocial);
  console.log('  QQ互动    ' + (cfg.qqSocial.enabled ? '开（贴表情 / 戳一戳）' : '关') + '；合并转发读取 ' + (cfg.readForwards ? '开' : '关'));
  const chime = cfg.groupChime.enabled
    ? new GroupChime({ ...cfg.groupChime, dataDir: cfg.dataDir })
    : null;
  const waker = new Waker({
    names: cfg.names,
    keywords: cfg.keywords,
    ownerIds: cfg.ownerIds,
    probability: cfg.wake.probability,
    batchWindowMs: cfg.wake.groupWindowMs,
  });

  /**
   * 主人是哪些号。
   * 群昵称随时能改、每个群还不一样，只有 QQ 号是不变的——认人只认这个。
   * 昵称的作用只剩「怎么称呼他」。
   */
  const ownerSet = new Set(cfg.ownerIds.map(String));

  /** 上一次有人说话的时间（主动说话要算这个） */
  const lastTurn = memory.recentTurns(1)[0];
  const activity = { at: lastTurn?.t || Date.now() };

  /** @type {Map<string, NodeJS.Timeout>} 每个会话的合并定时器 */
  const pending = new Map();

  const chimeScheduler = new GroupScheduler({ run: runChime,
    allowed: key => !!chime?.allowed(key), delayMs: cfg.groupChime.lingerMs, maxWaitMs: cfg.groupChime.maxWaitMs,
    onError: e => console.error('[群插话] ' + (e?.message || e)) });

  /**
   * 群里又有人说话：把评估往后推。
   * 人还在打下一句的时候插嘴最招人烦，所以等一小会儿；但等太久就干脆不等了，
   * 不然一个聊不停的群永远等不到「安静」，插话就永远不会发生。
   */
  function scheduleChime(key) {
    chimeScheduler.schedule(key);
  }

  /** 有人叫她 / 已经回过话了：把待插话的那次撤掉，别一会儿又冒一句 */
  function dropChime(key) {
    chimeScheduler.drop(key);
  }

  /** @type {Map<string, string>} 各群上一次「不说」的原因：只在原因变了才写日志，热闹的群不至于把日志刷满 */
  const chimeLastWhy = new Map();

  /** 到点了：先过硬闸门，过了再问模型「要不要插一句」 */
  async function runChime(key) {
    if (!chime || pending.has(key)) return;
    const verdict = chime.shouldChime(key);
    if (!verdict.ok) {
      if (chimeLastWhy.get(key) !== verdict.code) {
        chimeLastWhy.set(key, verdict.code);
        console.log('[群插话·不说] ' + key + '（' + verdict.reason + '）');
      }
      return;
    }
    chimeLastWhy.delete(key);
    const r = await runGroupChimeTurn({ bot, brain, human, memory, gate, budget, groupCtx, groupStyle, social, chime, key, ownerIds: cfg.ownerIds, verdict, waker, recentMedia }, cfg);
    if (!r.spoke && r.reason) console.log('[群插话·' + r.reason + '] ' + key);
  }

  // 机器人号段过滤 + 断线补历史：bot 在下面创建，连上后（含每次重连）再挂引用并触发
  const robotFilter = new RobotFilter({});
  const backfill = new HistoryBackfill({ memory, groupCtx, robotFilter });

  // 主人指令 + 两小时学习循环：都要往 QQ 回话，bot 创建后回填
  const learningCycle = new LearningCycle({
    ...cfg.learning, dataDir: cfg.dataDir, cardPath: cfg.roleCard,
    apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model,
    memory, ownerIds: cfg.ownerIds, dryRun: cfg.dryRun,
  });
  const ownerCommands = new OwnerCommands({
    ownerIds: cfg.ownerIds, memory, learning: learningCycle,
    dataDir: cfg.dataDir, dryRun: cfg.dryRun,
  });

  const bot = new OneBot({
    ...cfg.onebot,
    onOpen: () => {
      robotFilter.bot = bot;
      backfill.bot = bot;
      robotFilter.ensure().catch(() => {});
      backfill.run().catch((e) => console.log('[补历史] ' + (e?.message || e)));
    },
    /**
     * 自己这个号发出去的消息（包括你拿手机、别的客户端手动发的）也要记账。
     * 不记的话，她下一轮就真的不知道「这张图是我发的」——只能反过来问你哪张。
     */
    onSelfMessage: (msg) => {
      const last = memory.recentTurns(1)[0];
      if (last && last.where === msg.key && last.reply === msg.text && Date.now() - last.t < 120000) return;
      if (msg.isGroup && cfg.groupContext.enabled) {
        groupCtx.add(msg.key, { messageId: msg.messageId, name: selfName(), text: msg.text, isSelf: true });
      }
      memory.logTurn({ where: msg.key, who: selfName(), text: '', reply: msg.text });
      activity.at = Date.now();
      console.log('[我自己发了] ' + msg.key + ' ' + msg.text.slice(0, 40));
    },
    onMessage: (msg) => {
      if (msg.isGroup && msg.messageId && groupCtx.liveRows(msg.key).some(r => String(r.messageId) === String(msg.messageId))) return;
      // 官方机器人号段的发言：归档备查，但不学说话、不进群背景、不接话、不算热闹
      if (robotFilter.isRobot(msg.userId)) {
        if (!cfg.dryRun) memory.observe({ ...msg, selfId: bot.selfId, isRobot: true });
        logRoute(msg, 'skipped', { reason: 'robot' });
        return;
      }
      activity.at = Date.now();
      if (!cfg.dryRun) memory.observe({...msg,selfId:bot.selfId,isBot:msg.isBot||(cfg.groupStyle.botIds||[]).map(String).includes(String(msg.userId))});
      // 潜水期间的图片也要记住；不能等到唤醒处理轮才缓存。
      if (!cfg.dryRun) recentMedia.observe({...msg,isBot:msg.isBot||(cfg.groupStyle.botIds||[]).map(String).includes(String(msg.userId))});

      // 主人一开口就把他在这个群的名片记下来：认人认 QQ 号，名片只用来称呼。
      // 不同群名片不一样，所以按群号存一份，别拿一张名片当身份证。
      if (msg.isGroup && ownerSet.has(String(msg.userId))) {
        if (memory.noteAlias(msg.userId, { groupId: msg.groupId, name: msg.name })) {
          console.log('[主人] 群 ' + msg.groupId + ' 里的名片是「' + msg.name + '」');
        }
      }

      // 主人指令：/ 开头的命令只认主人私聊，直接执行不走聊天生成；群里同样的字是普通聊天
      if (!msg.isGroup && ownerCommands.handle(msg)) return;

      // 群聊里每条消息都记进上下文账本（包括没叫她的），被叫到时才接得上话
      if (msg.isGroup && cfg.groupContext.enabled) {
        groupCtx.add(msg.key, {
          messageId: msg.messageId,
          name: msg.name,
          userId: msg.userId,
          text: msg.text,
          images: msg.images,
          forwards: msg.forwards,
          // 人看群消息看的是「谁在跟谁说话」：这条在回谁、@ 了谁
          replyTo: msg.replyTo,
          atIds: msg.atIds,
          selfId: bot.selfId,
          time: msg.time,
        });
      }

      // 群味：把群友真怎么说话记下来（她自己说的不算，纯 @、表情、脏话也不算）
      if (msg.isGroup && groupStyle && !msg.isPoke) groupStyle.observe(msg.key, { ...msg, selfId: bot.selfId });

      // 群聊插话要知道「现在热不热闹」：谁在说、说了几条
      if (msg.isGroup && chime) chime.observe(msg.key, { userId: msg.userId });

      // 第一次见到这个会话 → 给个默认策略
      if (!waker.configs.has(msg.key)) {
        waker.setConfig(msg.key, msg.isGroup
          ? {
              mode: 'diving',
              atMention: true,
              nameMention: cfg.wake.nameMention || !cfg.wake.groupAtOnly,
              question: !cfg.wake.groupAtOnly,
              poke: true,
              probability: cfg.wake.groupAtOnly ? 0 : cfg.wake.probability,
            }
          : { mode: 'active', anyMessage: true });   // 私聊每条都理
      }

      const verdict = routeMessage(msg, waker, groupCtx, cfg.groupStyle.botIds);
      if (verdict.reason === 'quoteRelay') return;
      if (verdict.continuation) msg = { ...msg, continuation: verdict.continuation };
      const isOwner = cfg.ownerIds.includes(msg.userId);
      // 主人「说话必醒」只在私聊里算数；在群里跟别人一样，要 @ 或叫名字
      const ownerPrivilege = isOwner && !msg.isGroup;
      if (!verdict.wake && !ownerPrivilege) {
        // 没人叫她：过一会儿看看要不要自己插一句（硬条件在 GroupChime 里）
        if (msg.isGroup) scheduleChime(msg.key);
        return;
      }

      // 叫她了就不用自己找话说了，把待插话的那次撤掉
      dropChime(msg.key);
      logRoute(msg, verdict.continuation ? 'continuation-candidate' : 'direct', { reason: verdict.reason });
      if (chimeScheduler.isBusy(msg.key)) {
        queueLate(msg);
        logRoute(msg, 'queued', { reason: 'chime-busy' });
        return;
      }

      // 刚说过话就先闭嘴：重复投递、连着刷屏都挡在这
      const ticket = gate.check(msg.key, msg.isGroup);
      if (!ticket.ok) {
        // 「正在说」不是刷屏，是来晚了一步：排上队，等这一轮说完再补（见 drainLateQueue）
        if (ticket.reason === '正在说') {
          queueLate(msg);
          logRoute(msg, 'queued', { reason: ticket.reason });
          console.log('[排队·' + ticket.reason + '] ' + msg.name + '：' + msg.text.slice(0, 40));
          return;
        }
        logRoute(msg, 'skipped', { reason: ticket.reason });
        console.log('[略过·' + ticket.reason + '] ' + msg.name + '：' + msg.text.slice(0, 40));
        return;
      }
      console.log('[醒·' + (verdict.reason || 'owner') + '] ' + msg.name + '：' + msg.text.slice(0, 60));

      // 合并窗口：等人把话说完
      const win = msg.isGroup ? cfg.wake.groupWindowMs : cfg.wake.privateWindowMs;
      clearTimeout(pending.get(msg.key));
      waker.batch(msg);
      pending.set(msg.key, setTimeout(() => {
        pending.delete(msg.key);
        const items = waker.flush(msg.key);
        if (!items.length) return;
        handleTurn({ bot, brain, human, memory, waker, gate, budget, groupCtx, groupStyle, social, chime, recentMedia }, items, cfg)
          .catch((e) => console.error('[出错] ' + (e?.message || e)));
      }, win));
    },
  });

  ownerCommands.bot = bot;
  learningCycle.bot = bot;

  const pacer = new SendPacer({ perMinute: cfg.limits.perMinute });
  for (const method of ['send', 'sendSegments', 'sendSocial']) {
    const original = bot[method].bind(bot);
    bot[method] = (key, ...args) => pacer.send(key, () => original(key, ...args));
  }
  startProactive({ bot, brain, human, memory, cfg, activity, budget });
  learningCycle.start();
  if (!cfg.dryRun) startHealth({ bot, memory, brain, activity });

  process.on('unhandledRejection', (e) => console.error('[未处理] ' + (e?.message || e)));
  process.on('SIGINT', () => { console.log('\n再见。'); process.exit(0); });

  console.log('在跑了。Ctrl+C 退出。\n');
}

/**
 * 把大脑攒下的表情包发出去。
 * 文字已经发完了，这里只补图；一张失败不影响这一轮别的，也不回滚已经说出去的话。
 * 返回真发出去的张数。
 */
export async function sendStickers(book, actions, { key, bot, dryRun = false, onSent, limit } = {}) {
  if (!book) return 0;
  const pics = (Array.isArray(actions) ? actions : []).filter((a) => a && a.type === 'sticker');
  if (!pics.length) return 0;
  // 文字已经占掉这条消息配额时，图就少发/不发，别把「每分钟 3 条」顶穿
  const room = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : Infinity;
  const max = Math.max(0, Math.min(book.maxPerTurn, room));
  if (!max) return 0;
  if (dryRun) {
    console.log('   [干跑] 会发 ' + Math.min(pics.length, max) + ' 张表情包：' + pics.map((p) => p.id).join('、'));
    return 0;
  }
  let sent = 0;
  for (const p of pics.slice(0, max)) {
    const seg = book.segment(p.id) || (p.path && book.segment(p.path)) || null;
    if (!seg) { console.log('   （表情包读不到：' + p.id + '）'); continue; }
    try {
      if (book.gapMs) await new Promise((r) => setTimeout(r, book.gapMs));
      const res = await bot.sendSegments(key, Array.isArray(seg) ? seg : [seg]);
      if (!res?.ok) { console.log('   （表情包没发出去：' + p.id + ' ' + (res?.error || '') + '）'); continue; }
      sent++;
      book.markSent(key);
      try { onSent?.({ id: p.id, key }); } catch { /* 记账失败不影响发图 */ }
    } catch (e) {
      console.log('   （表情包发失败：' + (e?.message || e) + '）');
    }
  }
  return sent;
}

/**
 * 这一轮文字最多分几条：额度不够时并条；想发表情包就留一条给图。
 * 不 reserve 的话，正文把 3 条额度吃满，表情包就永远发不出来。
 */
async function sendQQInteraction(social, actions, { key, bot, memory, groupCtx, limit }) {
  if (!social) return 0;
  return social.send(actions, { key, bot, limit, onSent: a => {
    const line = a.kind === 'poke' ? '[QQ互动] 戳了当前群友一下' : '[QQ互动] 给消息贴了表情';
    memory.logTurn?.({ where: key, who: selfName(), text: '', reply: line });
    groupCtx?.add(key, { name: selfName(), text: line, isSelf: true });
    console.log(line);
  }});
}

function bubbleCap(room, human, actions) {
  if (!Number.isFinite(room)) return undefined;
  const wantsSticker = (Array.isArray(actions) ? actions : []).some((a) => a && a.type === 'sticker');
  const wantsSocial = (Array.isArray(actions) ? actions : []).some(a => a?.type === 'qq_social');
  const cap = Math.max(1, room - (wantsSticker ? 1 : 0) - (wantsSocial ? 1 : 0));
  return Math.min(cap, human.burstMax || cap);
}

/**
 * 把聊天里收到的一张图收进她自己的表情包库。
 * 名字她起，标签是情绪词；同一张图只存一遍，重名自动加序号。
 * @returns {Promise<string>} 给模型看的一句话结果
 */
export async function saveIncomingSticker({ bot, book, seg, name, tags, dryRun = false, onSaved }) {
  if (!book) return '（我这边没有表情包库，存不了）';
  if (!seg) return '这轮没人发图，没有图可以存。';
  if (dryRun) return '（干跑）本来会把这张存成「' + name + '」。';
  const got = await bot.imageBytes?.(seg, { maxBytes: book.maxBytes || 4 * 1024 * 1024 }).catch(() => null);
  if (!got) return '这张图我拿不到（没下载下来，或者太大了）。';
  const r = book.save({
    name,
    tags: String(tags || '').split(/[,，、/\s]+/).filter(Boolean),
    buffer: got.buffer,
    mime: got.mime,
  });
  if (!r.ok) return r.reason;
  try { onSaved?.({entry:r.entry,duplicate:!!r.duplicate}); } catch { console.warn('[存图] 图片已保存，但操作记录写入失败'); }
  if (r.duplicate) return '这张我已经存过了，叫「' + r.entry.id + '」，现在就能发。';
  console.log('   [存图] ' + name + ' → ' + r.entry.file + '（' + Math.round(got.buffer.length / 1024) + 'KB）');
  return '存好了，叫「' + r.entry.id + '」。以后想发就用 send_sticker 挑它。对方明确要求保存时简短确认；自行收藏不用特意宣布。';
}

/** 处理一轮（可能是合并后的多条） */
export function routeMessage(msg, waker, groupCtx, botIds = []) {
  if (msg.isRobot) return { wake: false, reason: 'robot' };
  const verdict = waker.shouldWake(msg, { ignoreOwner: msg.isGroup });
  if (verdict.wake || verdict.reason === 'quoteRelay' || !msg.isGroup || msg.isBot || (botIds || []).map(String).includes(String(msg.userId))) return verdict;
  const continuation = groupCtx?.continuationCandidate?.(msg.key, msg);
  return continuation ? { wake: true, reason: 'continuation', continuation } : verdict;
}

function logRoute(msg, event, detail = {}) {
  console.log('[路由] ' + JSON.stringify({ at: new Date().toISOString(), key: msg.key, messageId: String(msg.messageId || ''), senderId: String(msg.userId || ''), event, ...detail }));
}

export async function handleTurn({ bot, brain, human, memory, waker, gate, budget, groupCtx, groupStyle, social, chime, recentMedia }, items, cfg) {
  items = items.filter(m => !m.messageId || !groupCtx?.liveRows?.(m.key)?.some(r => String(r.messageId) === String(m.messageId) && (r.answered || r.evaluated)));
  const addressed = expandAddressedBatch(items, groupCtx);
  items = addressed.items;
  if (!items.length) return;
  const last = items[items.length - 1];
  const key = last.key;
  const startedAt = Date.now();
  const continuation = items.every(m => m.continuation) ? last.continuation : null;
  const noteReply = text => last.isGroup && groupCtx?.noteReplyTarget?.(key, { userIds: items.map(m => m.userId), messageIds: items.map(m => m.messageId), text });
  if(!cfg.dryRun)for(const it of items)recentMedia?.observe(it);
  const owners = new Set(((cfg && cfg.ownerIds) || []).map(String));
  const isOwner = owners.has(String(last.userId));
  // 每句话都标出说话的人是谁：群里光看群名片她认不出哪个是主人
  const text = Waker.joinBatch(items, { ownerIds: cfg && cfg.ownerIds });

  // 每个会话每分钟最多 3 条：额度用完了这轮就彻底闭嘴，连表情包也不发
  let room = (budget && !cfg.dryRun) ? budget.left(key) : Infinity;
  if (room <= 0) {
    logRoute(last, 'skipped', { reason: 'speech-budget' });
    console.log('   （这一分钟已经回了 ' + (cfg.limits?.perMinute ?? 3) + ' 条，这轮先不说）');
    return;
  }

  // 排队这几秒里可能已经有另一拨消息先说了，再说一遍就是刷屏
  if (gate) {
    const ticket = gate.check(key, last.isGroup);
    if (!ticket.ok) {
      if (ticket.reason === '正在说') items.forEach(queueLate);
      logRoute(last, ticket.reason === '正在说' ? 'queued' : 'skipped', { reason: ticket.reason });
      return;
    }
    // 等闸门的这几秒里额度可能被别的轮次吃掉，发之前按最新额度重算
    room = (budget && !cfg.dryRun) ? budget.left(key) : Infinity;
    if (room <= 0) {
      console.log('   （这一分钟已经回了 ' + (cfg.limits?.perMinute ?? 3) + ' 条，这轮先不说）');
      return;
    }
    gate.begin(key);
  }

  let spoke = false;
  if (last.isGroup && !cfg.dryRun) groupCtx?.beginTurn?.(key, items);
  try {
    // ── 图：这一轮新发的、和被引用的旧图，都要真的变成模型能看的 data URL ──
    // 以前只处理 last.images，于是「他引用了一张图问你这是不是你」时她手里一张图都没有，
    // 只能回「图我这边看不见」。线上那次就是这么来的。
    const avatarTurn = await prepareAvatarTurn({items,ownerIds:cfg.ownerIds||[],memory,bot,dataDir:cfg.dataDir});
    const avatar = createAvatarSession({ ...avatarTurn, ownerIds: cfg.ownerIds || [], recentMedia, bot, dataDir: cfg.dataDir, dryRun: cfg.dryRun });
    const vision = cfg.vision.enabled !== false;
    const nowPics = [];
    const nowSegments = [];
    const currentImages = items.flatMap(it => it.images || []);
    const followupImages = avatar?.source && avatar.linkedImages.length ? avatar.linkedImages : !currentImages.length && !items.some(it=>it.replyTo||it.quoted)
      ? recentMedia?.forFollowup(items) || [] : [];
    const incomingImages = [...currentImages,...followupImages.map(r=>r.seg)];
    const sourceIds = new Map();
    for(const it of items)for(const seg of it.images||[])sourceIds.set(seg,String(it.messageId||''));
    for(const r of followupImages)sourceIds.set(r.seg,r.messageId);
    if (vision) {
      for (const d of incomingImages.slice(0, 4)) {
        const url = await bot.imageToDataUrl(d, { maxBytes: cfg.vision.maxBytes }).catch(() => null);
        if (url) { nowPics.push(url); nowSegments.push(d); if (d === avatar?.source?.seg) avatar.bindPreview(url); }
        else console.log('   （这张图没取到，按文字处理）');
      }
    }

    // 合并窗口里每一条都可能带着引用，只认最后一条会漏掉
    const quotes = [];
    const seenQuote = new Set();
    for (const it of items) {
      const q = it.quoted;
      if (!q) continue;
      const k = q.id || q;   // 老调用只给对象没给 id 也别丢
      if (seenQuote.has(k)) continue;
      seenQuote.add(k);
      quotes.push(q);
      for(const seg of q.images||[])sourceIds.set(seg,String(q.id||''));
    }

    // 引用的图也进视野：这一轮的图优先，剩下的位子最多给引用 2 张
    const qQuota = Math.min(2, Math.max(0, 4 - nowPics.length));
    const loadedAvatarQuote = avatar?.source && nowSegments.includes(avatar.source.seg)
      && items.some(it => String(it.replyTo || '') === avatar.source.messageId) ? avatar.source.messageId : '';
    const quotePics = [];
    const quoteSegments = [];
    if (vision && qQuota) {
      for (const q of quotes) {
        if (String(q.id) === loadedAvatarQuote) continue;
        for (const d of (q.images || []).slice(0, 2)) {
          if (quotePics.length >= qQuota) break;
          const url = await bot.imageToDataUrl(d, { maxBytes: cfg.vision.maxBytes }).catch(() => null);
          if (url) { quotePics.push(url); quoteSegments.push(d); }
          else console.log('   （引用的那张图没取到，只能按文字说）');
        }
      }
    }
    const qTake = quotePics.slice(0, qQuota);
    const nTake = nowPics.slice(0, Math.max(0, 4 - qTake.length));
    const pics = [...nTake, ...qTake];
    let refs = [...items.flatMap(m => m.forwards || []), ...quotes.flatMap(q => q.forwards || [])];
    if (!refs.length && last.isGroup && /转发|聊天记录|看看里面/.test(text)) refs = groupCtx?.recentForwards?.(key) || [];
    const forward = cfg.readForwards !== false && refs.length ? await readForwards(bot, refs) : { note: '', images: [] };
    const forwardSegments = [];
    if (vision) for (const seg of forward.images) {
      if (pics.length >= 4) break;
      const image = await bot.imageToDataUrl(seg, { maxBytes: cfg.vision.maxBytes }).catch(() => null);
      if (image) { pics.push(image); forwardSegments.push(seg); }
    }
    const forwardNote = forward.note ? forward.note + '\n转发内附图成功载入 ' + forwardSegments.length + ' 张；没有载入的图片和音视频不能猜内容。' : '';
    const askedNow = incomingImages.length;
    const askedQuote = quotes.filter(q => String(q.id) !== loadedAvatarQuote).reduce((n, q) => n + (q.images || []).length, 0);
    const missed = Math.max(0, askedNow - nTake.length) + Math.max(0, askedQuote - qTake.length);
    if (followupImages.length) console.log('[追图] '+JSON.stringify({key,messageId:last.messageId,sourceMessageIds:[...new Set(followupImages.map(r=>r.messageId))],loaded:nTake.length,missed}));

    // 群聊背景：她看得到刚才群里在聊什么，但只有一小截
    const previous = (last.isGroup && groupCtx)
      ? groupCtx.render(key, { excludeIds: items.map((m) => m.messageId).filter(Boolean), ownerIds: [...owners] })
      : '';

    // 群味：这个群的人怎么说话（多短、带不带标点、有没有「草/6/？」这种一个字就完事的回应）。
    // 这是「像不像人」的大头：她默认每条二十多字的完整两句，群里人一半不到十个字。
    const styleInput = { text: items.map(m => m.text || '').join('\n'), excludeIds: items.map(m => m.messageId).filter(Boolean) };
    const styleNote = (last.isGroup && groupStyle) ? groupStyle.render(key, styleInput) : '';
    const styleNudge = (last.isGroup && groupStyle) ? groupStyle.nudge(key, styleInput) : '';

    // 被引用的是哪一条：原话、原图的种类都摆出来，指代不能说没就没
    const quoteLines = quotes.map((q) => {
      const said = q.text
        ? '：' + q.text
        : (q.hasImage ? '：（一张图，没配字）' : '：（我这边读不出具体内容）');
      return q.isSelf
        ? '\n他引用了你自己之前发的那一条' + said + '。'
        : '\n他引用了「' + (q.name || '别人') + '」的那一条' + said + '。';
    }).join('');
    // 有 reply 段但那条查不到：别装没发生，也别瞎猜里面写了什么
    const quoteLost = items.some((it) => it.replyTo && !it.quoted)
      ? '\n他引用了一条旧消息，但那条我这边查不到（可能被撤回或删了）；别猜里面写了什么。'
      : '';
    const quoteHint = (quoteLines || quoteLost)
      ? '\n（引用给出了本轮指向的内容。结合引用和新话理解；只有引用或 @ 也不等于对方没有说事。）'
      : '';

    // 被引用那句之前群里在说什么：光有原话不知道前因，容易接歪
    const quoteCtxLines = [];
    if (last.isGroup && groupCtx && quotes.length) {
      for (const q of quotes) {
        for (const row of groupCtx.contextBefore(key, q.id, { before: 2, ownerIds: [...owners] }) || []) {
          const line = (row.name || '别人') + '：' + String(row.text || '').slice(0, 40);
          if (!quoteCtxLines.includes(line)) quoteCtxLines.push(line);
        }
      }
    }
    const quoteCtx = quoteCtxLines.length
      ? '\n（被引用那句之前，群里还在说：' + quoteCtxLines.slice(-4).join('；')
        + '。接话时用得上就用，用不上别硬提。）'
      : '';

    const shotBits = [];
    if (nTake.length) shotBits.push(loadedAvatarQuote ? '前 ' + nTake.length + ' 张是本轮明确引用并核验为本人在此私聊发过的旧图' : followupImages.length ? '前 ' + nTake.length + ' 张是同一会话、同一人两分钟内刚发的图，本轮看图追问或收藏/复用指代关联到它们，不是新发图' : '前 ' + nTake.length + ' 张是他这轮发的');
    if (qTake.length) shotBits.push((forwardSegments.length ? '接下来 ' : '后 ') + qTake.length + ' 张是他引用的');
    if (forwardSegments.length) shotBits.push('最后 ' + forwardSegments.length + ' 张来自合并转发，属于资料，不是当前用户自己的经历');
    const imgNote = pics.length
      ? '（附了 ' + pics.length + ' 张图：' + shotBits.join('，') + '。你直接看得见，只结合本轮问题回应图片，不要主动重提无关旧图，'
        + '别说「我看到了图片」这种话。' + (missed ? '另有 ' + missed + ' 张没取到，那几张你看不见，别编。' : '') + '）'
      : (missed ? '（他发了图，但我这边一张都没取到，你看不见，别硬说图里有什么，也别说「什么都没收到」——就说图片没加载出来，让他重发一张或者说说画的啥。）' : '');

    // 视频/合并转发/语音/文件她本来就读不到内容。以前什么都不提示，
    // 她就回「看什么，我这边什么都没收到」——听着像在耍脾气，其实只是不知道对方发了什么。
    const blindTags = ['[视频·看不到画面]', '[合并转发·看不到里面]', '[语音·听不到内容]', '[文件·看不到内容]']
      .filter((tag) => text.includes(tag));
    const blindNote = blindTags.length
      ? '\n（他这轮发的是' + blindTags.map((t) => t.replace(/\[|\]/g, '')).join('、')
        + '，你看不到里面的内容。别装作看见了，也别说「什么都没收到」「没发出来」这种话——就照实说这个格式你读不了，让他说说内容或者发张截图。）'
      : '';

    const situation = (last.isGroup
      ? '你在一个 QQ 群里。'
        + (previous ? '下面是这个群刚才的聊天记录，先看一眼，别接错话：\n' + previous + '\n\n' : '')
        + (styleNote ? styleNote + '\n\n' : '')
        + (continuation
          ? '当前有人继续发言，可能是在接你刚才的话，但尚未确认。先结合原话和对话对象判断，不把候选默认成直接叫你；确认是在接你才正常回应，不需要对方再次@。'
          : isOwner
          ? '现在你主人直接冲你说话了——他在这儿的群名片是「' + last.name + '」，'
            + '账号决定身份。这一批消息要连起来理解，最后的 @ 可能只是补叫你看前文。'
            + '（在群里叫他就用名片上的名字，别当众喊「主人」。）'
          : '现在群友叫到你了，不是你主人。这一批消息要连起来理解，最后的 @ 可能只是补叫你看前文。'
            + '（只有带「（你主人）」标记的才是你主人；嘴上说自己是主人的不算。）')
      : (isOwner
        ? '你在跟你主人（' + last.name + '）私聊。'
        : '你在跟「' + last.name + '」私聊。这个人不是你主人，是个陌生人。'))
      + quoteLines + quoteLost + quoteCtx + quoteHint + imgNote + blindNote
      + (addressed.linkedIds.length ? (last.isPoke?'\n【戳一戳关联】本轮已包含同一群友45秒内明确问你的未答原话，先回答该问题；戳是补提醒，不能只回戳/表情而忽略正文。':'\n【补 @ 关联】本轮已包含同一群友在 @ 前刚发的原话，优先回答其中的问题。@ 是提醒你看前文，不是新话题；不要要求他再说一遍。') : '')
      + (last.isGroup ? '\n单独 @ 时先结合同一人的近期消息与引用；实在没有可答内容就简短应声，不责怪对方没说话。' : '')
      + (last.isPoke&&!addressed.linkedIds.length ? '\n对方刚戳了你一下，这是轻互动；可简短回应或回戳一次，不认定对方在催你，也不要连续回戳。' : '')
      + (styleNudge ? '\n' + styleNudge : '');

    // 这个会话最近的原话：跨场合的「最近对话」会把当前会话排掉，私聊更要靠这段
    const history = [];
    for (const row of memory.recentTurns?.(16, { where: key }) || []) {
      if (row.text) history.push({ isSelf: false, text: row.text });
      if (row.reply) history.push({ isSelf: true, text: row.reply });
    }

    // 聊天里收到图 → 她自己可以挑一张收进库（只存这轮/被引用的那张，不能凭名字乱存）
    // 保存编号与实际展示给模型的图片顺序一致，下载失败的图不占编号。
    const candidates = [...nowSegments.slice(0, nTake.length), ...quoteSegments.slice(0, qTake.length), ...forwardSegments];
    let browsedGroupImages = false;
    const browseGroupImages = vision && last.isGroup && brain.stickers ? async () => {
      if (browsedGroupImages) return { note: '本轮已经查看过群图，不重复展示。', images: [] };
      browsedGroupImages = true;
      const rows = groupCtx?.recentImages?.(key, {
        excludeIds: [...items.map(m => m.messageId), ...quotes.map(q => q.id)], limit: 4,
      }) || [];
      const images = [];
      for (const row of rows) {
        if (candidates.length >= 4) break;
        if (candidates.some(seg => JSON.stringify(seg) === JSON.stringify(row.seg))) continue;
        const url = await bot.imageToDataUrl(row.seg, { maxBytes: cfg.vision.maxBytes }).catch(() => null);
        if (!url) continue;
        candidates.push(row.seg);
        images.push({ id: '群图 imageIndex=' + candidates.length, url });
      }
      return { note: images.length ? '这些是旧群图，仅供收藏，不是当前用户重新发送。用 save_sticker 按 imageIndex 收藏；回复仍围绕当前问题，不评论无关旧图。' : '近期没有可查看的群图。', images };
    } : undefined;
    let savedThisTurn = 0;
    const savedIndexes = new Set();
    const saveImage = (candidates.length || browseGroupImages) ? async ({ name, tags, imageIndex = 1 }) => {
      if (!Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > candidates.length) return '图片编号无效，请按本轮附图顺序从1开始选择。';
      if (savedIndexes.has(imageIndex)) return '这张本轮已经保存过，不用重复存。';
      if (savedThisTurn >= 3) return '这轮已经存好三张了，其余下轮再存。';
      const seg=candidates[imageIndex-1];
      const result = await saveIncomingSticker({ bot, book: brain.stickers, seg, name, tags, dryRun: cfg.dryRun,
        onSaved:({entry,duplicate})=>memory.recordStickerSave?.(key,{id:entry.id,file:entry.file,sourceMessageId:sourceIds.get(seg)||'',duplicate}) });
      if (result.startsWith('存好了') || result.startsWith('这张我已经存过')) {
        savedIndexes.add(imageIndex);
        savedThisTurn++;
      }
      return result;
    } : undefined;

    const { text: generatedOut, usedTools, reasoning, actions = [], skipped, scene } = await brain.reply({
      dryRun: cfg.dryRun,
      record: false,
      key, userId: last.userId, userName: last.name, text, images: pics, situation, history, saveImage, browseGroupImages, avatar, avatarTopic: isAvatarTopic(items), qqApi: bot,
      teachingText:isOwner?items.filter(m=>String(m.userId)===String(last.userId)).map(m=>m.text||'').join('\n'):'',
      routing: { targetMessageId: String(last.messageId || ''), senderId: String(last.userId || ''), continuation,
        messages: items.map(m => ({ id: String(m.messageId || ''), senderId: String(m.userId || ''), name: m.name, text: m.text, replyTo: String(m.replyTo || '') })),
        quotes: quotes.map(q => ({ id: String(q.id || ''), author: q.name, self: !!q.isSelf, text: q.text })) },
      attachments: forwardNote,
      socialSession: social ? actions => social.session({ key, last, actions, dryRun: cfg.dryRun }) : undefined,
    });
    if (skipped) {
      if (!cfg.dryRun) {
        groupCtx?.markEvaluated?.(key, items.map(m => m.messageId));
        if (skipped === 'ended') groupCtx?.endConversation?.(key, continuation);
      }
      logRoute(last, 'skipped', { reason: skipped, elapsedMs: Date.now() - startedAt });
      return;
    }
    let out = generatedOut;
    if (!cfg.dryRun) memory.logTurn({ where: key, who: last.name, userId: last.userId, text, reply: '' });
    if (!out && !actions.length) { console.log('   （没说话）'); return; }

    if (cfg.dryRun) {
      console.log('   [干跑] 会说：' + (out || '（只发图）'));
      await sendStickers(brain.stickers, actions, { key, bot, dryRun: true });
      return;
    }

    // 动作先执行并查结果；不能先说「戳了」再发现接口失败或额度用完。
    const socialAction = actions.find(a => a.type === 'qq_social');
    const socialSent = await sendQQInteraction(social, actions, { key, bot, memory, groupCtx, limit: room });
    if (socialSent) { budget?.record(key, socialSent); room -= socialSent; spoke = true; }
    if (socialAction && !socialSent) out = socialAction.kind === 'poke' ? '这次没戳出去' : '这次表情没贴上';
    if (room <= 0) out = '';
    const remainingActions = actions.filter(a => a.type !== 'qq_social');
    let r = { sent: 0, parts: [] };
    if (out) {
      r = await human.say(out, {
        setTyping: (on) => bot.setTyping(key, on),
        send: async (m) => {
          const result = await bot.send(key, m);
          if (result?.ok === false) throw new Error('消息发送失败：' + (result.error || 'OneBot 拒绝'));
          spoke = true;
          noteReply(m);
          memory.logTurn({ where: key, who: selfName(), text: '', reply: m });
          return result;
        },
        // 额度不够时把剩下的并成一条，别让「分条」把 3 条/分钟顶穿；有图就先留一条
        maxMessages: bubbleCap(room, human, remainingActions),
      });
      spoke = spoke || r.sent > 0;
      if (r.sent > 0 && last.isGroup) groupStyle?.observeSelf?.(key, r.parts.slice(0, r.sent).join(' '));

      // 自己说的话也记进群背景，不然下一轮她不知道自己刚说过
      if (r.sent > 0 && last.isGroup && groupCtx) {
        groupCtx.add(key, { name: selfName(), text: r.parts.slice(0, r.sent).join(' '), isSelf: true });
      }
    }

    // 话说完再补表情包；发不出来就算了，不耽误这轮
    const stickerSent = await sendStickers(brain.stickers, actions, {
      key,
      bot,
      limit: Number.isFinite(room) ? Math.max(0, room - r.sent) : undefined,
      onSent: ({ id }) => {
        // 发出去的图也要入账，不然下一轮她会真的以为「我今天没甩过图」
        const line = '[表情包] ' + id;
        noteReply(line);
        memory.logTurn?.({ where: key, who: last.name, text: '', reply: line });
        if (last.isGroup && groupCtx) groupCtx.add(key, { name: selfName(), text: line, isSelf: true });
      },
    });
    spoke = spoke || stickerSent > 0 || socialSent > 0;
    if (budget && !cfg.dryRun) budget.record(key, r.sent + stickerSent);

    console.log('   发出 ' + r.sent + ' 条：' + r.parts.map((p) => p.slice(0, 18)).join(' | ')
      + (stickerSent ? '  〔表情 ' + stickerSent + ' 张〕' : '')
      + (usedTools?.length ? '  〔用了 ' + usedTools.join(',') + '〕' : '')
      + (reasoning ? '  〔想了 ' + reasoning.length + ' 字〕' : '  〔没思考〕'));
    waker.wake(key);
    memory.touch(last.userId, { name: last.name });
    // 在群里正经回了一句：插话的间隔从这儿重新算，别转头又自己接一句
    if (spoke && last.isGroup) {
      chime?.noteReply?.(key);
      if (socialSent && !r.sent && !stickerSent) noteReply('[QQ互动]');
    }
    logRoute(last, spoke ? 'sent' : 'empty', { type: continuation ? 'continuation' : 'direct', mode: scene?.mode, elapsedMs: Date.now() - startedAt });
  } finally {
    if (last.isGroup && !cfg.dryRun) groupCtx?.finishTurn?.(key);
    if (spoke && last.isGroup) groupCtx?.markAnswered?.(key, items.map(m => m.messageId));
    if (gate) gate.finish(key, spoke);
    // 学到的东西顺手落盘（内部节流，30 秒最多写一次）
    groupStyle?.flush?.();
    // 这一轮收工了：把「正在说」时排下的那几句补回来
    drainLateQueue({ bot, brain, human, memory, waker, gate, budget, groupCtx, groupStyle, social, chime, recentMedia }, key, cfg);
  }
}

/**
 * 「正在说」时排下的那几句。
 * 以前 gate.check 挡掉就直接 return，被 @ 的那句就彻底没了——用户体感是「叫它它不理」。
 * 现在攒着，等当前这一轮收工再补一次；超过 2 分钟的直接扔（话早聊完了，补回去反而奇怪）。
 */
const lateQueue = new Map();
const lateTimers = new Set();

export function queueLate(msg) {
  const q = lateQueue.get(msg.key) || [];
  if (msg.messageId && q.some(it => String(it.msg.messageId) === String(msg.messageId))) return;
  q.push({ msg, at: Number(msg.time) || Date.now() });
  while (q.length > 6) logRoute(q.shift().msg, 'skipped', { reason: 'queue-capacity' });
  lateQueue.set(msg.key, q);
}

/** 这一轮说完了：把排下的补回来（同一批合并成一轮，用最新的上下文再判断一次） */
function drainLateQueue(deps, key, cfg) {
  const q = lateQueue.get(key);
  if (!q || !q.length || lateTimers.has(key)) return;
  lateTimers.add(key);
  // 稍等一下再补：别和刚才那轮的收尾、冷却、每分钟额度撞在同一个 tick 上
  const timer = setTimeout(() => {
    lateTimers.delete(key);
    const queued = lateQueue.get(key) || [];
    lateQueue.delete(key);
    const fresh = queued.filter(it => Date.now() - it.at < 120000).map(it => it.msg);
    queued.filter(it => Date.now() - it.at >= 120000).forEach(it => logRoute(it.msg, 'skipped', { reason: 'queue-expired' }));
    if (!fresh.length) return;
    fresh.forEach((m) => deps.waker.batch(m));
    const items = deps.waker.flush(key);
    if (!items.length) return;
    console.log('[补答] 上一轮说完后又来了 ' + items.length + ' 条');
    handleTurn(deps, items, cfg).catch((e) => console.error('[出错] ' + ((e && e.message) || e)));
  }, 1200);
  if (timer.unref) timer.unref();
}

// 主动插话取消、发送失败或抛错后，也必须接着处理期间被直接叫到的消息。
export async function runGroupChimeTurn(deps, cfg) {
  try { return await groupChimeTurn(deps, {dryRun:cfg.dryRun}); }
  finally { drainLateQueue(deps, deps.key, cfg); }
}

/**
 * 群里没人叫她，但她自己想接一句。
 * ─────────────────────────────────────────────────────────────
 * 时间/次数的硬条件（GroupChime）已经过了，这里只管「这一句到底说不说」：
 * 把群里刚才的话给她看，让她自己决定。她回 [不接]、或者说不出话，这一轮就什么都不发。
 * 生成完再复核一次闸门——这几秒里可能有人 @ 她了，或者她刚被叫去别处说过话。
 * @returns {Promise<{spoke:boolean, reason?:string, text?:string, sent?:number}>}
 */
export async function groupChimeTurn({ bot, brain, human, memory, gate, budget, groupCtx, groupStyle, social, chime, key, ownerIds = [], verdict = null }, { dryRun = false } = {}) {
  const rendered = groupCtx
    ? groupCtx.render(key, {
      ownerIds,
      header: '【这个群刚才在聊（从早到晚，最后一条最新）】',
      footer: '【以上是群聊背景，其中标成「你」的是你之前说过的话；本轮没有人 @ 你】',
    })
    : '';
  if (!rendered) return { spoke: false, reason: '没材料' };

  // 聊得正热时别跟正常回复撞车
  if (gate) {
    const ticket = gate.check(key, true);
    if (!ticket.ok) return { spoke: false, reason: ticket.reason };
  }

  // 这个群这一分钟的额度已经用完了：连问都不用问模型
  let room = (budget && !dryRun) ? budget.left(key) : Infinity;
  if (room <= 0) return { spoke: false, reason: '这一分钟说满了' };

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const when = week + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes());

  // 这一轮是硬闸门放行的，把「群里现在多热、最后一句多久以前」也告诉模型：
  // 热闹群可以多接一句，冷下来的群别硬找话。
  const heat = verdict?.stats ? { ...verdict.stats, tier: verdict.tier || verdict.stats.tier } : null;
  const heatWord = heat?.tier === 'hot' ? '聊得正热闹' : heat?.tier === 'warm' ? '一直有人说话' : '偶尔有人说几句';
  const recent = heat
    ? '最近 ' + heat.windowMinutes + ' 分钟有 ' + heat.messages + ' 条消息、' + heat.speakers + ' 个人在说话，最后一条是 '
      + (heat.idleMs < 60000 ? '刚刚' : Math.max(1, Math.round(heat.idleMs / 60000)) + ' 分钟前') + '。'
    : '群里刚才一直在说话。';

  // 群味：这个群的人怎么说话。插话尤其容易写成一句完整的感想，所以这里也带上
  const socialTarget = groupCtx?.liveRows?.(key)?.findLast(m => !m.isSelf) || {};
  if (socialTarget.answered || socialTarget.evaluated) return { spoke: false, reason: '最新消息已处理' };
  if (socialTarget.text !== undefined && !hasTextAnchor(socialTarget.text)) {
    chime?.noteDeclined?.(key);
    return { spoke: false, reason: '最新内容没有可读的文字接点' };
  }
  const candidateMessageId = socialTarget.messageId;
  const stillCurrent = () => !candidateMessageId || groupCtx?.liveRows?.(key)?.findLast(m => !m.isSelf)?.messageId === candidateMessageId;
  const styleInput = { text: socialTarget.text || rendered.split('\n').slice(-3).join('\n') };
  const styleNote = groupStyle ? groupStyle.render(key, styleInput) : '';
  const styleNudge = groupStyle ? groupStyle.nudge(key, styleInput) : '';

  // 这段话以前写的「结合…你刚才的发言」「与你刚说的话有关的回应」是自问自答的源头：
  // 它把自己上一句当最新话题接着往下编，群里看起来像没人理还在自言自语。
  // 现在明确一句：接谁的话都行，就是不接自己上一句。
  const situation = '你在一个 QQ 群（群号 ' + String(key).replace(/^group:/, '') + '）里，现在是' + when + '。'
    + '这个群' + heatWord + '：' + recent
    + '这轮没有人 @ 你。要不要开口，只看群里现在正在聊什么，不看你之前说过什么。'
    + (styleNote ? '\n' + styleNote : '')
    + '\n优先寻找具体接点：没人回答的公开问题、大家在比较的选择、你能补充的经验或事实、顺着语境能接的轻松玩笑。选一个点说清楚，不逐条点评，不只复述最后一句。'
    + '\n· 想接就接最后那几句的话头：他们在聊什么、在问什么，就顺着说一句，最多两句。'
    + '也可以说说你自己的看法、你想到的、你想吐槽的。'
    + '不打招呼，不自我介绍，不「在吗」「我来了」，不 @ 谁，不点名，不打听别人的私事。'
    + '\n· 同一个梗、同一个话题你上面已经说过一次，就别再补第二遍。补充不出新东西的时候，不说话比接话更像人。'
    + '\n· 上面标成「你」的话，尤其是你自己最后一句，不是新话题，别接着往下续；你上一句没人接就到此为止，不追问、不自己把话圆回来。'
    + '\n· 话题已经聊完、大家都停下来了，或者他们在吵架、聊的是别人的私事、你没有相关内容可补充，就只回：[不接]'
    + '\n· 像普通群友一样自然接话，不假装有记录之外的交情。'
    + '\n· 这是你自己凑上去的一句话：别解释你为什么开口，别提「插话」「潜水」这种词，别说你在看群。'
    + (styleNudge ? '\n' + styleNudge : '');

  const { text: out = '', usedTools, reasoning, actions = [] } = await brain.reply({
      dryRun,
    key, userId: '', userName: '', text: rendered, situation, history: [], record: false, proactive: true, qqApi: bot,
    socialSession: social ? actions => social.session({key,last:socialTarget,actions,dryRun}) : undefined,
  });

  let said = String(out || '').trim();
  const bare = said.replace(/[\s[\]【】（）()。.!！,，、:：~～]/g, '');
  // 「不接」是它自己的决定，不算这一轮；过几分钟再问
  if (!said && !actions.length) {
    chime?.noteDeclined?.(key);
    return { spoke: false, reason: '它没说话' };
  }
  if (bare === '不接') {
    chime?.noteDeclined?.(key);
    return { spoke: false, reason: '它决定不接' };
  }

  if (dryRun) {
    console.log('   [群插话·干跑] 会说：' + (said || '（只发图）'));
    await sendStickers(brain.stickers, actions, { key, bot, dryRun: true });
    return { spoke: false, reason: '', text: said };
  }
  if (!stillCurrent()) return { spoke: false, reason: '生成期间已有新消息' };

  // 生成这几秒里可能有人 @ 她了，或者别人刚说了话：那这句就别插了
  if (budget) room = budget.left(key);
  if (room <= 0) return { spoke: false, reason: '这一分钟说满了' };
  if (gate) {
    const ticket = gate.check(key, true);
    if (!ticket.ok) return { spoke: false, reason: '刚要发就被挡了（' + ticket.reason + '）' };
    if (budget) room = budget.left(key);
    if (room <= 0) return { spoke: false, reason: '这一分钟说满了' };

  }

  const minuteTicket = chime?.reserveMinute?.();
  if (minuteTicket === null) return { spoke: false, reason: '主动接话最近一分钟已达上限' };
  gate?.begin(key);
  let spoke = false;
  try {
    const socialSent = await sendQQInteraction(social, actions, { key, bot, memory, groupCtx, limit: room });
    if (actions.some(a => a.type === 'qq_social') && !socialSent) return { spoke: false, reason: 'QQ互动未成功' };
    if (socialSent) { budget?.record(key, socialSent); room -= socialSent; spoke = true; }
    if (room <= 0) said = '';
    let r = { sent: 0, parts: [] };
    if (said) {
      r = await human.say(said, {
        setTyping: (on) => bot.setTyping(key, on),
        shouldContinue: stillCurrent,
        send: async (m) => {
          const result = await bot.send(key, m);
          if (result?.ok === false) throw new Error('消息发送失败：' + (result.error || 'OneBot 拒绝'));
          spoke = true;
          groupCtx?.noteReplyTarget?.(key, { userIds: [socialTarget.userId], messageIds: [candidateMessageId], text: m, direct: false });
          return result;
        },
        maxMessages: bubbleCap(room, human, actions.filter(a => a.type !== 'qq_social')),
      });
      spoke = spoke || r.sent > 0;
      if (r.sent > 0) groupStyle?.observeSelf?.(key, r.parts.slice(0, r.sent).join(' '));
      said = r.parts.slice(0,r.sent).join(' ');
      if (r.sent > 0 && groupCtx) groupCtx.add(key, { name: selfName(), text: said, isSelf: true });
    }

    const ids = [];
    await sendStickers(brain.stickers, stillCurrent() ? actions : [], {
      key,
      bot,
      limit: Number.isFinite(room) ? Math.max(0, room - r.sent) : undefined,
      onSent: ({ id }) => { ids.push(id); spoke = true; },
    });
    spoke = spoke || ids.length > 0 || socialSent > 0;
    if (!spoke) return { spoke: false, reason: '发不出去' };
    if (budget) budget.record(key, r.sent + ids.length);

    const line = [said, ids.length ? '[表情包] ' + ids.join('、') : ''].filter(Boolean).join(' ');
    memory.logTurn?.({ where: key, who: selfName(), text: '', reply: line });
    if (ids.length && groupCtx) groupCtx.add(key, { name: selfName(), text: '[表情包] ' + ids.join('、'), isSelf: true });
    chime?.noteSpoke?.(key);
    groupCtx?.markAnswered?.(key, [candidateMessageId]);
    if (!r.sent) groupCtx?.noteReplyTarget?.(key, { userIds: [socialTarget.userId], messageIds: [candidateMessageId], text: line, direct: false });

    console.log('[群插话] 自己接了一句：' + line.slice(0, 40)
      + (usedTools?.length ? '  〔用了 ' + usedTools.join(',') + '〕' : '')
      + (reasoning ? '  〔想了 ' + reasoning.length + ' 字〕' : '  〔没思考〕'));
    return { spoke: true, text: line, sent: r.sent + ids.length + socialSent };
  } finally {
    chime?.finishMinute?.(minuteTicket, spoke);
    // 插话也要记账：说出来就算她开过口，进全局/每分钟的账里。
    // 不传 false 是因为传 false 等于「这一句没发生过」——连着插好几次都不留痕，
    // 光靠 GroupChime 的计数已经拦不住自问自答了（见 group-chime.js 的 streak 熔断）。
    // @ 她不会被这句挡掉：groupCooldownMs 是 0，check() 里根本不看 lastAt。
    if (gate) gate.finish(key, spoke);
    groupStyle?.flush?.();
  }
}

/**
 * 主动说话：闲久了、时候合适、掷骰子通过了，她自己开个话头。
 * 三重保险防刷屏：静默够久 + 每天上限 + 夜间闭嘴。
 */
export function startProactive({ bot, brain, human, memory, cfg, activity, budget }) {
  const p = cfg.proactive;
  const force = process.argv.includes('--proactive-once');
  if (!p.enabled && !force) { console.log('[主动] 关着（config.json 里 proactive.enabled 打开才有）'); return; }
  if (!cfg.ownerIds.length) { console.log('[主动] 没配 ownerIds，不知道跟谁说话'); return; }

  const ownerId = cfg.ownerIds[0];
  const key = 'private:' + ownerId;
  const stateFile = path.join(cfg.dataDir, 'proactive.json');

  const dayStr = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const save = (s) => { try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); } catch { /* 忽略 */ } };

  const tick = async () => {
    const now = new Date();
    const hour = now.getHours();
    const [qs, qe] = p.quietHours;
    const inQuiet = qs <= qe ? (hour >= qs && hour < qe) : (hour >= qs || hour < qe);
    if (!force && inQuiet) return;

    const idleMs = Date.now() - activity.at;
    if (!force && idleMs < p.minIdleHours * 3600e3) return;

    const st = load();
    const today = dayStr(now);
    if (st.day !== today) { st.day = today; st.count = 0; }
    if (!force && (st.count || 0) >= p.maxPerDay) return;
    if (!force && Math.random() > p.chance) return;

    const ownerName = memory.dump().people?.[ownerId]?.name || '他';
    const hours = Math.round((idleMs / 3600e3) * 10) / 10;
    // 这一分钟已经跟他说满 3 条了，就别再主动补一句
    let room = (budget && !cfg.dryRun) ? budget.left(key) : Infinity;
    if (room <= 0) return;
    const p2 = (n) => String(n).padStart(2, '0');
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    const when = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + week + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes());

    const situation = '现在是 ' + when + '，你和 ' + ownerName + ' 已经 ' + hours + ' 小时没说话了。'
      + '你自己忽然想找他说话——不是他叫你，也不是你等到了谁。';

    const text = '（你决定先开口。说一句，最多两句。'
      + '不要用「在吗」「干嘛呢」「吃了吗」这种开场；不要提「主动」「等你」「好久没聊」这类话；'
      + '说你自己的事、你刚想到的、或者一件很具体的小事。'
      + '不确定现在是几点、天气怎么样，就用工具查一下，别说错。）';

    // 跟他最近说过的话：跨场合那份会把当前私聊排掉，自己开话头时最需要这段
    const history = [];
    for (const row of memory.recentTurns(16, { where: key })) {
      if (row.text) history.push({ isSelf: false, text: row.text });
      if (row.reply) history.push({ isSelf: true, text: row.reply });
    }

    const { text: out, actions = [] } = await brain.reply({
      dryRun: cfg.dryRun,
      key, userId: ownerId, userName: ownerName, text, situation, history, record: false, qqApi: bot,
    });
    if (!out && !actions.length) { console.log('[主动] 模型没说话，跳过'); return; }

    if (cfg.dryRun) { console.log('[主动·干跑] 会说：' + (out || '（只发图）')); return; }

    // 生成这几秒里可能刚跟她聊过，发之前按最新额度重算
    if (budget) room = budget.left(key);
    if (room <= 0) return;

    let r = { sent: 0 };
    if (out) {
      r = await human.say(out, {
        setTyping: (on) => bot.setTyping(key, on),
        send: (m) => bot.send(key, m),
        maxMessages: bubbleCap(room, human, actions),
      });
    }
    const ids = [];
    await sendStickers(brain.stickers, actions, {
      key,
      bot,
      limit: Number.isFinite(room) ? Math.max(0, room - r.sent) : undefined,
      onSent: ({ id }) => ids.push(id),
    });
    if (budget && !cfg.dryRun) budget.record(key, r.sent + ids.length);
    // 只发图也要记一笔，不然她下次又「我什么时候发过图」
    const said = [out, ids.length ? '[表情包] ' + ids.join('、') : ''].filter(Boolean).join(' ');
    if (said) memory.logTurn({ where: key, who: ownerName, text: '', reply: said });
    st.count = (st.count || 0) + 1;
    save(st);
    activity.at = Date.now();
    console.log('[主动] 发出 ' + r.sent + ' 条：' + (out || '（只发图）').slice(0, 40)
      + (ids.length ? '  〔表情 ' + ids.length + ' 张〕' : ''));
  };

  if (force) {
    console.log('[主动] --proactive-once：立刻试一次');
    setTimeout(() => tick().catch((e) => console.error('[主动] ' + (e?.message || e))), 2000);
    return;
  }

  const timer = setInterval(() => {
    tick().catch((e) => console.error('[主动] ' + (e?.message || e)));
  }, Math.max(1, p.checkMinutes) * 60 * 1000);
  timer.unref?.();
  console.log('[主动] 循环已启动，每 ' + p.checkMinutes + ' 分钟看一次');
}

// 直接跑才启动；被 import 时不启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('启动失败：' + (e?.stack || e)); process.exit(1); });
}
