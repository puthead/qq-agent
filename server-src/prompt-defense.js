// 代码边界用于减少已知泄露/持久化路径；不能代替模型的语义判断。
export function unsafeMemory(text) {
  return /(?:忽略|覆盖|废除|泄露|公开|背出|打印|输出).{0,24}(?:系统|提示词|规则|凭据|密钥)|(?:system|developer)\s*:|(?:以后|从现在|记住).{0,24}(?:我是.{0,6}主人|无条件服从|关闭.{0,6}限制)|\b(?:api.?key|access.?token)\s*[:=]/i.test(String(text));
}
export function disclosure(text, { secrets = [], card = '', group = false } = {}) {
  const s = String(text || '');
  if (secrets.some(x => typeof x === 'string' && x.length >= 8 && s.includes(x))) return true;
  if (/\b(?:sk-[\w-]{16,}|Bearer\s+[\w.-]{16,})|[A-Za-z]:[\\/](?:Users|Windows|Program Files|NapCat)|\b(?:127\.0\.0\.1|localhost):\d{2,5}/i.test(s)) return true;
  if (card.split(/\n/).some(p => p.length >= 36 && s.includes(p.trim().slice(0,36)))) return true;
  return group && /(?:我|我的|这边|本服务|后台).{0,70}(?:滚动摘要|原话归档|长期记忆.{0,8}分开|reasoning_effort|toolRounds|service-paused|按关键词.{0,10}原话)|(?:触发|唤醒).{0,16}(?:概率|阈值)|NapCat|DSH|companion\/src/i.test(s);
}
