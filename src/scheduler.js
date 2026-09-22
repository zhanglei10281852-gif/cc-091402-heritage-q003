// 周期调度：升级检查与到期通知发送。
// 关键的持久语义在引擎与存储层：截止时间(dueAt)落盘，进程重启后先立即执行一次追赶，
// 逾期通知仍按原截止时间判定与发送，lateMs 记录重启造成的延迟，而不是重置截止时间。
export class Scheduler {
  constructor(engine, { intervalMs = Number(process.env.CHECK_INTERVAL_MS ?? 15000) } = {}) {
    this.engine = engine;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    // 启动即追赶：把重启期间到期的升级与通知全部按原时间处理掉
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    if (this.running) return Promise.resolve();
    this.running = true;
    try {
      const result = this.engine.runScheduledChecks();
      return Promise.resolve(result);
    } catch (error) {
      console.error("定时检查失败：", error);
      return Promise.resolve({ error: error.message });
    } finally {
      this.running = false;
    }
  }
}
