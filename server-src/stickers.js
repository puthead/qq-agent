/**
 * 表情包 · 她自己的那一叠
 * ─────────────────────────────────────────────────────────────
 * 表情包不是"发图"，是"发一个情绪"。
 *
 * 这一层只做三件事：
 *   1. 扫一个目录，把里面的图片变成一张可用的表情包清单
 *   2. 让模型按 id 挑一张（名字和标签都从文件名里来）
 *   3. 把那张图变成 OneBot 能直接发的消息段（base64，不依赖容器挂载）
 *
 * 目录约定（丢进去就能用，不用写代码）：
 *   <dir>/开心__高兴,好耶.png      → id=开心  标签=高兴/好耶
 *   <dir>/哭哭.png                 → id=哭哭  没有标签
 *   <dir>/index.json（可选）        → 想改名、改标签、加描述时用：
 *       [{ "id": "哭哭", "file": "cry.jpg", "tags": ["委屈"], "desc": "眼圈红红" }]
 *
 * 为什么是 base64：NapCat 可能跑在容器里，只挂载了自己的目录，
 * 看不见宿主机上的表情库；直接传字节最省事，也不用改挂载。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** 从文件名切出 id 和标签 */
export function parseStickerName(file) {
  const base = path.basename(String(file || '')).replace(/\.[^.]+$/, '');
  const [head, tail] = base.split('__');
  const id = String(head || base).trim();
  const tags = String(tail || '')
    .split(/[,，、/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { id: id || base, tags };
}

export class StickerBook {
  /**
   * @param {object} opts
   * @param {string} opts.dir            表情包目录
   * @param {number} [opts.cooldownMs]   同一会话表情包冷却时间（默认 0，不做冷却）
   * @param {number} [opts.maxPerTurn]   一条回复里最多几张（默认 1）
   * @param {number} [opts.maxBytes]     单张上限，超了不收录（默认 4 MB）
   * @param {number} [opts.gapMs]        说完话到发图之间的停顿（默认 900ms）
   * @param {number} [opts.refreshMs]    多久重新扫一次目录（默认 30 秒，丢文件进去就能用）
   */
  constructor({ dir, cooldownMs = 0, maxPerTurn = 1, maxBytes = 4 * 1024 * 1024, gapMs = 900, refreshMs = 30000, maxEntries = 300, removeFloor = 8 } = {}) {
    this.dir = path.resolve(String(dir || './stickers'));
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.maxPerTurn = Math.max(1, Number(maxPerTurn) || 1);
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || 4 * 1024 * 1024);
    this.gapMs = Math.max(0, Number(gapMs) || 0);
    this.refreshMs = Math.max(1000, Number(refreshMs) || 30000);
    /** 库里最多留多少张（自己存的图也算） */
    this.maxEntries = Math.max(20, Number(maxEntries) || 300);
    /** 至少留这么多张才许删：防一次清空 */
    this.removeFloor = Math.max(0, Number(removeFloor ?? 8));
    /** @type {Array<{id:string,tags:string[],desc:string,file:string,path:string,bytes:number}>} */
    this.entries = [];
    this.scannedAt = 0;
    /** 会话 key → 上次发图时间 */
    this.lastSent = new Map();
  }

  /** 扫目录；文件没动过就直接用缓存 */
  scan({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.entries.length && now - this.scannedAt < this.refreshMs) return this.entries;
    this.scannedAt = now;

    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { this.entries = []; return this.entries; }

    // index.json 可选：想改 id / 标签 / 描述的时候用
    const overrides = new Map();
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8'));
      const arr = Array.isArray(j)
        ? j
        : Object.entries(j || {}).map(([id, v]) => (typeof v === 'string' ? { id, file: v } : { id, ...(v || {}) }));
      for (const e of arr) if (e && e.file) overrides.set(String(e.file), e);
    } catch { /* 没有就算了 */ }

    const entries = [];
    for (const f of files) {
      if (!IMG_EXT.has(path.extname(f).toLowerCase())) continue;
      const full = path.join(this.dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || !st.size || st.size > this.maxBytes) continue;
      const fromName = parseStickerName(f);
      const o = overrides.get(f) || {};
      entries.push({
        id: String(o.id || fromName.id).trim(),
        tags: Array.isArray(o.tags) && o.tags.length ? o.tags.map(String) : fromName.tags,
        desc: String(o.desc || ''),
        file: f,
        path: full,
        bytes: st.size,
      });
    }
    entries.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'));
    this.entries = entries;
    return entries;
  }

  get size() { return this.scan().length; }

  ids() { return this.scan().map((e) => e.id); }

  /** 给模型看的一行清单：哭哭(委屈/难过) 生气(炸毛/不爽) … */
  catalog() {
    return this.scan()
      .map((e) => e.id + (e.tags.length ? '(' + e.tags.join('/') + ')' : ''))
      .join(' ');
  }

  /**
   * 按模型给的名字挑一张。
   * 容忍 "哭哭"、""哭哭.png""、"哭哭(委屈)"、"委屈" 这几种写法。
   */
  pick(name) {
    const raw = String(name || '').trim();
    if (!raw) return null;
    const entries = this.scan();
    if (!entries.length) return null;

    const norm = (s) => String(s || '')
      .replace(/[「」"'“”‘’《》]/g, '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[（(].*?[)）]/g, '')
      .replace(/[。．.！!？?…~～\s]+$/g, '')
      .trim();

    const q = norm(raw);
    let hit = entries.find((e) => e.id === q);
    if (hit) return hit;

    // 名字包含 / 被包含
    hit = entries.find((e) => e.id.includes(q) || q.includes(e.id));
    if (hit) return hit;

    // 标签也能点
    hit = entries.find((e) => e.tags.some((t) => t === q || t.includes(q) || q.includes(t)));
    if (hit) return hit;

    // 描述兜底
    hit = entries.find((e) => e.desc && (e.desc.includes(q) || q.includes(e.desc)));
    return hit || null;
  }

  /** 这个会话现在能不能发（冷却） */
  canSend(key) {
    if (this.cooldownMs <= 0) return { ok: true };
    const last = this.lastSent.get(String(key || ''));
    if (!last) return { ok: true };
    const left = this.cooldownMs - (Date.now() - last);
    if (left <= 0) return { ok: true };
    return { ok: false, reason: '刚发过表情包，这次别发', leftMs: left };
  }

  markSent(key) { this.lastSent.set(String(key || ''), Date.now()); }

  /** 算文件内容指纹（存图去重用） */
  #hashOf(p) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; }
  }

  /**
   * 把聊天里收到的一张图收进库里。
   * 名字她起（2~6 个字最好），标签是情绪词；重名自动加序号，同一张图不会存两遍。
   * @returns {{ok:boolean, entry?:object, duplicate?:boolean, reason?:string}}
   */
  save({ name, tags = [], buffer, mime = '' } = {}) {
    const id = String(name || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 12);
    if (!id) return { ok: false, reason: '没给名字' };
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: '图片是空的' };
    if (buffer.length > this.maxBytes) return { ok: false, reason: '这张太大了，存不下' };
    this.scan({ force: true });


    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    for (const e of this.entries) {
      if (this.#hashOf(e.path) === sha) return { ok: true, duplicate: true, entry: e };
    }

    if (this.entries.length >= this.maxEntries) {
      return { ok: false, reason: '表情包已经有 ' + this.entries.length + ' 张了，先删几张再存' };
    }

    const ext = mime.includes('png') ? '.png'
      : mime.includes('gif') ? '.gif'
        : mime.includes('webp') ? '.webp' : '.jpg';
    const tagList = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，、/\s]+/))
      .map((t) => String(t).replace(/[\\/:*?"<>|]+/g, '').trim())
      .filter(Boolean)
      .slice(0, 4);

    let finalId = id;
    for (let i = 2; this.entries.some((e) => e.id === finalId); i++) finalId = id + i;
    const file = finalId + (tagList.length ? '__' + tagList.join(',') : '') + ext;
    const full = path.join(this.dir, file);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(full, buffer);
    } catch (e) {
      return { ok: false, reason: '写文件失败：' + (e?.message || e) };
    }

    this.scannedAt = 0;
    const entry = this.scan({ force: true }).find((e) => e.file === file)
      || { id: finalId, tags: tagList, desc: '', file, path: full, bytes: buffer.length };
    return { ok: true, entry };
  }

  /** 读一张图，做成 OneBot 的消息段 */
  segment(entryOrId) {
    const e = typeof entryOrId === 'string' ? this.pick(entryOrId) : entryOrId;
    if (!e) return null;
    let buf;
    try { buf = fs.readFileSync(e.path); } catch { return null; }
    if (!buf.length || buf.length > this.maxBytes) return null;
    return { type: 'image', data: { file: 'base64://' + buf.toString('base64') } };
  }

  #validId(id) {
    const v = String(id || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16);
    return v;
  }

  /**
   * 改名/改标签（顺手把文件名一起改掉，清单里看到的和磁盘上是一致的）。
   * index.json 的覆盖不跟着搬：改名会去掉按旧文件名匹配的覆盖，宁可用文件名说话。
   */
  rename(id, newName = '', tags = undefined) {
    this.scan({ force: true });
    const e = this.pick(id);
    if (!e) return { ok: false, reason: '库里没有这张：' + id };
    const nid = tags === undefined && !newName ? '' : this.#validId(newName || e.id);
    if (!nid) return { ok: false, reason: '新名字不合法（不能带空格和符号）' };
    if (this.entries.some((x) => x.id === nid && x.file !== e.file)) return { ok: false, reason: '已经有叫「' + nid + '」的了' };
    let tagList = e.tags;
    if (tags !== undefined) {
      tagList = String(tags).split(/[,，、/\s]+/).map((t) => t.replace(/[\\/:*?"<>|]+/g, '').trim()).filter(Boolean).slice(0, 4);
    }
    const file = nid + (tagList.length ? '__' + tagList.join(',') : '') + path.extname(e.file);
    try { fs.renameSync(e.path, path.join(this.dir, file)); } catch (err) {
      return { ok: false, reason: '改名失败：' + (err?.message || err) };
    }
    this.scannedAt = 0;
    const entry = this.scan({ force: true }).find((x) => x.file === file) || null;
    return { ok: true, entry, from: e.id };
  }

  /** 删掉一张（磁盘上真删）。库里快见底时拒绝，防止一次清空 */
  remove(id) {
    this.scan({ force: true });
    const e = this.pick(id);
    if (!e) return { ok: false, reason: '库里没有这张：' + id };
    if (this.entries.length <= this.removeFloor) return { ok: false, reason: '库里只剩 ' + this.entries.length + ' 张了，先别删' };
    try { fs.unlinkSync(e.path); } catch (err) {
      return { ok: false, reason: '删除失败：' + (err?.message || err) };
    }
    this.scannedAt = 0;
    return { ok: true, removed: e.id, file: e.file };
  }
}

export default StickerBook;
