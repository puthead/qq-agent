/**
 * 机器人号段过滤 · 别一本正经接别的机器人的话
 * ─────────────────────────────────────────────────────────────
 * QQ 给官方机器人分配了固定号段（NapCat 的 get_robot_uin_range 能拿到）。
 * 落在号段里的发言一律不当成要回应的人：只归档备查，不学说话、不接话、不算群热闹。
 *
 * 拉取失败就先用空表（放行），过几分钟再试；接口本身只是查询，不写任何东西。
 */
export class RobotFilter {
  constructor({ bot = null, ttlMs = 24 * 3600e3, retryMs = 10 * 60000 } = {}) {
    this.bot = bot;
    this.ttlMs = Math.max(60000, Number(ttlMs) || 24 * 3600e3);
    this.retryMs = Math.max(30000, Number(retryMs) || 10 * 60000);
    /** @type {Array<[number, number]>} */
    this.ranges = [];
    this.fetchedAt = 0;
    this.nextTry = 0;
    this.pending = null;
  }

  /** 拉一次号段表；失败不抛，只延后重试 */
  async ensure() {
    if (!this.bot?.api) return this.ranges;
    if (Date.now() - this.fetchedAt < this.ttlMs) return this.ranges;
    if (Date.now() < this.nextTry) return this.ranges;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const r = await this.bot.api('get_robot_uin_range', {}, { timeoutMs: 10000 });
        const raw = r?.ok ? r.data?.data : null;
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.ranges) ? raw.ranges : [];
        const ranges = list
          .map((x) => [Number(x?.minUin), Number(x?.maxUin)])
          .filter(([a, b]) => Number.isFinite(a) && a > 0 && Number.isFinite(b) && b >= a);
        if (r?.ok) {
          this.ranges = ranges;
          this.fetchedAt = Date.now();
          console.log('[机器人] 号段表已更新：' + ranges.length + ' 段');
        } else {
          this.nextTry = Date.now() + this.retryMs;
          console.log('[机器人] 号段表拉取失败，先用空表放行（' + (r?.error || '无数据') + '）');
        }
      } catch (e) {
        this.nextTry = Date.now() + this.retryMs;
        console.log('[机器人] 号段表拉取出错：' + (e?.message || e));
      } finally {
        this.pending = null;
      }
      return this.ranges;
    })();
    return this.pending;
  }

  /** 同步判断；号段表还没拉到时返回 false（宁可不拦，不误拦真人） */
  isRobot(uin) {
    const n = Number(uin);
    if (!Number.isFinite(n) || n <= 0 || !this.ranges.length) return false;
    return this.ranges.some(([a, b]) => n >= a && n <= b);
  }
}

export default RobotFilter;
