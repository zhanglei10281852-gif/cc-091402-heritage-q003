import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, reading, MIN } from "./helpers.js";

const START = "2026-09-21T22:30:00+08:00";

async function openWarnAlert(h, { sensor = "sensor-A-01", t = 24 } = {}) {
  await h.ingestReading(reading({ id: `${sensor}-open-1`, sensor, at: h.now, t }));
  h.advance(6 * MIN);
  await h.ingestReading(reading({ id: `${sensor}-open-2`, sensor, at: h.now, t }));
  await h.tick();
  return h.services.engine.state.alerts.at(-1);
}

test("值守员确认后超时未复测会升级，每次升级原因与截止时间可查", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());
  const alert = await openWarnAlert(h);

  await h.services.engine.acknowledge(alert.id, { operator: "周敏", note: "已收到短信" });
  h.sentSms.length = 0;

  // 高敏感分区确认后 10 分钟未复测 -> 升级
  h.advance(10 * MIN + 1_000);
  const result = await h.tick();
  assert.equal(result.escalations.length, 1);
  assert.equal(result.escalations[0].from, "warn");
  assert.equal(result.escalations[0].to, "critical");
  assert.match(result.escalations[0].reason, /未提交现场复测/);

  const view = h.services.engine.alertDetail(alert.id);
  assert.equal(view.escalations.length, 1);
  assert.equal(view.escalations[0].reason.includes("未提交现场复测"), true);
  assert.ok(view.escalations[0].deadline);
});

test("无人确认超时自动升级（critical 分区用更短截止时间）", async (t) => {
  const h = makeHarness("2026-09-21T10:00:00+08:00");
  t.after(() => h.cleanup());
  // C 区为 critical 敏感等级，确认超时 5 分钟
  await h.ingestReading(reading({ id: "c-open-1", sensor: "sensor-C-01", at: h.now, t: 23 }));
  h.advance(6 * MIN);
  await h.ingestReading(reading({ id: "c-open-2", sensor: "sensor-C-01", at: h.now, t: 23 }));
  await h.tick();
  h.sentSms.length = 0;

  h.advance(5 * MIN + 1_000);
  const result = await h.tick();
  assert.equal(result.escalations.length, 1);
  assert.match(result.escalations[0].reason, /无人确认/);
});

test("现场复测合规才能 resolved 关闭；复测证据保留", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());
  const alert = await openWarnAlert(h);

  // 未复测直接 resolved 关闭：拒绝
  await assert.rejects(
    () => h.services.engine.close(alert.id, { operator: "周敏", resolution: "resolved" }),
    /需要先提交现场复测/,
  );

  // 复测仍越限：状态进入 recheck，等级可升高，记录证据
  await h.services.engine.submitRecheck(alert.id, {
    operator: "周敏",
    measuredAt: new Date(h.now).toISOString(),
    measurements: { temperature: 26.5 },
    method: "校准过的手持温湿度计",
  });
  let view = h.services.engine.alertDetail(alert.id);
  assert.equal(view.status, "recheck");
  assert.equal(view.rechecks.length, 1);
  assert.equal(view.rechecks[0].conforming, false);
  assert.equal(view.severity, "critical");

  // 第二次复测合规并关闭
  h.advance(MIN);
  await h.services.engine.submitRecheck(alert.id, {
    operator: "周敏",
    measuredAt: new Date(h.now).toISOString(),
    measurements: { temperature: 20.2, humidity: 55 },
    method: "校准过的手持温湿度计",
  });
  const closed = await h.services.engine.close(alert.id, {
    operator: "周敏",
    resolution: "resolved",
    note: "空调重启后恢复",
  });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closure.resolution, "resolved");
  view = h.services.engine.alertDetail(alert.id);
  assert.equal(view.rechecks[0].measurements.temperature.value, 26.5);
  assert.equal(view.readings.length + view.rechecks.length >= 3, true);
  // 关闭后不再出现在未闭环风险中
  assert.equal(h.services.engine.openRisks().length, 0);
});

test("转派给非本分区联系人被拒绝；合法转派通知新经办人", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());
  const alert = await openWarnAlert(h);
  h.sentSms.length = 0;

  await assert.rejects(
    () => h.services.engine.assign(alert.id, { operator: "周敏", toContactId: "contact-registrar" }),
    /不负责分区/,
  );

  await h.services.engine.assign(alert.id, {
    operator: "周敏",
    toContactId: "contact-conservator",
    note: "需要书画修复师判断",
  });
  await h.tick();
  assert.ok(h.sentSms.some((s) => s.target === "+8613800000002"));
  const view = h.services.engine.alertDetail(alert.id);
  assert.equal(view.assignee, "contact-conservator");
  assert.equal(view.status, "acknowledged");
});

test("复测合规后超过闭环时限未关闭会升级，原因记录为 recheck_timeout", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());
  const alert = await openWarnAlert(h);
  await h.services.engine.acknowledge(alert.id, { operator: "周敏" });
  await h.services.engine.submitRecheck(alert.id, {
    operator: "周敏",
    measuredAt: new Date(h.now).toISOString(),
    measurements: { temperature: 20.0, humidity: 55 },
  });
  h.sentSms.length = 0;

  // 复测后 15 分钟闭环时限
  h.advance(15 * MIN + 1_000);
  const result = await h.tick();
  assert.equal(result.escalations.length, 1);
  assert.equal(result.escalations[0].trigger ?? alert.escalations.at(-1).trigger, "recheck_timeout");
  const view = h.services.engine.alertDetail(alert.id);
  assert.equal(view.escalations.at(-1).trigger, "recheck_timeout");
  assert.ok(view.escalations.at(-1).evidenceId);
});

test("连续两次超时升级：critical 与 emergency 的通知都会发出（不被去重吞掉）", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());
  const alert = await openWarnAlert(h);
  h.sentSms.length = 0;

  // warn 状态 10 分钟无人确认 -> critical
  h.advance(10 * MIN + 1_000);
  let result = await h.tick();
  assert.equal(result.escalations[0].to, "critical");
  const criticalSms = h.sentSms.length;
  assert.ok(criticalSms > 0);

  // 继续无人确认，再过 10 分钟 -> emergency
  h.advance(10 * MIN + 1_000);
  result = await h.tick();
  assert.equal(result.escalations[0].to, "emergency");
  assert.ok(h.sentSms.length > criticalSms, "第二次升级必须再次发送短信");

  const view = h.services.engine.alertDetail(alert.id);
  assert.equal(view.escalations.length, 2);
});
