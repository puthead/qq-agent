/**
 * 群上下文缓冲 · 让她接得上话，又别把整个群塞进提示词
 * ─────────────────────────────────────────────────────────────
 * 群聊里她大多时候是潜水状态，只在被 @ 时才开口。
 * 但只给她"被 @ 的那一条"，她根本不知道刚才大家在聊什么，接话就会跑题。
 *
 * 所以这里做一本滚动的账：每个群最近若干条消息（含她自己说的），
 * 按「条数 + 字数 + 时长」三重上限裁剪，被叫到时渲染成一小段背景喂给模型。
 *
 * 三条上限是刻意的：群越热闹越容易把上下文撑爆，
 * 撑爆之后模型既变慢又容易抓错重点，不如只留最近的一小段。
 */
export class GroupContext {
  /**
   * @param {object} opts
   * @param {boolean} [opts.enabled=true]
   * @param {number}  [opts.maxMessages=24]   每个群最多留多少条
   * @param {number}  [opts.maxChars=1400]    渲染出来最多多少字（中文按字算）
   * @param {number}  [opts.maxAgeMs=1200000] 超过这么久的不再当上下文（默认 20 分钟）
   * @param {number}  [opts.maxGroups=20]     最多记多少个群
   * @param {number}  [opts.topicGapMs=360000] 两条消息隔这么久，渲染时插空行（换话题了）
   */
  constructor({ enabled = true, maxMessages = 24, maxChars = 1400, maxAgeMs = 20 * 60 * 1000, maxGroups = 20, topicGapMs = 6 * 60 * 1000 } = {}) {
    this.enabled = enabled !== false;
    this.maxMessages = Math.max(4, Number(maxMessages) || 24);
    this.maxChars = Math.max(200, Number(maxChars) || 1400);
    this.maxAgeMs = Math.max(60000, Number(maxAgeMs) || 20 * 60 * 1000);
    this.maxGroups = Math.max(1, Number(maxGroups) || 20);
    this.topicGapMs = Math.max(60000, Number(topicGapMs) || 6 * 60 * 1000);
    /** @type {Map<string, object[]>} key: 'group:123' → [{t, name, text, isSelf, messageId}] */
    this.groups = new Map();
    /** @type {Map<string, Map<string,string>>} 群号 → QQ 号 → 群名片：把 @1290313893 翻成人名 */
    this.alias = new Map();
    // 仅保存实际成功发出的回复对象；候选/未发送的草稿不延长对话。
    this.conversations = new Map();
    this.inFlight = new Map();
  }

  /**
   * 记一条（进来的消息和她自己发出去的都记）
   * @param {object} msg
   * @param {string} [msg.replyTo] 这条在回哪一条（messageId），渲染成「（回 某某）」
   * @param {string[]} [msg.atIds] 这条 @ 了谁（QQ 号），渲染成 @名字 / @你
   * @param {string} [msg.selfId] 她自己的号：用来把 @自己 认成「@你」
   */
  add(key, { messageId = '', name = '', text = '', userId = '', isSelf = false, images = [], forwards = [], replyTo = '', atIds = [], selfId = '', time } = {}) {
    if (!this.enabled || !key) return;
    const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!body) return;

    // 说过话的人就有名字了：下一条 @ 他时能翻出来
    if (userId && name && !isSelf) {
      const m = this.alias.get(key) || new Map();
      m.set(String(userId), String(name).slice(0, 20));
      this.alias.set(key, m);
    }

    const arr = this.groups.get(key) || [];
    // 同一条消息重复投递时别记两遍
    if (messageId && arr.some((m) => m.messageId === messageId && !isSelf)) return;

    arr.push({
      t: Math.min(Date.now(), Number(time) || Date.now()), name: String(name || '').slice(0, 20), userId: String(userId || ''), text: body,
      isSelf: !!isSelf, messageId, images: Array.isArray(images) ? images.slice(0, 4) : [],
      forwards: Array.isArray(forwards) ? forwards.slice(0, 3) : [],
      replyTo: String(replyTo || ''),
      atIds: Array.isArray(atIds) && atIds.length ? atIds.map(String).slice(0, 6) : undefined,
      selfId: String(selfId || ''),
    });

    // 三重裁剪：先按条数，再按时长，最后按总字数
    while (arr.length > this.maxMessages) arr.shift();
    const cutoff = Date.now() - this.maxAgeMs;
    while (arr.length && arr[0].t < cutoff) arr.shift();
    const size = () => arr.reduce((n, m) => n + m.name.length + m.text.length + 8, 0);
    // 保留比单次提示词更长的窗口，给引用查前因；渲染仍严格按 maxChars。
    while (arr.length > 1 && size() > this.maxChars * 3) arr.shift();

