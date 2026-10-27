// QQ 的补 @ 是寻址信息；不要把它当成取代前文的新问题。
export const withoutMentions = text => String(text || '').replace(/@(?:\d+|all)\b/g, '').trim();
const hasMedia = m => !!(m.images?.length || m.forwards?.length);

/** 引用机器人并只 @ 第三人：把这句话转给那个人看，不是向机器人提问。 */
export function isQuoteRelay(m) {
  if (!m?.isGroup || !(m.replyTo || m.quoted) || !(m.isQuoteMe || m.quoted?.isSelf)) return false;
  if (withoutMentions(m.text) || hasMedia(m)) return false;
  const ids = (m.atIds || []).map(String);
  const self = String(m.selfId || m.quoted?.senderId || '');
  return self ? ids.some(id => id !== self) : ids.length > (m.isAtMe ? 1 : 0);
}

/** 只提升同群同账号、补 @ 前两分钟内的未答原话；显式引用优先。 */
export function expandAddressedBatch(items, groupCtx) {
  const active = items.filter(m => !isQuoteRelay(m));
  const expanded = [];
  const seen = new Set(active.map(m => String(m.messageId || '')).filter(Boolean));
  const linkedIds = [];
  for (const ping of active) {
    const bare = ping.isGroup && ping.isAtMe && ping.userId && !ping.isPoke
      && !ping.replyTo && !ping.quoted && !withoutMentions(ping.text) && !hasMedia(ping)
      && (ping.atIds || []).length === 1;
    const poke=ping.isGroup&&ping.isPoke&&ping.userId&&!ping.replyTo&&!ping.quoted&&!hasMedia(ping);
    if ((bare||poke) && groupCtx?.liveRows) {
      const rows = groupCtx.liveRows(ping.key);
      const at = rows.findIndex(m => m.messageId && String(m.messageId) === String(ping.messageId));
      const anchor = at >= 0 ? rows[at].t : Number(ping.time) || Date.now();
      const candidates = at >= 0 ? rows.slice(0, at) : rows.filter(m => m.t < anchor);
      const picked = [];
      let newest = 0;
      for (const row of candidates.slice().reverse()) {
        if (row.t > anchor || anchor - row.t > (poke?45000:120000)) continue;
        // 已找到本人的新问题后，之前的机器人回复就是上一轮的边界。
        // 尚未找到问题时则允许越过回复：它可能还在回答更早的那一轮。
        if (row.isSelf) { if (poke||picked.length) break; continue; }
        if (String(row.userId) !== String(ping.userId)) {if(poke)break;continue;}
        // 不接另一段对话，不把已回答内容再送一遍，不绕过明确的 @ / 引用对象。
        if (row.answered || seen.has(String(row.messageId)) || row.atIds?.length || row.replyTo) break;
        if (newest && newest - row.t > 30000) break;
        if (!withoutMentions(row.text) && !hasMedia(row)) continue;
        if(poke&&!picked.length&&!/(?:你|小[dDＤ]|小迪).{0,40}(?:能不能|会|吗|么|咋|怎么|为啥|什么|呢|[？?])/.test(row.text||''))break;
        if(poke&&hasMedia(row))break;
        picked.unshift({ ...row, key: ping.key, isGroup: true, groupId: ping.groupId, time: row.t });
        newest ||= row.t;
        if (picked.length >= 3) break;
      }
      for (const row of picked) {
        if (row.messageId) { seen.add(String(row.messageId)); linkedIds.push(String(row.messageId)); }
        expanded.push(row);
      }
    }
    expanded.push(ping);
  }
  return { items: expanded, linkedIds };
}
