import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, reading, MIN } from "./helpers.js";

const START = "2026-09-21T22:30:00+08:00";

test("连续越限超过去抖窗口后开告警，分区+指标去重，并合并多台设备", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());

  // 第一次越限：进入去抖，不发通知
  await h.ingestReading(reading({ id: "r-1", at: h.now, t: 24, h: 55 }));
  assert.equal(h.sentSms.length, 0);

  // 6 分钟后第二次越限：跨度 ≥ 5 分钟去抖，开告警
  h.advance(6 * MIN);
  const result = await h.ingestReading(reading({ id: "r-2", at: h.now, t: 24, h: 55 }));
  assert.equal(result.alerts.length, 1);
  const alert = result.alerts[0];
  assert.equal(alert.status, "open");
  assert.equal(alert.severity, "warn");
  assert.equal(alert.metric, "temperature");
  assert.equal(alert.zone, "A");

  // 同分区另一台设备的同类越限并入同一告警
  h.advance(MIN);
  await h.ingestReading(reading({ id: "r-3", sensor: "sensor-A-02", at: h.now, t: 24.5, h: 55 }));
  const risks = h.services.engine.openRisks();
  assert.equal(risks.length, 1);
  assert.deepEqual(risks[0].sensorIds.sort(), ["sensor-A-01", "sensor-A-02"]);
  assert.equal(risks[0].readingCount, 3);
});

test("设备时钟快 20 分钟在结果中明确标出（含校准基线对比）", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());

  // sensor-A-01 校准记录：出厂偏快 2 分钟（clockOffsetMs=120000），允差 3 分钟。
  // 设备时钟快 20 分钟，相对校准基线偏离 18 分钟，必须标 fast。
  await h.ingestReading(
    reading({ id: "c-1", at: h.now, deviceClockDeltaMs: 20 * 60_000, t: 24 }),
  );
  h.advance(6 * MIN);
  const result = await h.ingestReading(
    reading({ id: "c-2", at: h.now, deviceClockDeltaMs: 20 * 60_000, t: 24 }),
  );
  const warning = result.clockWarnings.find((w) => w.sensorId === "sensor-A-01");
  assert.ok(warning, "应返回时钟漂移预警");
  assert.equal(warning.status, "fast");
  assert.equal(warning.offsetMs, 20 * 60_000);
  assert.equal(warning.deviationMs, 18 * 60_000);
  assert.equal(warning.expectedClockOffsetMs, 2 * 60_000);

  const alert = result.alerts[0];
  const anomaly = alert.clockAnomalies.find((a) => a.sensorId === "sensor-A-01");
  assert.equal(anomaly.status, "fast");
  // 告警窗口时间仍以采集时间为准，未被设备时钟污染
  assert.equal(alert.window.firstExceedAt, new Date(Date.parse(START)).toISOString());
});

test("未校准设备的时钟漂移按默认允差判定并标记 uncalibrated", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());
  const result = await h.ingestReading(
    reading({ id: "u-1", sensor: "sensor-C-01", at: h.now, deviceClockDeltaMs: 5 * 60_000, t: 25 }),
  );
  const warning = result.clockWarnings[0];
  assert.equal(warning.status, "fast");
  assert.equal(warning.uncalibrated, true);
  assert.equal(warning.toleranceMs, 120_000);
});

test("网络恢复后批量补传：重复读数幂等忽略，不重放通知", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());

  // 实时阶段已开告警并发过 opened 通知
  await h.ingestReading(reading({ id: "live-1", at: h.now, t: 24 }));
  h.advance(6 * MIN);
  await h.ingestReading(reading({ id: "live-2", at: h.now, t: 24 }));
  await h.tick();
  const openedSmsCount = h.sentSms.length;
  assert.ok(openedSmsCount >= 1);

  // 网络断开期间的旧读数补传：并入现有告警，不产生新的 opened 通知
  h.advance(3 * MIN);
  const backfill = [
    reading({ id: "bf-1", at: Date.parse(START) + 2 * MIN, t: 23.8 }),
    reading({ id: "bf-2", at: Date.parse(START) + 4 * MIN, t: 23.9 }),
  ];
  await h.ingestBatch(backfill);
  await h.tick();
  const alerts = h.services.engine.listAlerts({ status: "active" });
  assert.equal(alerts.length, 1);
  assert.equal(h.sentSms.length, openedSmsCount, "旧读数补传不得重放开告警通知");

  // 同一批次再次补传（网关重发）：全部幂等
  const retry = await h.ingestBatch(backfill);
  assert.equal(retry.acceptedCount, 0);
  assert.equal(retry.duplicates.length, 2);
  await h.tick();
  assert.equal(h.sentSms.length, openedSmsCount);
});

test("告警原始数据在整个告警期间保留（含越限与恢复读数）", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());
  await h.ingestReading(reading({ id: "p-1", at: h.now, t: 24 }));
  h.advance(6 * MIN);
  await h.ingestReading(reading({ id: "p-2", at: h.now, t: 24 }));
  h.advance(2 * MIN);
  await h.ingestReading(reading({ id: "p-3", at: h.now, t: 20 })); // 恢复
  const detail = h.services.engine.alertDetail(h.services.engine.state.alerts[0].id);
  assert.deepEqual(detail.readings.map((r) => r.readingId), ["p-1", "p-2", "p-3"]);
  assert.equal(detail.readings[2].value, 20);
});

test("整段越限窗口都由历史补传还原：告警照开但不重放开告警通知", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());

  // 当前时刻 22:46，一次性补传 22:30 和 22:36 两次越限（均迟到超过去抖窗口）
  h.advance(16 * MIN);
  const result = await h.ingestBatch([
    reading({ id: "old-1", at: Date.parse(START), t: 24 }),
    reading({ id: "old-2", at: Date.parse(START) + 6 * MIN, t: 24 }),
  ]);
  assert.equal(result.alerts.length, 1, "补传还原的风险仍应在系统中可见");
  assert.equal(result.alerts[0].window.firstExceedAt, new Date(Date.parse(START)).toISOString());
  await h.tick();
  assert.equal(h.sentSms.length, 0, "历史窗口不得补放 opened 短信");

  // 补传之后若有实时新越限并入，才发送升级/持续类通知
  const before = h.sentSms.length;
  await h.ingestReading(reading({ id: "now-1", at: h.now, t: 27 })); // critical 带
  await h.tick();
  assert.ok(h.sentSms.length > before, "实时 critical 升级应发送短信");
});
