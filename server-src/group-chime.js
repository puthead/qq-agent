/**
 * 群聊接话 · 没人叫她的时候，按群里的上下文接一句
 * ─────────────────────────────────────────────────────────────
 * 群里的默认策略是只认 @：不喊就不说话，免得一个机器人把群聊刷成自己的复读机。
 * 但一个真人在热闹的群里，总会顺嘴接一句——这里就是那条「顺嘴」的路。
 *
 * 这件事分两半：
 *   ① 现在允许不允许开口 —— 这个文件说了算。全过了才去叫模型，所以很便宜。
 *   ② 这一句到底说不说 —— 模型自己决定（见 index.js 的 groupChimeTurn），
 *      说 [不接] 就不发，硬条件过了也不等于一定要说。
 *
 * 硬条件（就是「时间限制」和「次数限制」）：
 *   · 夜里闭嘴（quietHours）
 *   · 群里最近 idleMinutes 分钟内必须还有人说话：安静久了就当话题结束，一句都不接
 *   · 群里最近 windowMinutes 要有 minMessages 条、minSpeakers 个人在说话
 *     （一个人在刷屏不算热闹，这是「有人说话的群聊」的本意）
 *   · 同一个群两次接话至少隔 minGapMinutes（时间限制）
 *   · 同一个群每天最多 maxPerGroupPerDay 次、所有群合计每天最多 maxPerDay 次（次数限制）
 *   · 刚问过它接不接、它说「不接」→ 隔 declineGapMinutes 再问
 *   · 按群活跃度分 calm / warm / hot 三档：越热闹概率越高、间隔越短、每日上限越高
 *   · 最后再掷一次骰子，chance 决定要不要真开这个口
 *
 * 活跃度只数「别人说的」：她自己插的话不算热闹，不然会自己把自己越推越热。
 * 状态落盘在 dataDir/group-chime.json，跨天自动归零。
 * 时钟和随机数都能注入，测试里就不用真的等十几分钟。
 */
import fs from 'node:fs';
import path from 'node:path';

const dayStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const minutes = (ms) => Math.round(ms / 60000);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 白/黑名单里写 207483783 或 group:207483783 都认 */
const normKey = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.startsWith('group:') ? s : 'group:' + s;
};

/**
 * 活跃度分档。倍数再夹到合理区间：
 *   chance 是「掷骰子通过」的倍数（还会夹到 0~1）
 *   gap    是两次接话间隔的倍数（乘在 minGapMinutes 上）
 * 热闹群的额外每日次数由 hotExtraPerDay 单独给，不塞进这张表。
 */
const TIERS = {
  calm: { chance: 0.7, gap: 1.4 },
  warm: { chance: 1, gap: 1 },
  hot: { chance: 1.8, gap: 0.5 },
};

