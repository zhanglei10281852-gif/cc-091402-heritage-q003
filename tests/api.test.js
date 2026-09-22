import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, reading, startHttp, MIN } from "./helpers.js";

async function jsonPost(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

test("端到端：批量入库 → 风险列表 → 确认/复测/关闭 → 通知查询", async (t) => {
  const h = makeHarness("2026-09-21T22:30:00+08:00");
  t.after(() => h.cleanup());
  const http = await startHttp(h.services);
  t.after(http.close);
  const base = http.base;

  // 批量补传（含设备时钟快 20 分钟的读数）
  h.advance(6 * MIN);
  const batch = {
    readings: [
      reading({ id: "e-2", at: h.now, deviceClockDeltaMs: 20 * 60_000, t: 24 }),
      reading({ id: "e-1", at: h.now - 6 * MIN, t: 24 }),
    ],
  };
  let res = await jsonPost(base, "/readings", batch);
  assert.equal(res.status, 202);
  assert.equal(res.json.acceptedCount, 2);
  assert.equal(res.json.clockWarnings.find((w) => w.status === "fast").sensorId, "sensor-A-01");
  const alertId = res.json.alerts[0].id;

  // 当前未闭环风险
  res = await fetch(base + "/risks").then((r) => r.json());
  assert.equal(res.risks.length, 1);
  assert.equal(res.risks[0].clockAnomalies[0].deviationMs, 18 * 60_000);

  // 通知已生成（opened）
  await jsonPost(base, "/maintenance/tick", {});
  res = await fetch(base + "/notifications").then((r) => r.json());
  assert.ok(res.notifications.some((n) => n.kind === "opened"));

  // 确认
  res = await jsonPost(base, `/alerts/${alertId}/acknowledge`, { operator: "周敏" });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "acknowledged");

  // 转派
  res = await jsonPost(base, `/alerts/${alertId}/assign`, {
    operator: "周敏",
    toContactId: "contact-conservator",
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.assignee, "contact-conservator");

  // 现场复测（合规）
  res = await jsonPost(base, `/alerts/${alertId}/recheck`, {
    operator: "周敏",
    measuredAt: new Date(h.now).toISOString(),
    measurements: { temperature: 20.0, humidity: 55 },
    method: "手持标准温湿度计",
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.rechecks[0].conforming, true);

  // 关闭
  res = await jsonPost(base, `/alerts/${alertId}/close`, {
    operator: "周敏",
    resolution: "resolved",
    note: "设备空调恢复",
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "closed");

  // 告警详情含复测证据、升级原因、全部原始读数
  const detail = await fetch(base + `/alerts/${alertId}`).then((r) => r.json());
  assert.equal(detail.readings.length, 2);
  assert.equal(detail.rechecks.length, 1);
  assert.equal(detail.rechecks[0].measurements.temperature.value, 20);

  // 风险列表清空
  res = await fetch(base + "/risks").then((r) => r.json());
  assert.equal(res.risks.length, 0);
});

test("错误请求返回结构化错误", async (t) => {
  const h = makeHarness("2026-09-21T22:30:00+08:00");
  t.after(() => h.cleanup());
  const http = await startHttp(h.services);
  t.after(http.close);

  let res = await jsonPost(http.base, "/readings", { readings: [] });
  assert.equal(res.status, 400);

  res = await jsonPost(http.base, "/readings", {
    readings: [reading({ id: "x-1", at: h.now, sensor: "unknown", t: 24 })],
  });
  assert.equal(res.status, 202);
  assert.equal(res.json.acceptedCount, 0);
  assert.match(res.json.rejected[0].reason, /未知传感器/);

  res = await jsonPost(http.base, "/alerts/alr-999999/close", {});
  assert.equal(res.status, 404);

  const response = await fetch(http.base + "/nope");
  assert.equal(response.status, 404);
});
