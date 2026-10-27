/**
 * 机器人自称
 * ─────────────────────────────────────────────────────────────
 * 日志、历史归档、群上下文里都需要一个「自己」的名字。
 * 启动时用 config.names[0] 设定；没配就用中性默认值，不绑定任何具体角色。
 */
const FALLBACK = '机器人';
let current = FALLBACK;

/** 设定自称（空值回落到默认） */
export function setSelfName(name) {
  const n = String(name ?? '').trim();
  current = n || FALLBACK;
  return current;
}

/** 当前自称 */
export function selfName() {
  return current;
}

/** 恢复默认（测试用） */
export function resetSelfName() {
  current = FALLBACK;
}

export default { setSelfName, selfName, resetSelfName };
