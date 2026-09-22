import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { buildServices } from "../src/bootstrap.js";

test("健康接口返回服务标识", async (context) => {
  const services = buildServices({ DATA_DIR: "/tmp/heritage-health-test" });
  const server = createApp(services);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "heritage-environment-monitor");
});
