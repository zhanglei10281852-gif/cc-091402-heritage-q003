import { buildServices } from "./bootstrap.js";
import { createApp } from "./app.js";

const services = buildServices();
const server = createApp(services);

server.listen(services.config.httpPort, services.config.httpHost, () => {
  console.log(
    `文物库房环境监测服务已启动: http://${services.config.httpHost}:${services.config.httpPort}`,
  );
});

services.scheduler.start();

const shutdown = () => {
  services.scheduler.stop();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