export class GroupChime {
  /**
   * @param {object} opts
   * @param {boolean} [opts.enabled=true]        总开关
   * @param {number[]} [opts.quietHours=[0,8]]   这个区间里不说话（跨零点也行，比如 [23,7]）
   * @param {number}  [opts.windowMinutes=10]    用最近多久的消息判断「热不热闹」
   * @param {number}  [opts.minMessages=6]       窗口里至少几条
   * @param {number}  [opts.minSpeakers=2]       窗口里至少几个人（一个人刷屏不算）
   * @param {number}  [opts.idleMinutes=6]       群里这么久没人说话就不接（死群不回复）
   * @param {number}  [opts.warmRate=0.7]        窗口里每分钟多少条算「一般热闹」
   * @param {number}  [opts.hotRate=1.5]         窗口里每分钟多少条算「很热闹」
   * @param {number}  [opts.minGapMinutes=15]    同一个群两次接话至少隔多久
   * @param {number}  [opts.maxPerGroupPerDay=8] 同一个群每天最多几次
   * @param {number}  [opts.hotExtraPerDay=3]    热闹群每天额外多几次
   * @param {number}  [opts.maxPerDay=16]        所有群合计每天最多几次
   * @param {number}  [opts.chance=0.25]         硬条件全过之后真开口的基础概率
   * @param {number}  [opts.declineGapMinutes=5] 说了[不接]之后隔多久再问
   * @param {string[]} [opts.allowGroups=[]]     只在这些群接话（空 = 都行）
   * @param {string[]} [opts.blockGroups=[]]     这些群永不接话
   * @param {string}  [opts.dataDir='']          状态存哪（不给就不落盘，纯内存）
   * @param {() => number} [opts.now]            时钟（测试注入）
   * @param {() => number} [opts.random]         随机数（测试注入）
   */
  constructor({
    enabled = true,
    quietHours = [0, 8],
    windowMinutes = 10,
    minMessages = 6,
    minSpeakers = 2,
    idleMinutes = 6,
    warmRate = 0.7,
    hotRate = 1.5,
    minGapMinutes = 15,
    maxPerGroupPerDay = 8,
    hotExtraPerDay = 3,
    maxPerDay = 16,
    maxPerMinute = -1,
    maxStreak = 2,
    chance = 0.25,
    declineGapMinutes = 5,
    allowGroups = [],
    blockGroups = [],
    dataDir = '',
    now,
    random,
  } = {}) {
    this.enabled = enabled !== false;
    this.quietHours = (Array.isArray(quietHours) && quietHours.length === 2)
      ? quietHours.map((h) => Math.min(24, Math.max(0, Number(h) || 0)))
      : [0, 8];
    this.windowMs = Math.max(1, num(windowMinutes, 10)) * 60000;
    this.minMessages = Math.max(1, num(minMessages, 6));
    this.minSpeakers = Math.max(1, num(minSpeakers, 2));
    this.idleMs = Math.max(0, num(idleMinutes, 6)) * 60000;
    this.warmRate = Math.max(0, num(warmRate, 0.7));
    this.hotRate = Math.max(this.warmRate, num(hotRate, 1.5));
    this.minGapMs = Math.max(0, num(minGapMinutes, 15)) * 60000;
    this.maxPerGroupPerDay = Math.max(-1, num(maxPerGroupPerDay, 8));
    this.hotExtraPerDay = Math.max(0, num(hotExtraPerDay, 3));
    this.maxPerDay = Math.max(-1, num(maxPerDay, 16));
    this.maxPerMinute = Math.max(-1, num(maxPerMinute, -1));
    this.minuteSpokes = [];
    this.minutePending = new Set();
    // 连续插话、中间没有任何人接她的次数上限。到了就闭嘴，等有人 @ 她再开口。
    // 这是「自问自答连续剧」的保险丝：靠的是计数，不是模型的自觉。
    this.maxStreak = Math.max(1, num(maxStreak, 2));
    this.chance = Math.min(1, Math.max(0, num(chance, 0.25)));
    this.declineGapMs = Math.max(0, num(declineGapMinutes, 5)) * 60000;

    this.allowGroups = new Set((allowGroups || []).map(normKey).filter(Boolean));
    this.blockGroups = new Set((blockGroups || []).map(normKey).filter(Boolean));

    this.now = typeof now === 'function' ? now : () => Date.now();
    this.random = typeof random === 'function' ? random : Math.random;

    this.stateFile = dataDir ? path.join(dataDir, 'group-chime.json') : '';
    /** @type {Map<string, {t:number, uid:string}[]>} 各群最近的活动，只用来算「热不热闹」 */
    this.hits = new Map();
    /** @type {Map<string, number>} 各群最后一条消息的时间：判断「还有没有人说话」 */
    this.lastAt = new Map();
    /** @type {Map<string, {count:number, lastSpokeAt:number, askedAt:number}>} 计数，要落盘 */
    this.counters = new Map();
    this.day = dayStr(new Date(this.now()));
    this.total = 0;
    this.#load();
  }

