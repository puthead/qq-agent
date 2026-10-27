// 按文本字符保守限额；图片独立沿用张数和字节限额。保持工具调用/结果配对。
export function textSize(messages) {
  return messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : (m.content || []).reduce((a, p) => a + (p.text?.length || 0), 0)) + JSON.stringify(m.tool_calls || []).length + (m.reasoning_content?.length || 0), 0);
}
export function boundMessages(messages, maxChars = 60000) {
  const out = structuredClone(messages);
  if (textSize(out) <= maxChars) return out;
  for (const m of out) if (m.role === 'tool' && typeof m.content === 'string') m.content = m.content.slice(0, 700) + '\n[工具结果已节选]';
  // 只删除无 tool_calls 的旧对话，不删本轮用户及工具协议。
  while (textSize(out) > maxChars) {
    const i = out.findIndex((m, i) => i > 0 && m._history && !m.tool_calls);
    if (i < 0) break;
    out.splice(i, 1);
  }
  if (textSize(out) > maxChars) throw new Error('本轮材料超过上下文预算，请拆分长资料');
  return out;
}
export function apiMessages(messages, maxChars) {
  return boundMessages(messages, maxChars).map(({ _history, ...m }) => m);
}
