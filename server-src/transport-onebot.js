/**
 * 传输层 · OneBot v11 适配
 * ─────────────────────────────────────────────────────────────
 * OneBot v11 是一个被广泛实现的机器人协议：
 *   NapCat / Lagrange / LLOneBot / go-cqhttp / SnowLuma 都实现了它。
 *
 * 这一层负责：
 *   - 连上 OneBot 的 WebSocket，收消息
 *   - 把 OneBot 的原始事件翻译成统一格式
 *   - 把图片段变成模型看得懂的 data URL
 *   - 提供「发消息」「发图」「正在输入」等动作
 *
 * 如果你想接别的平台（微信/Telegram/自研），照着这个接口再写一个就行。
 */
import fs from 'node:fs';
import { forwardRefs } from './forward-context.js';
import { selfName } from './identity.js';

/** NapCat 的 summary 是转义过的（&#91;动画表情&#93;），还原成正常字符 */
function dehtml(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 图片段 → [图片] / [图片·动画表情]（summary 是 QQ 自己给的说法，白扔可惜） */
function imageTag(s) {
  const sum = dehtml(s?.data?.summary || '').replace(/^\[|\]$/g, '').trim();
  return sum ? '[图片·' + sum.slice(0, 12) + ']' : '[图片]';
}

/** 卡片字段通用清洗：控制/隐形字符清掉、压成一行、长度收紧 */
function cardField(v, n) {
  return String(v || '').replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

function cardLine(tag, title, desc, url) {
  return '[分享卡' + (tag ? '·' + tag : '') + ']'
    + (title ? ' ' + title : '')
    + (desc ? '：' + desc : '')
    + (url ? '\n链接: ' + url : '');
}

/**
 * json/xml 分享卡片 → 一行可读文字（来源、标题、简介、链接）。
 * 链接只认 http(s)，模型想看内容就交给 web_fetch 打开。
 * 卡片内容是外部资料：只挑事实字段展示，不执行其中任何东西。
 * （合并转发卡片在下面 switch 里已先被 forwardRefs 认走，到不了这里。）
 */
function cardText(s) {
  const onlyHttp = (u) => (/^https?:\/\//i.test(u) ? u : '');
  try {
    if (s?.type === 'json') {
      const j = JSON.parse(s.data?.data || '');
      if (!j || typeof j !== 'object') return '[卡片消息]';
      const metas = Object.values(j.meta || {}).filter((v) => v && typeof v === 'object');
      const cand = metas.find((v) => v.jumpUrl || v.url || v.murl) || metas.find((v) => v.title) || {};
      const tag = cardField(cand.tag || cand.source_name || cand.appname || '', 12);
      const title = cardField(cand.title, 80)
        || cardField(String(j.prompt || '').replace(/^\[(分享|链接|视频|音乐|文章|网页)\]/, ''), 80);
      const desc = cardField(cand.desc, 120);
      const url = onlyHttp(cardField(cand.jumpUrl || cand.url || cand.murl || '', 600));
      if (!title && !desc && !url) return '[卡片消息]';
      return cardLine(tag, title, desc, url);
    }
    if (s?.type === 'xml') {
      const x = String(s.data?.data || s.data?.xml || '');
      if (!x.includes('<')) return '[卡片消息]';
      const grab = (t) => {
        let v = (x.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>')) || [])[1] || '';
        v = v.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/<[^>]+>/g, ' ');
        return cardField(dehtml(v), t === 'url' ? 600 : t === 'title' ? 80 : 120);
      };
      const title = grab('title');
      const desc = grab('summary');
      const url = onlyHttp(grab('url'));
      const tag = grab('appname');
      if (!title && !desc && !url) return '[卡片消息]';
      return cardLine(tag, title, desc, url);
    }
  } catch { /* 认不出的结构落回占位，别拖住整条消息 */ }
  return '[卡片消息]';
}

/**
 * 把 OneBot 消息段数组拼成纯文本
 * 认不出的段也要留个记号：以前 forward/video 之类直接消失，被引用的那种消息就变成
 * 空白，模型只能回「你引的什么我没看见」。宁可给个 [合并转发] 也好过什么都没有。
 */
function segsToText(segs) {
  if (!Array.isArray(segs)) return String(segs || '');
  const out = [];
  for (const s of segs) {
    if (!s) continue;
    switch (s.type) {
      case 'text': out.push(s.data?.text || ''); break;
      case 'at': out.push('@' + (s.data?.qq || '')); break;
      case 'image': out.push(imageTag(s)); break;
      case 'face':
      case 'mface': out.push('[表情]'); break;
      // 这几种她天生读不到内容。标签里直接写明白，别让她以为「有附件但自己没收到」，
      // 更别让她拿「你发的我没看见」去顶人家——她看不见画面，但知道对方发了什么。
      case 'record': out.push('[语音·听不到内容]'); break;
      case 'video': out.push('[视频·看不到画面]'); break;
      case 'file': out.push('[文件·看不到内容]'); break;
      case 'forward': out.push('[合并转发]'); break;
      case 'json':
      case 'xml': out.push(forwardRefs([s]).length ? '[合并转发]' : cardText(s)); break;
      case 'location': out.push('[位置]'); break;
      case 'contact': out.push('[名片]'); break;
      case 'poke': out.push('[戳一戳]'); break;
      case 'reply': break;   // 引用单独处理
      default: break;
    }
  }
  return out.join('').trim();
}

/**
 * 有些实现（或 get_msg）给的是 CQ 字符串而不是段数组，这里拆成段。
 * 只做最朴素的一段段切分，够用就行。
 */
function cqToSegs(raw) {
  const text = String(raw || '');
  const segs = [];
  let last = 0;
  for (const m of text.matchAll(/\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g)) {
    if (m.index > last) segs.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    const data = {};
    for (const kv of m[2].split(',').slice(1)) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = dehtml(kv.slice(i + 1));
    }
    segs.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', data: { text: text.slice(last) } });
  return segs;
}

/** 从消息段里找引用 */
function findReply(segs) {
  if (!Array.isArray(segs)) return null;
  for (const s of segs) if (s?.type === 'reply') return String(s.data?.id || '');
  return null;
}

/** 按文件头猜图片类型 */
function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 6 && b.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/**
 * NapCat 在容器里时，图片路径是容器内的 /app/...，需要映射回宿主机路径。
 * 默认按 /opt/napcat 这一常见挂载布局；用 config.onebot.mounts 覆盖，
 * 例如 [["/app/napcat/", "/srv/napcat/"]]。NapCat 直接跑在宿主机上则不需要映射。
 */
let MOUNTS = [
  ['/app/.config/QQ/', '/opt/napcat/qq/'],
  ['/app/napcat/', '/opt/napcat/'],
  ['/app/', '/opt/napcat/'],
];

/** 覆盖容器路径 → 宿主机路径的映射 */
export function setMounts(list) {
  if (!Array.isArray(list) || !list.length) return;
  const next = list
    .filter((x) => Array.isArray(x) && x.length === 2 && x[0] && x[1])
    .map(([from, to]) => [String(from), String(to)]);
  if (next.length) MOUNTS = next;
}

function hostPath(p) {
  let s = String(p || '').replace(/^file:\/\//, '').replace(/^\/\//, '/');
  for (const [from, to] of MOUNTS) {
    if (s.startsWith(from)) return to + s.slice(from.length);
  }
  return s;
}

export class OneBot {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl       例如 ws://127.0.0.1:3001
   * @param {string} [opts.httpUrl]   例如 http://127.0.0.1:3000（发消息用）
   * @param {string} [opts.accessToken]
   * @param {(msg:object)=>void} [opts.onMessage]
   * @param {(msg:object)=>void} [opts.onSelfMessage] 自己这个号发出去的消息（别的客户端发的也算）
   * @param {()=>void} [opts.onOpen] 每次连上（含重连）后触发：补历史、刷机器人号段在这挂钩
   * @param {number} [opts.reconnectMs=5000] 断线后多久重连
   * @param {Function} [opts.webSocketImpl] 只有测试用：塞一个假的 WebSocket 类进来，绕开真连接
   */
  constructor({ wsUrl, httpUrl, accessToken = '', onMessage, onSelfMessage, onOpen, reconnectMs = 5000, webSocketImpl = null }) {
    this.wsUrl = wsUrl;
    this.httpUrl = (httpUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.webSocketImpl = webSocketImpl;
    this.onMessage = onMessage;
    this.onSelfMessage = onSelfMessage;
    this.onOpen = onOpen;
    this.selfId = '';
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.reconnectMs = Math.max(200, Number(reconnectMs) || 5000);
    /** 见过的 message_id → 时间：防止同一事件被投递两遍 */
    this.seen = new Map();
    /** 自己通过 API 发出去的 message_id：回显时别当成「别的客户端发的」重复记账 */
    this.ownSent = new Set();
    this.pokeSeen = new Map();
    /** 自己 API 发出去的消息记录（新→旧），供「撤回我刚说的那句」用 */
    this.sentLog = [];
    this.#connect();
  }

  #headers() {
    const h = {};
    if (this.accessToken) h.authorization = 'Bearer ' + this.accessToken;
    return h;
  }

  /**
   * 只维护一条连接。
   * 以前这里是「断了就再 new 一个」，旧 socket 没关，于是会出现两条连接
   * 同时收同一条消息 → 同一条消息回两遍。现在旧连接先作废，断的是当前这条才重连。
   */
  async #connect() {
    if (this.connecting) return;
    this.connecting = true;

    let sock;
    try {
      const impl = this.webSocketImpl
        ? { WebSocket: this.webSocketImpl }
        : await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
      const { WebSocket } = impl;
      sock = new WebSocket(this.wsUrl, { headers: this.#headers() });
    } catch (e) {
      this.connecting = false;
      console.log('[onebot] 连不上：' + (e?.message || e) + '，' + Math.round(this.reconnectMs / 1000) + ' 秒后重试');
      this.#scheduleReconnect();
      return;
    }
    this.connecting = false;

    const old = this.ws;
    this.ws = sock;
    if (old && old !== sock) {
      // 旧连接直接丢掉；它的 close 回调发现「当前连接不是自己」就不会再触发重连
      try { old.terminate ? old.terminate() : old.close?.(); } catch { /* 忽略 */ }
    }
    /** 这个 socket 是不是已经被替换掉了 */
    const stale = () => this.ws !== sock;

    sock.on?.('open', () => {
      if (stale()) return;
      this.connected = true;
      console.log('[onebot] 已连接 ' + this.wsUrl);
      try { this.onOpen?.(); } catch { /* 钩子出错不影响连接 */ }
    });
    sock.on?.('close', () => {
      if (stale()) return;
      this.connected = false;
      this.ws = null;
      console.log('[onebot] 断开，' + Math.round(this.reconnectMs / 1000) + ' 秒后重连');
      this.#scheduleReconnect();
    });
    sock.on?.('error', (e) => {
      console.log('[onebot] 出错 ' + (e?.message || e));
      try { sock.close(); } catch { /* 忽略 */ }
    });
    sock.on?.('message', (data) => {
      if (stale()) return;
      let ev;
      try { ev = JSON.parse(String(data)); } catch { return; }
      this.#handle(ev).catch((e) => console.log('[onebot] 处理事件出错 ' + (e?.message || e)));
    });
  }

  #scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, this.reconnectMs);
  }

  /** 第一次见到这条 message_id 返回 true；重复投递返回 false */
  #rememberOnce(id) {
    if (!id) return true;
    if (this.seen.has(id)) return false;
    const now = Date.now();
    this.seen.set(id, now);
    // Map 按插入顺序，最老的在最前面
    for (const [k, t] of this.seen) {
      if (now - t <= 10 * 60 * 1000) break;
      this.seen.delete(k);
    }
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    return true;
  }

  async #handle(ev) {
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      return;
    }
    if (ev.self_id) this.selfId = String(ev.self_id);
    if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      // 只唤醒真正戳向机器人的通知；自己发出的回声、戳别人的通知不处理。
      const sender = String(ev.user_id || ev.sender_id || '');
      if (!this.selfId || String(ev.target_id) !== this.selfId || !/^\d+$/.test(sender) || sender === this.selfId) return;
      const isGroup = !!ev.group_id;
      const key = isGroup ? 'group:' + ev.group_id : 'private:' + sender;
      const now = Date.now();
      if (now - (this.pokeSeen.get(key) || 0) < 45000) return;
      this.pokeSeen.set(key, now);
      while (this.pokeSeen.size > 100) this.pokeSeen.delete(this.pokeSeen.keys().next().value);
      this.onMessage?.({ key, isGroup, groupId: isGroup ? String(ev.group_id) : '', userId: sender,
        name: String(ev.sender?.card || ev.sender?.nickname || sender), text: '[戳一戳] 对方轻轻戳了你一下',
        isPoke: true, images: [], raw: [], messageId: '', time: now, isAtMe: false, atIds: [], forwards: [] });
      return;
    }

    // 自己这个号发出去的消息：不算「对方说话」，但也不能装没发生
    const isSelfSend = ev.post_type === 'message_sent'
      || (ev.post_type === 'message' && this.selfId && String(ev.user_id || '') === this.selfId);
    if (isSelfSend) return this.#handleSelf(ev);
    if (ev.post_type !== 'message') return;

    // 同一条消息可能被重复投递（旧连接没关、网关重发），只处理第一次
    if (!this.#rememberOnce(String(ev.message_id || ''))) {
      console.log('[onebot] 重复投递，忽略 ' + ev.message_id);
      return;
    }

    const isGroup = ev.message_type === 'group';
    const segs = Array.isArray(ev.message) ? ev.message : cqToSegs(ev.message || ev.raw_message || '');
    const replyId = findReply(segs);
    // 有没有 @ 我；被 @ 的都有谁（群上下文要把这些号翻成名字）
    const atIds = Array.isArray(segs)
      ? segs.filter((s) => s?.type === 'at' && s?.data?.qq).map((s) => String(s.data.qq))
      : [];
    const atMe = atIds.includes(String(this.selfId));
    const images = Array.isArray(segs)
      ? segs.filter((s) => s?.type === 'image' && s?.data).map((s) => s.data)
      : [];
    // 引用的到底是哪一条（NapCat 只给 message_id，得自己回头查）
    const quoted = replyId ? await this.#quotedOf(replyId) : null;

    const msg = {
      key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.user_id),
      name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id),
      text: segsToText(segs),
      raw: segs,
      forwards: forwardRefs(segs),
      images,
      isAtMe: atMe,
      atIds,
      isQuoteMe: !!(quoted && quoted.isSelf),
      replyTo: replyId,
      quoted,
      messageId: String(ev.message_id || ''),
      time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
    };
    this.onMessage?.(msg);
  }

  /**
   * 查一条被引用的消息：谁发的、说了什么、有没有图。
   * 查不到就返回 null，宁可少一个指代，也别拖住整轮回复。
   * 图这里只挑出来、原样带上去，真正变成能看的字节是 handleTurn 里的事。
   */
  async messageReference(id) { return this.#quotedOf(id); }

  async #quotedOf(id) {
    let timer = null;
    try {
      const r = await Promise.race([
        this.api('get_msg', { message_id: id }),
        new Promise((res) => { timer = setTimeout(() => res({ ok: false, error: '超时' }), 3000); timer.unref?.(); }),
      ]);
      const d = r?.data?.data;
      if (!r?.ok || !d) {
        console.log('[引用] 查不到 ' + id + '（' + (r?.error || '没有数据') + '）');
        return null;
      }
      // 正常是段数组；个别实现给 CQ 字符串，也得认
      const segs = Array.isArray(d.message)
        ? d.message
        : (typeof d.message === 'string' && d.message
          ? cqToSegs(d.message)
          : (typeof d.raw_message === 'string' && d.raw_message ? cqToSegs(d.raw_message) : []));
      const imgs = segs.filter((s) => s?.type === 'image' && s?.data).map((s) => s.data);
      const senderId = String(d.user_id || d.sender?.user_id || '');
      const messageType = d.message_type === 'private' && !d.group_id ? 'private' : d.message_type === 'group' ? 'group' : '';
      const sourceKey = r.data.status === 'ok' && Number(r.data.retcode) === 0 && String(d.message_id) === String(id)
        ? messageType === 'private' ? 'private:' + senderId : messageType === 'group' && d.group_id ? 'group:' + d.group_id : '' : '';
      const q = {
        id: String(id),
        senderId,
        messageType,
        sourceKey,
        ownText: segs.filter(s => s?.type === 'text').map(s => String(s.data?.text || '')).join('').trim(),
        name: String(d.sender?.card || d.sender?.nickname || senderId),
        text: segsToText(segs),
        images: imgs,
        forwards: forwardRefs(segs),
        hasImage: imgs.length > 0,
        isSelf: !!(this.selfId && senderId === this.selfId),
        time: (d.time || 0) * 1000,
      };
      console.log('[引用] ' + (q.isSelf ? '我' : q.name) + '：' + (q.text || '[空]').slice(0, 60)
        + (q.hasImage ? '（图 ' + q.images.length + ' 张）' : ''));
      return q;
    } catch (e) {
      console.log('[引用] 查 ' + id + ' 出错：' + (e?.message || e));
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 自己发出去的（含人工从手机发的）：交给上层记账，不触发回复 */
  #handleSelf(ev) {
    if (!this.onSelfMessage) return;
    const messageId = String(ev.message_id || '');
    // 我们自己的 sendSegments/send 已经写过账了，回显时跳过
    if (messageId && this.ownSent.has(messageId)) { this.ownSent.delete(messageId); return; }
    if (!this.#rememberOnce('self:' + messageId)) return;

    const isGroup = ev.message_type === 'group';
    const segs = ev.message;
    const images = Array.isArray(segs)
      ? segs.filter((s) => s?.type === 'image' && s?.data).map((s) => s.data)
      : [];
    this.onSelfMessage({
      key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.self_id || ev.user_id || ''),
      text: segsToText(segs),
      raw: segs,
      images,
      messageId,
      time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
    });
  }

  /** 记下「这条是我自己 API 发出去的」，并留一条撤回用的底（会话、原文、时间） */
  #noteOwn(r, key = '', text = '') {
    const id = r?.data?.data?.message_id;
    if (id) {
      this.ownSent.add(String(id));
      if (this.ownSent.size > 300) this.ownSent.delete(this.ownSent.values().next().value);
      this.sentLog.unshift({ id: String(id), key: String(key || ''), text: String(text || '').slice(0, 120), at: Date.now() });
      if (this.sentLog.length > 80) this.sentLog.pop();
    }
    return r;
  }

  /** 这个会话最近两分钟内自己发出去的消息（新的在前） */
  recentSent(key, { maxAgeMs = 110000 } = {}) {
    const cutoff = Date.now() - maxAgeMs;
    return this.sentLog.filter((s) => s.key === String(key || '') && s.at >= cutoff);
  }

  /**
   * 撤回自己刚发的一条。先从发送记录里找，再用 get_msg 核实确实是本账号发的，
   * 最后 delete_msg。QQ 对普通成员有约两分钟的撤回时限，超了会被拒。
   */
  async recallSent(key, match = '') {
    const cands = this.recentSent(key);
    if (!cands.length) return { ok: false, error: '这个会话近两分钟没有你发出去的消息' };
    const q = String(match || '').trim();
    const target = q ? cands.find((c) => c.text.includes(q)) : cands[0];
    if (!target) return { ok: false, error: '近两分钟发过的消息里没有包含「' + q.slice(0, 20) + '」的那条' };
    const chk = await this.api('get_msg', { message_id: target.id }, { timeoutMs: 6000 });
    const d = chk?.data?.data;
    if (!chk.ok || !d) return { ok: false, error: '那条已经查不到了（可能被撤回或太旧）' };
    if (String(d.user_id || '') !== String(this.selfId || '')) return { ok: false, error: '那条不是这个账号发的，不能撤' };
    const r = await this.api('delete_msg', { message_id: target.id }, { timeoutMs: 8000 });
    if (!r.ok) return { ok: false, error: r.error || 'QQ 拒绝了撤回（可能超过时限或权限不够）' };
    return { ok: true, id: target.id, text: target.text };
  }

  /** QQ互动共用文字/图片的发送节奏；目标已经由当前会话绑定。 */
  async sendSocial(key, action) {
    if (!/^group:\d+$/.test(key) || action.key !== key) return { ok: false, error: '互动会话不匹配' };
    if (action.kind === 'reaction') return this.api('set_msg_emoji_like', { message_id: action.messageId, emoji_id: action.emojiId, set: true });
    if (action.kind === 'poke') return this.api('group_poke', { group_id: key.slice(6), user_id: action.userId });
    return { ok: false, error: '未知互动' };
  }

  /** 调 OneBot 的 HTTP API */
  async api(action, params = {}, { timeoutMs = 30000 } = {}) {
    if (!this.httpUrl) return { ok: false, error: '没配 httpUrl' };
    try {
      const r = await fetch(this.httpUrl + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers() },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(Math.max(1, Math.min(30000, Math.floor(timeoutMs)))),
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok && j.status !== 'failed' && Number(j.retcode || 0) === 0, data: j, error: j.message || j.wording };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /**
   * 把一个 image 段取成字节。
   * 依次尝试：http 链接 → 本地文件 → get_image 接口。
   * 失败返回 null，不影响文字部分。
   * @returns {Promise<{buffer:Buffer, mime:string}|null>}
   */
  async imageBytes(d = {}, { maxBytes = 6 * 1024 * 1024 } = {}) {
    const cands = [d.url, d.file, d.path, d.file_path].filter((v) => typeof v === 'string' && v);

    // 1) 已经是 http 链接
    for (const c of cands) {
      if (!/^https?:\/\//i.test(c)) continue;
      try {
        const r = await fetch(c, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const b = Buffer.from(await r.arrayBuffer());
        if (!b.length || b.length > maxBytes) continue;
        // 有的 CDN 给 application/octet-stream，模型不认；不认识的按文件头猜
        const ct = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        return { buffer: b, mime: /^image\//.test(ct) ? ct : sniffImage(b) };
      } catch { /* 下一个 */ }
    }

    // 2) 本地文件（注意容器路径翻译）
    for (const c of cands) {
      if (/^https?:\/\//i.test(c)) continue;
      const p = hostPath(c);
      if (!p.startsWith('/')) continue;
      try {
        const b = fs.readFileSync(p);
        if (!b.length || b.length > maxBytes) continue;
        return { buffer: b, mime: sniffImage(b) };
      } catch { /* 下一个 */ }
    }

    // 3) 问 NapCat 要
    if (d.file) {
      const r = await this.api('get_image', { file: d.file });
      const f = r?.data?.data?.file || r?.data?.data?.path;
      if (f) {
        try {
          const b = fs.readFileSync(hostPath(f));
          if (b.length && b.length <= maxBytes) return { buffer: b, mime: sniffImage(b) };
        } catch { /* 放弃 */ }
      }
    }
    return null;
  }

  /** 把一个 image 段变成 data URL（模型能直接吃的格式） */
  async imageToDataUrl(d = {}, { maxBytes = 6 * 1024 * 1024 } = {}) {
    const got = await this.imageBytes(d, { maxBytes });
    if (!got) return null;
    return 'data:' + got.mime + ';base64,' + got.buffer.toString('base64');
  }

  /** 发一条纯文本 */
  send(key, text, { atUserId } = {}) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    let message = String(text);
    if (atUserId) message = '[CQ:at,qq=' + atUserId + '] ' + message;
    return (isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message })).then((r) => this.#noteOwn(r, key, message));
  }

  /** 发一组消息段（文字、图片、表情包都走这里） */
  sendSegments(key, segs) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    const message = Array.isArray(segs) ? segs : [segs];
    if (!message.length) return Promise.resolve({ ok: false, error: '没有消息段' });
    const brief = message.map((s) => (s?.type === 'text' ? String(s.data?.text || '') : '[' + (s?.type || '?') + ']')).join('').slice(0, 120);
    return (isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message })).then((r) => this.#noteOwn(r, key, brief));
  }

  /**
   * 发一张图（本地文件 / http 链接 / base64:// 都行）
   * 本地文件一律转 base64：NapCat 在容器里，看不见宿主机的路径。
   */
  async sendImage(key, file) {
    const f = String(file || '');
    if (!f) return { ok: false, error: '没给图' };
    let seg;
    if (/^(https?:\/\/|base64:\/\/)/i.test(f)) {
      seg = { type: 'image', data: { file: f } };
    } else {
      try {
        const b = fs.readFileSync(hostPath(f));
        if (!b.length) return { ok: false, error: '图是空的' };
        seg = { type: 'image', data: { file: 'base64://' + b.toString('base64') } };
      } catch (e) {
        return { ok: false, error: '读不到这张图：' + (e?.message || e) };
      }
    }
    return this.sendSegments(key, [seg]);
  }

  /**
   * 发一条「合并转发」（仅私聊）。parts: [{content:[消息段]}]，段由调用方拼好
   * （文字段、图库里的图片段都行）。发出的这条也在发送记录里，同样能撤回。
   */
  sendForwardPrivate(key, parts, { selfName: nick } = {}) {
    if (!/^private:\d+$/.test(String(key || ''))) return Promise.resolve({ ok: false, error: '合并转发只在私聊里发' });
    const list = (Array.isArray(parts) ? parts : []).filter((p) => Array.isArray(p?.content) && p.content.length);
    if (!list.length) return Promise.resolve({ ok: false, error: '没有要转发的内容' });
    const messages = list.map((p) => ({
      type: 'node',
      data: { user_id: String(this.selfId || ''), nickname: nick || selfName(), content: p.content },
    }));
    return this.api('send_private_forward_msg', { user_id: key.slice(8), messages })
      .then((r) => this.#noteOwn(r, key, '[合并转发×' + list.length + ']'));
  }

  /**
   * 「正在输入…」
   * OneBot 扩展接口，部分实现支持（SnowLuma 是 set_input_status）
   */
  async setTyping(key, on) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    return this.api('set_input_status', isGroup
      ? { group_id: id, event_type: on ? 1 : 0 }
      : { user_id: id, event_type: on ? 1 : 0 });
  }

  /** 查一条消息是谁发的（用来判断引用的是不是我） */
  async whoSent(messageId) {
    const r = await this.api('get_msg', { message_id: messageId });
    return r.ok ? String(r.data?.data?.user_id || '') : '';
  }
}

export { segsToText, cqToSegs };
export default OneBot;