  /** 这个群允许接话吗（开关 + 白/黑名单；白名单非空就只认白名单） */
  allowed(key) {
    if (!this.enabled || !key) return false;
    const k = normKey(key);
    if (this.blockGroups.has(k)) return false;
    if (this.allowGroups.size && !this.allowGroups.has(k)) return false;
    return true;
  }

  /**
   * 记一条群消息。只记「别人说的」——她自己说的不算热闹，
   * 不然她接一句、自己把自己算成有人说话，就会一路接下去。
   */
  observe(key, { userId = '', at = 0 } = {}) {
    if (!this.allowed(key)) return;
    const t = Number(at) || this.now();
    const arr = this.hits.get(key) || [];
    arr.push({ t, uid: String(userId || '') });
    // 只留够算窗口的量，群再热闹也不吃内存
    const keepFrom = this.now() - this.windowMs * 2;
    let drop = 0;
    while (drop < arr.length && (arr[drop].t < keepFrom || arr.length - drop > 300)) drop++;
    if (drop) arr.splice(0, drop);
    this.hits.set(key, arr);
    // 这条不裁剪：哪怕窗口里已经没消息了，也要知道最后一句是多久以前
    this.lastAt.set(key, t);
  }

  /**
   * 窗口里有多少条、几个人在说话、最后一条多久以前、每分钟几条。
   * @returns {{messages:number, speakers:number, lastAt:number, idleMs:number, rate:number, windowMinutes:number}}
   */
  stats(key) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) || []).filter((h) => h.t >= cutoff);
    const lastAt = this.lastAt.get(key) || 0;
    return {
      messages: arr.length,
      speakers: new Set(arr.map((h) => h.uid).filter(Boolean)).size,
      lastAt,
      idleMs: lastAt ? now - lastAt : Infinity,
      rate: arr.length / (this.windowMs / 60000),
      windowMinutes: Math.round(this.windowMs / 60000),
    };
  }

  /**
   * 这个群现在算哪一档：calm / warm / hot。
   * @returns {{messages:number, speakers:number, lastAt:number, idleMs:number, rate:number, windowMinutes:number, tier:string}}
   */
  activity(key) {
    const s = this.stats(key);
    const tier = s.rate >= this.hotRate ? 'hot' : s.rate >= this.warmRate ? 'warm' : 'calm';
    return { ...s, tier };
  }

  /**
   * 现在能不能开口。
   * code 是给日志去重用的稳定标签（reason 里带数字，每次都不一样）
   * @param {string} key
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] 跳过夜间/间隔/掷骰子（调试用），每日上限和「没人说话」仍然守
   * @returns {{ok:boolean, reason:string, code?:string, tier?:string, stats?:object, limits?:object}}
   */
  shouldChime(key, { force = false, followup = false } = {}) {
    if (!this.allowed(key)) return { ok: false, code: 'off', reason: '这个群没开' };
    const now = this.now();
    this.#rollover(now);
    const st = this.#counter(key);

    if (!this.minuteAvailable()) return { ok: false, code: 'cap-minute', reason: '主动接话最近一分钟已达上限' };

    if (!force) {
      if (this.#inQuiet(now)) return { ok: false, code: 'night', reason: '夜里不说' };
      // 刚问过它、它说不接：别隔一分钟就去烦一次模型。
      // 只认「最后一次是它拒绝了」；说完话之后由下面的间隔管，不走这条。
      if (st.askedAt > st.lastSpokeAt && now - st.askedAt < this.declineGapMs) {
        return { ok: false, code: 'decline', reason: '刚问过它，它说再想想' };
      }
    }

    const info = this.activity(key);
    const lim = this.#limits(info.tier);
    // 续聊窗口不突破夜间、每日额度和拒绝冷却；不限制连续接话次数。
    const continuing = followup && st.lastSpokeAt > 0
      && now - st.lastSpokeAt <= 120000 && info.lastAt > st.lastSpokeAt
      ;
    if (continuing) { lim.gapMs = 8000; lim.chance = 1; }

    // 次数限制先看：今天/这个群说够了，就不管群里热不热闹
    if (lim.cap >= 0 && st.count >= lim.cap) return { ok: false, code: 'cap-group', reason: '这个群今天说够了' };
    if (this.maxPerDay >= 0 && this.total >= this.maxPerDay) return { ok: false, code: 'cap-all', reason: '今天全体说够了' };

    // 连着凑了好几轮，中间没有一个人接她：这不是接话，是自己跟自己聊。
    // 有人真在接她（continuing）就照常，不然先收着，等有人 @ 她再来。
    // 两条豁免：force（人手动让它说）和「上一句已经过去十分钟了」（旧账不该压着新话题）。
    const sinceSpoke = now - (st.lastSpokeAt || 0);
    if (!force && !continuing && st.streak >= this.maxStreak && sinceSpoke < 10 * 60000) {
      return { ok: false, code: 'monologue', reason: '已经连着自己接了 ' + st.streak + ' 轮，没人搭腔' };
    }

    // 没人在说话：一句都不接。她只接「正在进行」的话题，不往死群里扔话。
    if (!info.lastAt) return { ok: false, code: 'silent', reason: '群里一直没人说话' };
    if (info.idleMs > this.idleMs) {
      return {
        ok: false,
        code: 'stale',
        reason: '群里已经 ' + Math.max(1, minutes(info.idleMs)) + ' 分钟没人说话了',
      };
    }
    if (!continuing && info.messages < this.minMessages) return { ok: false, code: 'cold', reason: '才 ' + info.messages + ' 条，不够热闹' };
    if (!continuing && info.speakers < this.minSpeakers) return { ok: false, code: 'lonely', reason: '只有 ' + info.speakers + ' 个人在说' };

    if (!force && st.lastSpokeAt && now - st.lastSpokeAt < lim.gapMs) {
      const ago = minutes(now - st.lastSpokeAt);
      return { ok: false, code: 'gap', reason: '这个群刚说过（' + (ago < 1 ? '刚刚' : ago + ' 分钟前') + '）' };
    }

    if (!force && this.random() >= lim.chance) return { ok: false, code: 'dice', reason: '掷骰子没过' };
    return { ok: true, reason: '', tier: info.tier, stats: info, limits: lim, followup: continuing };
  }

  /** 真说了：计次、记时间 */
  minuteAvailable() {
    this.minuteSpokes = this.minuteSpokes.filter(t => t > this.now() - 60000);
    return this.maxPerMinute < 0 || this.minuteSpokes.length + this.minutePending.size < this.maxPerMinute;
  }

  // 发送前同步占位，防止不同群同时生成完成后突破总频率。
  reserveMinute() {
    if (!this.minuteAvailable()) return null;
    const token = Symbol('chime');
    this.minutePending.add(token);
    return token;
  }

  finishMinute(token, spoke) {
    if (!this.minutePending.delete(token)) return;
    if (spoke) this.minuteSpokes.push(this.now());
    this.#save();
  }

  noteSpoke(key, { at = 0, followup = false } = {}) {
    const now = Number(at) || this.now();
    this.#rollover(now);
    const st = this.#counter(key);
    st.lastSpokeAt = now;
    st.askedAt = now;
    st.count += 1;
    st.followups = followup ? (st.followups || 0) + 1 : 0;
    // 有人接她（followup）算这轮说清了，计数归零；没人接就累加，攒到 maxStreak 熔断。
    st.streak = followup ? 0 : (st.streak || 0) + 1;
    this.total += 1;
    this.#save();
  }

  /** 问过它了，它说「不接」：只记「问过」，不计次 */
  noteDeclined(key, { at = 0 } = {}) {
    const now = Number(at) || this.now();
    this.#rollover(now);
    this.#counter(key).askedAt = now;
    this.#save();
  }

  /** 她在群里正常回了一句（有人 @ 她）：把间隔重置掉，免得转头又自己接一句。不计次 */
  noteReply(key, { at = 0 } = {}) {
    const now = Number(at) || this.now();
    this.#rollover(now);
    this.#counter(key).lastSpokeAt = now;
    this.#counter(key).followups = 0;
    // 有人点名找她，说明这轮对话是真的，连续插话的保险丝跟着复位
    this.#counter(key).streak = 0;
    this.#save();
  }

  /** 给启动日志看的一句话 */
  describe() {
    if (!this.enabled) return '关';
    return '开（安静 ' + minutes(this.idleMs) + ' 分钟以上不接、同一群至少隔 ' + minutes(this.minGapMs)
      + ' 分钟、连着说 ' + this.maxStreak + ' 轮没人接就收着、每群每天 ' + this.maxPerGroupPerDay + ' 次（热闹群 +' + this.hotExtraPerDay
      + '）、全部每天 ' + this.maxPerDay + ' 次、' + this.quietHours[0] + '–' + this.quietHours[1]
      + ' 点不说、按活跃度自动调概率）';
  }

  // ── 内部 ────────────────────────────────────────────────────

  #counter(key) {
    let st = this.counters.get(key);
    if (!st) { st = { count: 0, lastSpokeAt: 0, askedAt: 0, streak: 0 }; this.counters.set(key, st); }
    return st;
  }

  /** 这一档实际用的概率、间隔、每群每日上限 */
  #limits(tier) {
    const t = TIERS[tier] || TIERS.warm;
    return {
      chance: Math.min(1, Math.max(0, this.chance * t.chance)),
      gapMs: Math.max(0, this.minGapMs * t.gap),
      cap: this.maxPerGroupPerDay > 0
        ? this.maxPerGroupPerDay + (tier === 'hot' ? this.hotExtraPerDay : 0)
        : this.maxPerGroupPerDay,
    };
  }

  /** 过了零点就把今天的次数清零 */
  #rollover(now) {
    const today = dayStr(new Date(now));
    if (today === this.day) return;
    this.day = today;
    this.total = 0;
    for (const st of this.counters.values()) { st.count = 0; st.streak = 0; }
  }

  #inQuiet(now) {
    const hour = new Date(now).getHours();
    const [qs, qe] = this.quietHours;
    return qs <= qe ? (hour >= qs && hour < qe) : (hour >= qs || hour < qe);
  }

  #load() {
    if (!this.stateFile) return;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return; }
    if (!raw || typeof raw !== 'object') return;
    this.day = String(raw.day || this.day);
    this.total = Math.max(0, Number(raw.total) || 0);
    this.minuteSpokes = (Array.isArray(raw.minuteSpokes) ? raw.minuteSpokes : [])
      .filter(t => Number.isFinite(t) && t > this.now() - 60000);
    for (const [k, v] of Object.entries(raw.groups || {})) {
      if (!v || typeof v !== 'object') continue;
      this.counters.set(k, {
        count: Math.max(0, Number(v.count) || 0),
        lastSpokeAt: Math.max(0, Number(v.lastSpokeAt) || 0),
        askedAt: Math.max(0, Number(v.askedAt) || 0),
        followups: Math.max(0, Number(v.followups) || 0),
        streak: Math.max(0, Number(v.streak) || 0),
      });
    }
  }

  #save() {
    if (!this.stateFile) return;
    const groups = {};
    for (const [k, st] of this.counters) {
      if (!st.count && !st.lastSpokeAt && !st.askedAt) continue;
      groups[k] = { count: st.count, lastSpokeAt: st.lastSpokeAt, askedAt: st.askedAt, followups: st.followups || 0, streak: st.streak || 0 };
    }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ day: this.day, total: this.total, minuteSpokes: this.minuteSpokes, groups }, null, 2));
    } catch { /* 落盘失败下次重新数，不影响说话 */ }
  }
}

export default GroupChime;
