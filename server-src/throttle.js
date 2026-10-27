/**
 * 回话闸门 · 别抢话，也别自问自答
 * ─────────────────────────────────────────────────────────────
 * 有个高频故障：同一条消息被投递两次（两个进程、两条连接、网关重发），
 * 她就会对同一句话回两遍——群里看起来像刷屏，也比任何角色卡都更像机器人。
 *
 * 这里管四件事：
 *   1. 同一个会话（私聊/某个群）刚说完话，先闭嘴一段时间
 *   2. 全局每分钟最多开口几次（防止多个群同时炸）
 *   3. 同一个会话每分钟最多发几条（含表情包，默认 3 条）
 *   4. 正在想/正在发的会话，先别插进来
 *
 * 只做判定，不管怎么发——发是 Humanizer 的事。
 */
export class ReplyGate {
  /**
   * @param {object} opts
   * @param {number} [opts.privateCooldownMs=1500] 私聊同一个会话两次开口的最小间隔
   * @param {number} [opts.groupCooldownMs=20000]  同一个群两次开口的最小间隔
   * @param {number} [opts.globalPerMinute=8]      全局每分钟最多开口几轮
   */
  constructor({ privateCooldownMs = 1500, groupCooldownMs = 20000, globalPerMinute = 8 } = {}) {
    this.privateCooldownMs = Math.max(0, Number(privateCooldownMs) || 0);
    this.groupCooldownMs = Math.max(0, Number(groupCooldownMs) || 0);
    this.globalPerMinute = Number(globalPerMinute) === -1 ? Infinity : Math.max(1, Number(globalPerMinute) || 1);
    /** @type {Map<string, number>} 每个会话上一次开口的时间 */
    this.lastAt = new Map();
    /** @type {number[]} 最近一分钟开口的时间戳 */
    this.sent = [];
    /** @type {Set<string>} 正在想/正在发的会话 */
    this.busy = new Set();
  }

  /**
   * 现在能不能开口
   * @param {string} key        'private:123' / 'group:456'
   * @param {boolean} isGroup
   * @returns {{ok:boolean, reason:string, waitMs:number}}
   */
  check(key, isGroup) {
    if (this.busy.has(key)) return { ok: false, reason: '正在说', waitMs: 0 };

    const now = Date.now();
    const gap = isGroup ? this.groupCooldownMs : this.privateCooldownMs;
    const last = this.lastAt.get(key) || 0;
    if (gap > 0 && now - last < gap) {
      return { ok: false, reason: '刚说完', waitMs: gap - (now - last) };
    }

    this.sent = this.sent.filter((t) => now - t < 60000);
    if (this.sent.length >= this.globalPerMinute) {
      return { ok: false, reason: '一分钟说太多了', waitMs: 60000 - (now - this.sent[0]) };
    }
    return { ok: true, reason: '', waitMs: 0 };
  }

  /** 占住这个会话，别再起第二轮 */
  begin(key) { this.busy.add(key); }

  /**
   * 收工。真的说出口了才记账（模型没开口不算）
   * @param {string} key
   * @param {boolean} spoke
   */
  finish(key, spoke) {
    this.busy.delete(key);
    if (!spoke) return;
    const now = Date.now();
    this.lastAt.set(key, now);
    this.sent.push(now);
    if (this.sent.length > 200) this.sent = this.sent.slice(-200);
  }
}

/**
 * 每个会话的「这一分钟还能说几条」。
 * 和 ReplyGate 分开：闸门管「这一轮要不要开口」，这里管「开口后能发几条」。
 * 一条语音、一条文字、一张表情包都算一条；只发图也占额度。
 *
 * 用滚动窗口而不是自然分钟：22:00:59 连发 3 条，22:01:01 不会再白捡 3 条。
 */
export class SpeechBudget {
  /**
   * @param {object} opts
   * @param {number} [opts.perMinute=3] 同一个会话每分钟最多发几条
   * @param {number} [opts.windowMs=60000] 窗口长度
   */
  constructor({ perMinute = 3, windowMs = 60000 } = {}) {
    this.perMinute = Math.max(1, Number(perMinute) || 1);
    this.windowMs = Math.max(1000, Number(windowMs) || 60000);
    /** @type {Map<string, number[]>} 会话 key → 最近发出去的时间戳 */
    this.sent = new Map();
  }

  /** 把窗口外的旧记录清掉，返回窗口内的 */
  #live(key, now = Date.now()) {
    const k = String(key || '');
    const arr = (this.sent.get(k) || []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.sent.set(k, arr);
    else this.sent.delete(k);
    return arr;
  }

  /** 现在还剩几条额度 */
  left(key) {
    return Math.max(0, this.perMinute - this.#live(key).length);
  }

  /** @returns {{ok:boolean, left:number, reason:string}} */
  check(key) {
    const left = this.left(key);
    if (left <= 0) return { ok: false, left: 0, reason: '这一分钟说满了' };
    return { ok: true, left, reason: '' };
  }

  /** 真的发出去了几条就记几条；发失败/模型没开口不要调 */
  record(key, n = 1) {
    const k = String(key || '');
    const count = Math.max(0, Math.floor(Number(n) || 0));
    if (!count) return;
    const arr = this.#live(k);
    const now = Date.now();
    for (let i = 0; i < count; i++) arr.push(now);
    this.sent.set(k, arr);
  }

  /** 清掉某个会话的额度（测试/调试用） */
  reset(key) { this.sent.delete(String(key || '')); }
}

export default ReplyGate;

/** 按会话串行发送：文字/图片共享随机间隔和准确的滚动分钟额度。 */
export class SendPacer {
  constructor({ perMinute = 8, minMs = 5000, maxMs = 15000, now = Date.now, random = Math.random, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { perMinute, minMs, maxMs, now, random, sleep });
    this.states = new Map();
  }
  send(key, action) {
    let st = this.states.get(key);
    if (!st) { st = { queue: Promise.resolve(), sent: [], nextAt: 0 }; this.states.set(key, st); }
    const run = st.queue.then(async () => {
      for (;;) {
        const now = this.now();
        st.sent = st.sent.filter(t => now - t < 60000);
        const wait = Math.max(0, st.nextAt - now, st.sent.length >= this.perMinute ? st.sent[0] + 60000 - now : 0);
        if (!wait) break;
        await this.sleep(wait);
      }
      const result = await action();
      if (result?.ok !== false) {
        st.sent.push(this.now());
        st.nextAt = this.now() + this.minMs + this.random() * (this.maxMs - this.minMs);
      }
      return result;
    });
    st.queue = run.catch(() => {});
    return run;
  }
}
