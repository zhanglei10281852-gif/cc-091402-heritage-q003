import assert from "node:assert/strict";
import test from "node:test";
import { MIN, reading, startHttpApp } from "./helpers.js";

const T0 = Date.parse("2026-09-22T10:00:00+08:00");

test("完整处置链路通过 HTTP 完成：上报→未闭环风险→确认→复测→关闭", async () => {
  const app = await startHttpApp();
  app.clock.set(T0);

  const posted = await app.request("POST", "/api/v1/readings", reading({ at: T0, temperature: 25, humidity: 70 }));
  assert.equal(posted.status, 202);
  assert.equal(posted.body.alert.status, "open");
  assert.equal(posted.body.clockDriftFlagged, false);
  const alertId = posted.body.alert.id;

  const risks = await app.request("GET", "/api/v1/risks");
  assert.equal(risks.status, 200);
  assert.equal(risks.body.count, 1);
  assert.equal(risks.body.alerts[0].id, alertId);
  assert.equal(risks.body.alerts[0].escalations[0].reason, "传感器读数首次越限");

  const ack = await app.request("POST", `/api/v1/alerts/${alertId}/acknowledge`, { by: "赵" });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.status, "acknowledged");

  const assign = await app.request("POST", `/api/v1/alerts/${alertId}/assign`, {
    by: "赵",
    toRole: "值班主管",
    toPerson: "周",
    note: "未见好转",
  });
  assert.equal(assign.status, 200);
  assert.equal(assign.body.assignee.role, "值班主管");

  const recheck = await app.request("POST", `/api/v1/alerts/${alertId}/rechecks`, {
    by: "赵",
    result: "pass",
    temperature: 18,
    humidity: 55,
    note: "现场恢复",
  });
  assert.equal(recheck.status, 200);
  assert.equal(recheck.body.rechecks[0].result, "pass");

  const closed = await app.request("POST", `/api/v1/alerts/${alertId}/close`, {
    by: "周",
    reason: "复测合格关闭",
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, "closed");

  const risksAfter = await app.request("GET", "/api/v1/risks");
  assert.equal(risksAfter.body.count, 0);

  // 告警详情仍保留原始读数
  const detail = await app.request("GET", `/api/v1/alerts/${alertId}`);
  assert.equal(detail.body.readings.length, 1);
  assert.equal(detail.body.readings[0].metrics.temperature, 25);
});

test("设备时钟快20分钟的读数在 API 响应中明确标出漂移", async () => {
  const app = await startHttpApp();
  app.clock.set(T0);
  const res = await app.request("POST", "/api/v1/readings", reading({
    at: T0,
    deviceAt: T0 + 20 * MIN,
    temperature: 30,
  }));
  assert.equal(res.status, 202);
  assert.equal(res.body.clockDriftFlagged, true);
  assert.equal(res.body.reading.skewSeconds, -1200);
  assert.equal(res.body.alert.clockDrift.detected, true);
  assert.ok(res.body.alert.clockDrift.devices["sensor-shuhua-01"]);
});

test("未知设备与非法字段返回 4xx", async () => {
  const app = await startHttpApp();
  const bad = await app.request("POST", "/api/v1/readings", { deviceId: "nope", collectedAt: new Date().toISOString(), deviceTime: new Date().toISOString() });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad_request");

  const missing = await app.request("POST", "/api/v1/readings", { deviceId: "sensor-ciqi-01" });
  assert.equal(missing.status, 400);
});

test("批量补传返回零发送且可查询抑制记录", async () => {
  const app = await startHttpApp();
  app.clock.set(T0);
  const res = await app.request("POST", "/api/v1/readings/batch", [
    reading({ deviceId: "sensor-ciqi-01", at: T0 - 40 * MIN, temperature: 30, batch: true }),
    reading({ deviceId: "sensor-ciqi-01", at: T0 - 10 * MIN, temperature: 31, batch: true }),
  ]);
  assert.equal(res.status, 202);
  assert.equal(res.body.notificationsSent, 0);

  const notes = await app.request("GET", "/api/v1/notifications?status=suppressed");
  assert.ok(notes.body.count >= 1);
  assert.ok(notes.body.notifications.every((n) => n.suppressedReason === "backfill_no_replay"));
});

test("手动触发定时检查的接口可用", async () => {
  const app = await startHttpApp();
  app.clock.set(T0);
  await app.request("POST", "/api/v1/readings", reading({ at: T0, temperature: 25, humidity: 70 }));
  app.clock.set(T0 + 16 * MIN);
  const check = await app.request("POST", "/api/v1/checks/run", {});
  assert.equal(check.status, 200);
  const risks = await app.request("GET", "/api/v1/risks");
  assert.equal(risks.body.alerts[0].level, 2);
});