    this.groups.delete(key);      // 重新插入，保证 Map 的顺序 ≈ 活跃度
    this.groups.set(key, arr);
    while (this.groups.size > this.maxGroups) {
      const oldest = this.groups.keys().next().value;
      this.groups.delete(oldest);
      this.alias.delete(oldest);
      this.conversations.delete(oldest);
    }
  }

  /** 有多少条可用（调试/日志用） */
  count(key) {
    return this.liveRows(key).length;
  }

  markAnswered(key, ids) {
    const sent = new Set(ids.filter(Boolean).map(String));
    for (const row of this.liveRows(key)) if (sent.has(String(row.messageId))) row.answered = true;
  }

  /** 只取当前群近期收到的图片，沿用消息窗口的过期与容量限制。 */
  recentImages(key, { excludeIds = [], limit = 4 } = {}) {
    const skip = new Set(excludeIds.filter(Boolean).map(String));
    return this.liveRows(key).filter(m => !m.isSelf && !skip.has(String(m.messageId)))
      .slice().reverse().flatMap(m => (m.images || []).map(seg => ({ seg, name: m.name })))
      .slice(0, limit);
  }

  liveRows(key) {
    const rows = (this.groups.get(key) || []).filter((m) => m.t >= Date.now() - this.maxAgeMs);
    if (rows.length) this.groups.set(key, rows);
    else this.groups.delete(key);
    return rows;
  }

  recentForwards(key) {
    return this.liveRows(key).filter(m => !m.isSelf && Date.now() - m.t < 5 * 60000 && m.forwards?.length)
      .slice(-1).flatMap(m => m.forwards).slice(0, 3);
  }

  noteReplyTarget(key, { userIds = [], messageIds = [], text = '', direct = true, at = Date.now() } = {}) {
    const ids = [...new Set(userIds.filter(Boolean).map(String))].slice(-4);
    if (!this.enabled || !ids.length) return;
    this.conversations.delete(key);
    this.conversations.set(key, { at, userIds: ids, messageIds: messageIds.filter(Boolean).map(String).slice(-6), text: String(text).slice(0, 1200), direct });
    while (this.conversations.size > this.maxGroups) this.conversations.delete(this.conversations.keys().next().value);
  }

  markEvaluated(key, ids) {
    const selected = new Set(ids.filter(Boolean).map(String));
    for (const row of this.liveRows(key)) if (selected.has(String(row.messageId))) row.evaluated = true;
  }

  endConversation(key, candidate) {
    if (candidate?.sameSpeaker && this.conversations.get(key)?.at === candidate?.at) this.conversations.delete(key);
  }

  beginTurn(key, items) {
    const at = Date.now();
    this.inFlight.set(key, { at, userIds: [...new Set(items.map(m => String(m.userId || '')).filter(Boolean))],
      messageIds: items.map(m => String(m.messageId || '')).filter(Boolean), text: '',
      pendingQuestion: items.map(m => m.text || '').join('\n').slice(0, 1200), direct: !items.every(m => m.continuation), inFlight: true });
  }

  finishTurn(key) {
    this.inFlight.delete(key);
  }

  /** 寻址只是候选；是否承接上文由现有场景模型判断，不靠句首。 */
  continuationCandidate(key, message = this.liveRows(key).at(-1)) {
    const pending = this.inFlight.get(key);
    const focus = pending?.userIds.includes(String(message?.userId)) ? pending : this.conversations.get(key);
    const age = focus ? Date.now() - focus.at : Infinity;
    if (age > 120000) { this.conversations.delete(key); return null; }
    if (!message || message.isSelf || !message.userId || message.isBot) return null;
    const rows = this.liveRows(key);
    const current = rows.find(r => r.messageId && String(r.messageId) === String(message.messageId));
    if (current?.answered || current?.evaluated) return null;
    // 明确指向第三人的消息，不被同人续聊规则夺走。
    if (message.atIds?.length && !message.isAtMe) return null;
    if ((message.replyTo || message.quoted) && !(message.isQuoteMe || message.quoted?.isSelf)) return null;
    if (!String(message.text || '').trim() && !message.images?.length) return null;
    const receivedAt = Number(message.time || message.t) || Date.now();
    // OneBot的入站时间只有秒精度，不能把同秒后到的消息误认成旧消息。
    if (receivedAt < focus.at - 999) return null;
    const intervening = rows.filter(r => !r.isSelf && r.t >= focus.at - 999 && r.t <= receivedAt && String(r.messageId) !== String(message.messageId));
    if (intervening.length > 8) return null;
    const sameSpeaker = focus.userIds.includes(String(message.userId));
    if (!sameSpeaker && (age > 30000 || intervening.length > 2)) return null;
    return { ...focus, sameSpeaker, strong: !!focus.direct && sameSpeaker && intervening.every(r => focus.userIds.includes(r.userId)),
      candidateMessageId: String(message.messageId || ''), senderId: String(message.userId), intervening: intervening.length };
  }

  followupCandidate(key) {
    return !!this.continuationCandidate(key);
  }

  /**
   * 被引用那条消息之前，群里在说什么。
   * 引用只带原话时她不知道前因，容易接歪；这里把前两句捞出来。
   * @param {string} key
   * @param {string|number} messageId 被引用的消息 id
   * @param {object} [opts]
   * @param {number} [opts.before=2] 往前取几条
   * @param {string[]} [opts.ownerIds] 主人 QQ 号，用来标「（你主人）」
   * @returns {Array<{name:string, text:string, isSelf:boolean, isOwner:boolean}>}
   */
  contextBefore(key, messageId, { before = 2, ownerIds = [] } = {}) {
    if (!this.enabled || !messageId) return [];
    const arr = this.liveRows(key);
    const id = String(messageId);
    const at = arr.findIndex((m) => m.messageId && String(m.messageId) === id);
    if (at <= 0) return [];
    const owners = new Set((ownerIds || []).map(String));
    return arr.slice(Math.max(0, at - Math.max(1, Number(before) || 2)), at).map((m) => ({
      name: m.isSelf ? '你' : (m.name || '某人'),
      text: m.text,
      isSelf: !!m.isSelf,
      isOwner: !m.isSelf && !!m.userId && owners.has(String(m.userId)),
    }));
  }

  /**
   * 渲染成给模型看的背景
   * @param {string} key
   * @param {object} [opts]
   * @param {string[]} [opts.excludeIds] 这一轮单独当"新消息"喂的，不要在背景里重复
   * @param {string[]} [opts.ownerIds] 主人（QQ 号）：他发的那几行会标出来，不然群里一改名她就认不出
   * @param {string} [opts.header] 开头那句（自己插话时要换个说法，见 index.js 的 groupChimeTurn）
   * @param {string} [opts.footer] 结尾那句（同上）
   * @returns {string} 空字符串表示没什么可给的
   */
  render(key, {
    excludeIds = [],
    ownerIds = [],
    header = '【这个群刚才聊过的话（从早到晚，最后一条离现在最近；更早的省略了）】',
    footer = '【以上用于理解本轮话题和接话关系。后补的 @ 可能是在叫你看同一人刚才的话；不要替其他人回答。】',
  } = {}) {
    if (!this.enabled) return '';
    const skip = new Set((excludeIds || []).filter(Boolean).map(String));
    const owners = new Set((ownerIds || []).map(String));
    const rows = this.liveRows(key).filter((m) => !(m.messageId && skip.has(String(m.messageId))));
    if (!rows.length) return '';

    const hhmm = (t) => {
      const d = new Date(t);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };

    // 从最新往回取，凑够字数就停
    const alias = this.alias.get(key) || new Map();
    /** 人看群消息，看的是「谁在跟谁说话」，不是一串号 */
    const edgeOf = (m) => {
      // @ 了谁：自己的号写成 @你，别人的翻成名片，翻不出来就写「某人」，不甩一串数字
      let tail = '';
      if (m.atIds && m.atIds.length) {
        tail = '（@' + m.atIds.map((id) => (id === m.selfId ? '你' : (alias.get(id) || '某人'))).slice(0, 2).join('、@') + '）';
      }
      if (m.replyTo) {
        const target = rows.find((r) => r.messageId && String(r.messageId) === String(m.replyTo));
        if (target) tail += '（回 ' + (target.isSelf ? '你' : (target.name || '某人')) + '）';
      }
      return tail;
    };

    let budget = this.maxChars;
    const picked = [];
    let hasEdge = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i];
      const who = m.isSelf ? '你' : ((m.name || '某人') + (m.userId && owners.has(String(m.userId)) ? '（你主人）' : ''));
      const edge = edgeOf(m);
      // @ 号本身留一串数字没意义，正文里已经用（@某某）标出来了
      const plain = m.atIds && m.atIds.length ? m.text.replace(/@\d{5,}/g, '') : m.text;
      let line = '  ' + hhmm(m.t) + '  ' + who + edge + '：' + plain
        + ' ' + JSON.stringify({ sender: m.userId || '', message: String(m.messageId || ''), replyTo: m.replyTo || '' });
      if (line.length > budget && picked.length) break;
      if (line.length > budget) line = line.slice(0, Math.max(0, budget - 1)) + '…';
      if (edge) hasEdge = true;
      picked.unshift({ line, t: m.t });
      budget -= line.length;
    }
    if (!picked.length) return '';

    // 空行 = 隔了一段时间，话题断了；人看聊天记录也是这么分段的
    const body = [];
    for (let i = 0; i < picked.length; i++) {
      if (i && picked[i].t - picked[i - 1].t > this.topicGapMs) body.push('');
      body.push(picked[i].line);
    }
    const legend = hasEdge ? '（「（回 某某）」是他接谁的话，「（@你）」是冲你说的。）' : '';

    return [header, body.join('\n'), legend, footer].filter(Boolean).join('\n');
  }
}

export default GroupContext;
