// 服务装配：加载参考数据、持久化状态、引擎、发送器与调度器。
// 测试通过参数注入虚拟时钟、内存数据目录与假发送器。
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { AlertEngine } from "./engine.js";
import { Scheduler } from "./scheduler.js";
import { ConsoleSmsSender } from "./sms.js";

export function buildServices(env = process.env, { clock, sender } = {}) {
  const config = loadConfig(env);
  const store = new Store(config.dataDir);
  store.load();
  config.sender = sender ?? new ConsoleSmsSender();
  const engine = new AlertEngine({ store, config, clock });
  const scheduler = new Scheduler(engine, { intervalMs: config.alerting.checkIntervalMs });
  return { config, store, engine, scheduler, sender: config.sender };
}
