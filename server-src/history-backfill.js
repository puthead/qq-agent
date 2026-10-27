/**
 * 断线/重启补历史 · 把不在线那段时间漏掉的话捡回来
 * ─────────────────────────────────────────────────────────────
 * 服务不在线时 QQ 不会补投消息：重启后她只知道自己"睡了一觉"，
 * 错过的追问、@、图片全都不知道，续聊对象也接不上。
 *
 * 这里在连上 NapCat 后（每次重连都会再试，内部限流）对最近活跃的会话
 * 拉一次近期消息，把归档里没有的那些补进去：
 *   - 归档进 conversations/*.jsonl（source=napcat-backfill），照常可检索；
 *   - 进群上下文（在时间窗内的），她看得到"刚才聊了什么"；
 *   - 不触发回复：迟到太久的 @ 补答反而奇怪，只做背景。
 *
 * 边界：只补最近一段时间（默认 6 小时）、每个会话最多 count 条、
 * 跳过自己发的回声和机器人号段；非好友的私聊拉不到就算了。
 */
import { segsToText } from './transport-onebot.js';

const secs = (t) => (Number(t) > 0 ? Number(t) * 1000 : 0);

function partsOf(ev) {
  const segs = Array.isArray(ev?.message) ? ev.message : [];
  const replySeg = segs.find((s) => s?.type === 'reply');
  return {
    segs,
    text: segsToText(segs),
    images: segs.filter((s) => s?.type === 'image' && s?.data),
    forwards: segs.filter((s) => s?.type === 'json' || s?.type === 'xml'),
    replyTo: replySeg ? String(replySeg.data?.id || '') : '',
    atIds: segs.filter((s) => s?.type === 'at' && s?.data?.qq).map((s) => String(s.data.qq)),
  };
}

export class HistoryBackfill {
  constructor({ bot = null, memory = null, groupCtx = null, robotFilter = null,
    count = 40, maxAgeMs = 6 * 3600e3, minGapMs = 5 * 60000, maxSessions = 12, sessionWindowMs = 72 * 3600e3 } = {}) {
    this.bot = bot;
    this.memory = memory;
    this.groupCtx = groupCtx;
    this.robotFilter = robotFilter;
    this.count = Math.max(5, Math.min(80, Number(count) || 40));
    this.maxAgeMs = Math.max(60000, Number(maxAgeMs) || 6 * 3600e3);
    this.minGapMs = Math.max(30000, Number(minGapMs) || 5 * 60000);
    this.maxSessions = Math.max(1, Number(maxSessions) || 12);
    this.sessionWindowMs = Math.max(3600e3, Number(sessionWindowMs) || 72 * 3600e3);
    this.lastRunAt = 0;
    this.running = null;
  }

  /**
   * 跑一轮补历史。返回 {checked, missed, sessions} 汇总；任何会话失败不影响其他会话。
   */
  async run() {
    if (!this.bot?.api || !this.memory?.files) return { checked: 0, missed: 0, sessions: [] };
    if (Date.now() - this.lastRunAt < this.minGapMs) return { checked: 0, missed: 0, sessions: [], skipped: '限流' };
    if (this.running) return this.running;
    this.running = (async () => {
      const summary = { checked: 0, missed: 0, sessions: [] };
      try {
        const keys = this.activeKeys();
        for (const key of keys) {
          try {
            const r = await this.backfillKey(key);
            summary.sessions.push({ key, ...r });
            summary.checked += r.checked;
            summary.missed += r.missed;
          } catch (e) {
            summary.sessions.push({ key, error: String(e?.message || e) });
          }
        }
        if (summary.missed) console.log('[补历史] 共补回 ' + summary.missed + ' 条漏收消息（' + keys.length + ' 个会话）');
        else console.log('[补历史] 核对 ' + keys.length + ' 个活跃会话，没有漏收');
      } finally {
        this.lastRunAt = Date.now();
        this.running = null;
      }
      return summary;
    })();
    return this.running;
  }

  /** 最近还有动静的会话，最活跃的排前面 */
  activeKeys() {
    const rows = this.memory.recentTurns(400, { sinceMs: this.sessionWindowMs }) || [];
    const last = new Map();
    for (const r of rows) {
      if (!r?.where) continue;
      const t = Number(r.t) || 0;
      if (t > (last.get(r.where)?.t || 0)) last.set(r.where, { t, who: r.who || '' });
    }
    return [...last.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, this.maxSessions).map(([k]) => k);
  }

  async backfillKey(key) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1] || '';
    if (!id) return { checked: 0, missed: 0 };
    const r = isGroup
      ? await this.bot.api('get_group_msg_history', { group_id: id, count: this.count }, { timeoutMs: 15000 })
      : await this.bot.api('get_friend_msg_history', { user_id: id, count: this.count }, { timeoutMs: 15000 });
    if (!r?.ok) return { checked: 0, missed: 0, error: r?.error || '接口失败' };
    const list = Array.isArray(r.data?.data?.messages) ? r.data.data.messages : [];
    const known = this.memory.knownIds(key);

    const floor = Date.now() - this.maxAgeMs;
    const ceil = Date.now() + 2 * 60000;
    const missed = [];
    const seen = new Set();
    for (const ev of list) {
      const messageId = String(ev?.message_id || '');
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);
      if (known.has('napcat-' + messageId)) continue;
      const t = secs(ev?.time);
      if (!t || t < floor || t > ceil) continue;
      const userId = String(ev?.sender?.user_id || ev?.user_id || '');
      if (!userId || userId === String(this.bot.selfId || '')) continue; // 自己的回声走 onSelfMessage 记账，不在这里补
      if (this.robotFilter?.isRobot(userId)) continue;
      const p = partsOf(ev);
      if (!p.text && !p.images.length) continue;
      missed.push({
        key, isGroup, messageId, t, userId,
        name: String(ev?.sender?.card || ev?.sender?.nickname || userId).slice(0, 20),
        text: p.text, images: p.images, forwards: p.forwards,
        replyTo: p.replyTo, atIds: p.atIds, isAtMe: p.atIds.includes(String(this.bot.selfId || '')),
      });
    }
    missed.sort((a, b) => a.t - b.t);

    if (missed.length) {
      this.memory.backfillTurns(missed.map((m) => ({
        key: m.key, id: 'napcat-' + m.messageId, t: m.t, who: m.name, userId: m.userId, text: m.text,
      })));
      if (isGroup && this.groupCtx) {
        for (const m of missed) {
          this.groupCtx.add(m.key, {
            messageId: m.messageId, name: m.name, userId: m.userId, text: m.text,
            images: m.images, forwards: m.forwards, replyTo: m.replyTo, atIds: m.atIds, time: m.t,
          });
        }
      }
    }
    return { checked: list.length, missed: missed.length };
  }
}

export default HistoryBackfill;
