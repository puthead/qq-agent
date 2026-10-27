// 群插话调度：忙时记录新一代消息，当前生成完成/取消/失败后重新评估。
export class GroupScheduler {
  constructor({ run, allowed = () => true, delayMs = 6000, maxWaitMs = 30000, onError = console.error }) {
    Object.assign(this, { run, allowed, delayMs, maxWaitMs, onError });
    this.pending = new Map();
    this.busy = new Set();
    this.dirty = new Set();
  }
  isBusy(key) { return this.busy.has(key); }
  schedule(key) {
    if (!this.allowed(key)) return;
    if (this.busy.has(key)) { this.dirty.add(key); return; }
    const old = this.pending.get(key);
    const firstAt = old?.firstAt ?? Date.now();
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.execute(key).catch(this.onError);
    }, Math.min(this.delayMs, Math.max(0, this.maxWaitMs - (Date.now() - firstAt))));
    timer.unref?.();
    this.pending.set(key, { timer, firstAt });
  }
  drop(key) {
    const old = this.pending.get(key);
    if (old) clearTimeout(old.timer);
    this.pending.delete(key);
    this.dirty.delete(key);
  }
  async execute(key) {
    if (this.busy.has(key)) { this.dirty.add(key); return; }
    this.busy.add(key);
    try { return await this.run(key); }
    finally {
      this.busy.delete(key);
      if (this.dirty.delete(key)) this.schedule(key);
    }
  }
}
