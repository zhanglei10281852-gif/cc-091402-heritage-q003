import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, MIN, reading } from "./helpers.js";

const T0 = Date.parse("2026-09-22T03:00:00+08:00");

test("设备时钟快20分钟：读数明确标出漂移，告警窗口以采集时间为准", () => {
  const h = makeHarness();
  h.clock.set(T0);
  // 设备时间 03:20，网关采集戳 03:00 -> skew = -20 分钟
  const r = h.engine.ingestReading(
    reading({ deviceId: "sensor-ciqi-01", at: T0, deviceAt: T0 + 20 * MIN, temperature: 30 }),
  );
  assert.equal(r.reading.skewMs, -20 * MIN);
  assert.equal(r.reading.skewSeconds ?? Math.round(r.reading.skewMs / 1000), -1200);
  assert.equal(r.reading.flaggedClockDrift, true);

  // 开窗时间采用采集时间 03:00，而不是设备自报的 03:20
  assert.equal(r.alert.openedAt, T0);
  assert.equal(r.alert.clockDrift.detected, true);
  assert.equal(r.alert.clockDrift.devices["sensor-ciqi-01"].maxAbsSkewMs, 20 * MIN);

  // 通知文案必须提示时钟漂移、以采集时间为准
  assert.match(h.messages[0].text, /时钟漂移/);
  assert.match(h.messages[0].text, /采集时间为准/);
});

test("设备时钟慢20分钟同样标记为漂移", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { reading: r } = h.engine.ingestReading(
    reading({ deviceId: "sensor-ciqi-01", at: T0, deviceAt: T0 - 20 * MIN, temperature: 30 }),
  );
  assert.equal(r.skewMs, 20 * MIN);
  assert.equal(r.flaggedClockDrift, true);
});

test("补传按采集时间排序，时钟快的设备不会抢占真实开窗顺序", () => {
  const h = makeHarness();
  // 断网恢复时刻 04:00，批量补传两台设备：
  // A 时钟快 20 分钟，实际采集于 03:10；B 采集于 03:05、时钟准确。
  h.clock.set(Date.parse("2026-09-22T04:00:00+08:00"));
  const batch = [
    reading({ deviceId: "sensor-ciqi-01", at: T0 + 10 * MIN, deviceAt: T0 + 30 * MIN, temperature: 30, batch: true }),
    reading({ deviceId: "sensor-ciqi-01", at: T0 + 35 * MIN, deviceAt: T0 + 55 * MIN, temperature: 31, batch: true }),
    reading({ deviceId: "sensor-shuhua-02", at: T0 + 5 * MIN, temperature: 25, batch: true }),
  ];
  // 故意把时钟快的 A 放在数组前面
  const result = h.engine.ingestBatch(batch);
  assert.equal(result.notificationsSent, 0, "补传不发送任何通知");

  // 书画分区告警开窗于 03:05（B 的真实采集时间），不受 A 自报 03:30 影响
  const shuhua = h.store.listAlerts().find((a) => a.zoneId === "zone-shuhua-1");
  assert.equal(shuhua.openedAt, T0 + 5 * MIN);
  const ciqi = h.store.listAlerts().find((a) => a.zoneId === "zone-ciqi");
  assert.equal(ciqi.openedAt, T0 + 10 * MIN);
  assert.equal(ciqi.clockDrift.detected, true);

  // 升级截止时间也以采集时间为锚：补传到 04:00 时，瓷器告警（03:10 开窗，20 分钟升级）
  // 应已登记 L2，但通知被抑制
  const ciqiNotes = h.store.listNotifications().filter((n) => n.alertId === ciqi.id);
  assert.ok(ciqiNotes.some((n) => n.level === 2 && n.status === "suppressed"));
  const l2 = ciqi.escalations.find((e) => e.level === 2);
  assert.equal(l2.at, T0 + 30 * MIN);
});

test("漂移未超过阈值不标记", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { reading: r } = h.engine.ingestReading(
    reading({ deviceId: "sensor-ciqi-01", at: T0, deviceAt: T0 + 60_000, temperature: 30 }),
  );
  assert.equal(r.flaggedClockDrift, false);
});
