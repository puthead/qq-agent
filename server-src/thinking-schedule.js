// 北京时间周一至周五09:00（含）—18:00（不含），不应用调休日历。
export function thinkingSchedule(now = Date.now()) {
  const local = new Date(Number(now) + 8 * 60 * 60 * 1000);
  const day = local.getUTCDay(), hour = local.getUTCHours();
  const workHours = day >= 1 && day <= 5 && hour >= 9 && hour < 18;
  return {timeZone:'Asia/Shanghai',workHours,scene:workHours?'low':'high'};
}
export function replyEffort(sceneEffort, now = Date.now()) {
  return thinkingSchedule(now).workHours ? 'low' : sceneEffort === 'low' ? 'low' : 'high';
}
