import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, MIN, reading } from "./helpers.js";

const T0 = Date.parse("2026-09-22T10:00:00+08:00");

test("同分区同敏感等级的多设备越限去重为一条告警", () => {
  const h = makeHarness();
  h.clock.set(T0);

  const r1 = h.engine.ingestReading(reading({ deviceId: "sensor-shuhua-01", at: T0, temperature: 25, humidity: 70 }));
  assert.equal(r1.alert.status, "open");
  const alertId = r1.alert.id;

  // 同分区同敏感等级另一台设备 2 分钟后越限：挂接同一条告警，不再开新窗
  h.clock.set(T0 + 2 * MIN);
  const r2 = h.engine.ingestReading(reading({ deviceId: "sensor-shuhua-02", at: T0 + 2 * MIN, temperature: 26 }));
  assert.equal(r2.alert.id, alertId);
  assert.equal(r2.alert.readingIds.length, 2);
  assert.deepEqual(r2.alert.deviceIds.sort(), ["sensor-shuhua-01", "sensor-shuhua-02"]);
  assert.equal(r2.alert.escalations.length, 1, "首次升级不重复");

  // 不同分区另开告警
  h.clock.set(T0 + 3 * MIN);
  const r3 = h.engine.ingestReading(reading({ deviceId: "sensor-ciqi-01", at: T0 + 3 * MIN, temperature: 30 }));
  assert.notEqual(r3.alert.id, alertId);

  // 越限期间恢复到阈值内：读数仍挂接到原告警，标记 recoveredSince，告警不自动关闭
  h.clock.set(T0 + 4 * MIN);
  const r4 = h.engine.ingestReading(
    reading({ deviceId: "sensor-shuhua-01", at: T0 + 4 * MIN, temperature: 18, humidity: 55 }),
  );
  assert.equal(r4.alert.id, alertId);
  assert.equal(r4.alert.readingIds.length, 3);
  assert.equal(r4.alert.recoveredSince, T0 + 4 * MIN);
  assert.equal(r4.alert.status, "open");

  const active = h.store.listAlerts().filter((a) => a.status !== "closed");
  assert.equal(active.length, 2);
  // 仅两条 L1 实时通知（去重没有产生第二条）
  assert.equal(h.messages.length, 2);
});

test("临界越限标 warning，超出临界余量标 critical", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { reading: r } = h.engine.ingestReading(
    reading({ at: T0, temperature: 21, humidity: 62 }), // 温度21>20 但 <22；湿度 62>60 但 <65
  );
  const byMetric = Object.fromEntries(r.violations.map((v) => [v.metric, v]));
  assert.equal(byMetric.temperature.severity, "warning");
  assert.equal(byMetric.humidity.severity, "warning");

  const h2 = makeHarness();
  h2.clock.set(T0);
  const { reading: r2 } = h2.engine.ingestReading(
    reading({ at: T0, temperature: 22.5, humidity: 66 }),
  );
  const crit = Object.fromEntries(r2.violations.map((v) => [v.metric, v]));
  assert.equal(crit.temperature.severity, "critical");
  assert.equal(crit.humidity.severity, "critical");
});

test("校准修正后越限同样告警，原始值与修正值都保留", () => {
  const h = makeHarness();
  h.clock.set(T0);
  // sensor-shuhua-01 温度修正 +0.2：原始 19.9 在 14-20 内，修正后 20.1 越上限
  const { reading: r } = h.engine.ingestReading(
    reading({ at: T0, temperature: 19.9, humidity: 55 }),
  );
  assert.equal(r.calibrationId, "cal-2026-0001");
  assert.equal(r.corrected.temperature, 20.1);
  assert.equal(r.violations[0].metric, "temperature");
  assert.equal(r.violations[0].rawValue, 19.9);
  assert.equal(r.violations[0].value, 20.1);
});

test("校准超期在读数上标出但不阻断判定", () => {
  const h = makeHarness();
  h.clock.set(T0);
  // sensor-shuhua-02 上次校准 2025-11-10，间隔 180 天，2026-09 已超期
  const { reading: r } = h.engine.ingestReading(
    reading({ deviceId: "sensor-shuhua-02", at: T0, temperature: 25 }),
  );
  assert.equal(r.calibrationOverdue, true);
});

test("告警关闭后原始读数与证据仍可查", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { alert } = h.engine.ingestReading(reading({ at: T0, temperature: 25 }));
  h.clock.set(T0 + 5 * MIN);
  h.engine.ingestReading(reading({ at: T0 + 5 * MIN, temperature: 19, humidity: 55 }));
  h.engine.addRecheck(alert.id, { by: "周", result: "pass", temperature: 19, humidity: 55 });
  h.engine.close(alert.id, { by: "周", reason: "现场复测合格" });

  const stored = h.store.getAlert(alert.id);
  assert.equal(stored.status, "closed");
  assert.equal(stored.closedWithoutRecheck, false);
  assert.equal(stored.readingIds.length, 2);
  const retained = stored.readingIds.map((id) => h.store.readings.get(id));
  assert.ok(retained.every(Boolean));
  assert.equal(retained[0].metrics.temperature, 25);
});
