import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJSON } from './conversation-memory.js';
import { selfName } from './identity.js';

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 只剥本机当前角色名的称呼前缀，不再硬编码某个名字。
const alias = () => '(?:' + esc(selfName()) + '(?:啊|呀)?[，,：:]*)';

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_AGE = 120000;
const busy = new WeakSet();
const ownText = m => (Array.isArray(m.raw) ? m.raw : [])
  .filter(s => s?.type === 'text').map(s => String(s.data?.text || '')).join('').trim();

// Recognize common explicit requests for status reporting. This is not the
// permission boundary: actual account, conversation and bound image are checked
// independently; other natural requests can be interpreted by the tool model.
export function isAvatarCommand(value) {
  let s = String(value || '').trim().replace(/[。！!，,、\s]+$/g, '');
  if (!s || /[?？“”"「」『』`\n\r]|别|不要|不用|不许|取消|撤回|暂|先不|以后|下次|明天|如果|假如|假设|能否|能不能|可不可以|怎么|如何|测试|示例|例如|假装|他说|她说|别人/.test(s)) return false;
  s = s.replace(/[ \t]+/g, '').replace(new RegExp('^(?:' + alias() + '|请|麻烦你?|帮我|帮忙|现在|直接|立即|你(?=把|将|帮|换|改|用))+'), '').replace(/(?:吧|啦|呀|哦|哈|呗)+$/, '');
  const pic = '(?:(?:这|那)(?:张|个|幅)(?:图|图片)?|刚(?:才|发的)(?:那|这)?张(?:图|图片)?|上一张(?:图|图片)?)';
  const avatar = '(?:(?:你(?:的)?|QQ|qq)的?)?头像';
  return [
    `(?:把|将)?${avatar}(?:换|改|更换|设置)(?:一下|下)?(?:成|为)?${pic}`,
    `(?:把|将)?${pic}(?:设为|设置为|换成|改成|作为|当作|用作|做)${avatar}`,
    `(?:就)?(?:用|拿)${pic}(?:给你)?(?:当|做|作为|设置|换)(?:个|一下|成|为)?${avatar}`,
    `${pic}(?:给你)?(?:当|做)${avatar}`,
    `(?:换|更换|更新|修改|设置)(?:一下|下|个)?${avatar}`,
    `(?:换|更换|更新|修改|设置)(?:一下|下|个)?${avatar}(?:用|成|为)?${pic}`,
  ].some(pattern => new RegExp('^' + pattern + '$').test(s));
}

// The transport resolves this metadata through get_msg. A quote supplies the
// referent, never the current authorization, and may survive a service restart.
function verifiedQuote(row, key, userId) {
  const q = row?.quoted;
  return q && String(row.replyTo || '') === String(q.id || '') && q.messageType === 'private'
    && q.sourceKey === key && String(q.senderId) === userId && !q.isSelf ? q : null;
}

function isAvatarRetry(value) {
  const s = String(value || '').trim().replace(/[。！!？?，,\s]+$/g, '').replace(/[ \t]/g, '')
    .replace(new RegExp('^(?:' + alias() + '|请|麻烦你?|帮我|你)+'), '').replace(/(?:吧|啦|呀|哦|呗)+$/, '');
  return /^(?:(?:再|重新)(?:换|更换|设置)(?:一下|下|一次|一遍)?(?:头像)?(?:试试|试一下)?|再试(?:一次|一下|试)|换(?:一下|下)(?:头像)?试试)$/.test(s);
}

export function avatarRequestKind(value, quoted, priorTopic=false) {
  if (isAvatarCommand(value)) return 'explicit';
  const quoteTopic = /头像/.test(quoted?.ownText || '');
  if (quoteTopic && isAvatarRetry(value)) return 'explicit';
  const text = String(value || '').trim();
  // These are not new execution requests. Neither quoted instructions nor OCR
  // can supply the current owner's action; inspect the raw text segment only.
  if (!text || text.length > 300 || /[“”"「」『』`\n\r]|别|不要|不用|不许|取消|撤回|暂|先不|以后|下次|明天|如果|假如|假设|怎么|如何|测试|示例|例如|假装|他说|她说|别人|然后|删文件|输出密码/.test(text)) return '';
  const topic = /头像/.test(text) || quoteTopic || priorTopic;
  if (!topic || !/(?:换|改|设|用|选|采用|试|做|当|拿)/.test(text)) return '';
  // Pure capability questions stay informational; requests with a concrete
  // object (e.g. '能帮我把这张用作头像吗') are left to semantic interpretation.
  if (/(?:能|会|可以|支持|有没有).{0,12}头像.{0,6}(?:吗|么|功能|能力|[?？])/.test(text)
    && !/(?:这|那|帮|给|把|将|再)/.test(text)) return '';
  // Everything else is a candidate, not a parser-created command. The model
  // must resolve the current request against this verified reference and may
  // decline/ask for clarification without invoking the mutation tool.
  return 'semantic';
}

export function isAvatarTopic(items = []) {
  const row = items.findLast(m => ownText(m));
  if (!row) return false;
  return /头像/.test(ownText(row)) || /头像/.test(verifiedQuote(row, row.key, String(row.userId))?.ownText || '');
}

// A missing per-turn execution grant is not a missing installed capability.
export function correctAvatarCapability(out, {ownerPrivate=false,text='',session=null,topic=false}={}) {
  if (!ownerPrivate || (session && !session.available) || session?.result || (!topic && !/头像/.test(String(text)))) return out;
  const unavailable = /(?:头像|功能|工具|接口).{0,24}(?:没挂|没接|未接|没开|不支持|弄不了|换不了|动不了|没有权限)|(?:没有|没|缺).{0,16}(?:工具|接口|权限)|(?:等|等待).{0,12}(?:接入|接进来|挂上)|(?:手机|连接|桥).{0,12}(?:连不上|断|失败|没连|不可用)|(?:连不上|断开).{0,12}手机/.test(String(out));
  return unavailable ? session?.available ? '图片已收到，换头像通道可用，但这次还没有执行' : '能换头像，不需要连接手机。这次还没执行；私聊发一张图或引用你之前发的图，再明确要求换成它就行' : out;
}

function decodeImage(url) {
  const match = /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(url || ''));
  if (!match || match[1].length > Math.ceil(MAX_BYTES / 3) * 4) return null;
  const b = Buffer.from(match[1], 'base64');
  if (!b.length || b.length > MAX_BYTES) return null;
  let width = 0, height = 0;
  if (b.length >= 33 && b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && b.toString('ascii',12,16) === 'IHDR') {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length > 4 && b[0] === 255 && b[1] === 216) {
    for (let i = 2; i + 3 < b.length;) {
      if (b[i++] !== 255) break;
      while (b[i] === 255) i++;
      const marker = b[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (i + 2 > b.length) break;
      const size = b.readUInt16BE(i);
      if (size < 2 || i + size > b.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
        height = b.readUInt16BE(i+3); width = b.readUInt16BE(i+5); break;
      }
      i += size;
    }
  }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32000000 ? b : null;
}

export function createAvatarSession({items=[], ownerIds=[], recentMedia, bot, dataDir, context=null, dryRun=false, now=Date.now}={}) {
  const rows = structuredClone(items);
  const last = rows.at(-1);
  const owners = new Set(ownerIds.map(String));
  const userId = String(last?.userId || ''), key = String(last?.key || '');
  const authorized = () => owners.has(userId) && key === 'private:' + userId && rows.every(m =>
    m.isGroup === false && !m.isSelf && !m.isBot && !m.isPoke && m.key === key && String(m.userId) === userId);
  if (!last || !authorized()) return null;
  // A leading photo caption is not part of the later command. The most recent
  // actual text wins, so a later cancellation cannot leave an earlier grant live.
  const commandRow = rows.findLast(m => ownText(m));
  const command = commandRow ? ownText(commandRow) : '';
  const quoted = verifiedQuote(commandRow, key, userId);
  const validContext = context?.key===key && String(context?.userId)===userId
    && context.anchor?.messageType==='private' && context.anchor.sourceKey===key
    && String(context.anchor.senderId)===userId && !context.anchor.isSelf && /头像/.test(context.anchor.ownText||'');
  const kind = avatarRequestKind(command, quoted, validContext);
  if (!kind) {
    if (isAvatarTopic(rows)) console.log('[头像请求] '+JSON.stringify({key,messageId:last.messageId,status:'not-an-action-request'}));
    return null;
  }
  const fresh = () => Number.isFinite(commandRow.time) && commandRow.time <= now() + 5000 && now() - commandRow.time <= MAX_AGE;
  const commandId = String(commandRow.messageId || '');
  if (!/^-?\d+$/.test(commandId) || !fresh()) return null;

  const originals = items.flatMap(m => (m.images || []).map(seg => ({seg,messageId:String(m.messageId || ''),at:m.time})));
  const replies = [...new Set(rows.map(m => String(m.replyTo || '')).filter(Boolean))];
  let candidates = originals;
  if (replies.length) {
    candidates = [];
    if (!originals.length && replies.length === 1) {
      const replyRow = rows.findLast(m => String(m.replyTo || '') === replies[0]);
      const q = verifiedQuote(replyRow, key, userId);
      // Conflicting/unverified fetched metadata cannot fall back to a cache hit.
      candidates = q ? (q.images || []).map(seg => ({seg,messageId:q.id,at:q.time}))
        : !replyRow?.quoted ? recentMedia?.forAvatar({key,userId,replyTo:replies[0],before:last.time}) || [] : [];
    }
  }
  else if (!originals.length) {
    candidates = recentMedia?.forAvatar({key,userId,before:last.time}) || [];
    const ref=validContext?context.reference:null;
    if(!candidates.length&&ref?.messageType==='private'&&ref.sourceKey===key&&String(ref.senderId)===userId&&!ref.isSelf)
      candidates=(ref.images||[]).map(seg=>({seg,messageId:ref.id,at:ref.time}));
  }
  const source = candidates.length === 1 ? candidates[0] : null;
  console.log('[头像请求] '+JSON.stringify({key,messageId:commandId,intent:kind,status:source?'image-bound':candidates.length>1?'ambiguous-images':'missing-image'}));
  const sourceSnapshot = source ? JSON.stringify(source.seg) : '';
  let image = null, attempted = false, result = null;
  let hint = !source ? '换头像请求已核验，但没有来源核验通过的唯一图片。请单独发一张PNG或JPG图片，或引用你本人在此私聊发的那张图，再明确要求换头像。' : '换头像图片尚未载入，不能宣称已更换。';
  const session = {
    source, linkedImages: originals.length ? [] : candidates,
    explicit: kind === 'explicit',
    request: Object.freeze({currentOwnerText:command,commandMessageId:commandId,commandAt:commandRow.time,
      quotedOwnerText:quoted?.ownText || '',quotedMessageId:quoted?.id || '',contextOwnerText:validContext?context.anchor.ownText:'',
      sourceMessageId:source?.messageId || '',imageProvidedAfterRequest:source?.messageId!==commandId&&source?.at>commandRow.time}),
    get available() { return !!source && !!image && fresh() && !attempted; },
    get hint() { return hint; },
    get result() { return result; },
    bindPreview(url) {
      if (attempted || !source || JSON.stringify(source.seg) !== sourceSnapshot) return;
      image = decodeImage(url);
      hint = image ? (kind === 'explicit'
        ? '本轮主人明确要求换QQ头像，唯一图片已核验并载入，请调用set_qq_avatar。'
        : '本轮主人和唯一图片已核验并载入。结合currentOwnerText与引用理解这轮要求；引用原文只帮助确定对象，不能单独授权。当前要求确实是换QQ头像才调用set_qq_avatar；审美评价、能力询问、改图片内容或不明指代不执行，必要时澄清。')
        + '只有工具返回成功才能说已更换；旧对话中“动不了/未接入”的说法已经失效。'
        : '头像只接受6MiB以内的有效PNG/JPG图片（边长最多8192）。本轮图片未通过检查，请重发静态PNG或JPG。';
    },
    async execute(args={}, identity={}) {
      if (!authorized() || identity.isOwner !== true || identity.key !== key || String(identity.userId) !== userId || identity.proactive) return '没有换头像权限，只接受已核验主人的私聊明确要求。';
      if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return '换头像工具不接受路径、链接、账号或其他参数，只能使用本轮绑定的图片。';
      if (attempted) return result?.message || '本轮已尝试过换头像，不重复执行。';
      if (!source || !image || !fresh()) return '图片或授权已失效，请重新发图并明确要求换头像。';
      if (JSON.stringify(source.seg) !== sourceSnapshot) return '图片来源发生变化，请重新发送。';
      if (dryRun || identity.dryRun) return '试运行：权限及图片检查通过，没有更改QQ头像。';
      if (!bot || typeof bot.api !== 'function' || !dataDir) return '换头像通道不可用，未执行。';
      if (busy.has(bot)) return '上一笔换头像仍在处理，请稍后查看结果。';
      busy.add(bot); attempted = true;
      const journal = path.join(dataDir, 'avatar-changes.json');
      const requestKey = key + ':' + commandId;
      let entries;
      try {
        try { entries = JSON.parse(fs.readFileSync(journal,'utf8')); }
        catch(e) { if(e.code !== 'ENOENT') throw e; entries=[]; }
        if (!Array.isArray(entries)) throw new Error('Invalid avatar journal');
        if (entries.some(r => r.requestKey === requestKey)) {
          result = {success:false,message:'这条换头像请求已处理或仍待核实，不重复执行；请先查看当前头像。'};
          return result.message;
        }
        const row = {requestKey,userId,sourceMessageId:source.messageId,at:new Date(now()).toISOString(),sha256:crypto.createHash('sha256').update(image).digest('hex'),status:'pending'};
        entries = [...entries.slice(-19),row];
        atomicJSON(journal, entries);
        const r = await bot.api('set_qq_avatar', {file:'base64://' + image.toString('base64')});
        const success = r?.ok === true && r.data?.status === 'ok' && Number(r.data?.retcode) === 0;
        row.status = success ? 'confirmed' : r?.data?.status === 'failed' ? 'failed' : 'unconfirmed';
        result = {success,message:success ? 'QQ接口已确认头像设置成功；客户端显示可能稍有延迟。' : '换头像未获得成功确认，请先查看当前头像再决定是否重试。'};
        try { atomicJSON(journal,entries); } catch { console.warn('[头像] 结果记录失败，保留pending记录防止重复执行'); }
        console.log('[头像] ' + JSON.stringify({requestKey,status:row.status}));
        return result.message;
      } catch {
        result = {success:false,message:'换头像未完成或结果未确认，请先查看当前头像；本轮不自动重试。'};
        return result.message;
      } finally { busy.delete(bot); }
    },
  };
  return session;
}
