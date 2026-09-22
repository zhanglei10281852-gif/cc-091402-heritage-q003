// 周期调度器。所有待办的截止时间都已经是绝对 epoch 毫秒并随状态落盘，
// 因此进程重启后不需要重新排程——下一次 tick 自然会把已过期的升级与未发送通知
// 按原截止时间补跑。tick 间隔只影响延迟，不影响正确性。
export class Scheduler {
  constructor(engine, { intervalMs, onError } = {}) {
    this.engine = engine;
    this.intervalMs = intervalMs;
    this.onError = onError ?? ((error) => console.error("定时检查失败", error));
    this.timer = null;
    this.running = false;
    this.lastTickAt = null;
    this.lastResult = null;
  }

  start() {
    if (this.timer) return;
    // 启动立即补跑一次：覆盖停机期间到期的所有升级与通知。
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async tick() {
    if (this.running) return this.lastResult;
    this.running = true;
    try {
      this.lastTickAt = this.engine.now();
      this.lastResult = await this.engine.runDueChecks(this.lastTickAt);
      return this.lastResult;
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
