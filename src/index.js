import { createApp } from "./app.js";
import { Scheduler } from "./scheduler.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const { server, engine } = createApp();
const scheduler = new Scheduler(engine, {
  intervalMs: Number.parseInt(process.env.CHECK_INTERVAL_MS ?? "15000", 10),
});
scheduler.start();

server.listen(port, host, () => console.log(`文物环境监测服务已启动，监听 ${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    scheduler.stop();
    server.close(() => process.exit(0));
  });
}
