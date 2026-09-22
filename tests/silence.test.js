import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, reading, MIN } from "./helpers.js";

test("静默时段内开告警：告警立即生成，短信延后到静默结束，不重复发送", async (t) => {
  // C 区静默窗 23:00–06:00（跨午夜）
  const h = makeHarness("2026-09-21T23:10:00+08:00");
  t.after(() => h.cleanup());

  await h.ingestReading(reading({ id: "s-1", sensor: "sensor-C-01", at: h.now, t: 23 }));
  h.advance(6 * MIN);
  const result = await h.ingestReading(reading({ id: "s-2", sensor: "sensor-C-01", at: h.now, t: 23 }));
  assert.equal(result.alerts.length, 1, "静默不阻断告警生成");

  await h.tick();
  assert.equal(h.sentSms.length, 0, "静默窗内不发送短信");
  const pending = h.services.engine.state.notifications;
  assert.equal(pending.every((n) => n.deferredBySilence), true);
  // 延后截止时间为次日 06:00（+08:00）= 前一日 22:00 UTC
  assert.equal(new Date(pending[0].notBeforeMs).toISOString(), "2026-09-21T22:00:00.000Z");

  // 跨过 06:00 后 tick：全部到期通知发送，且跨午夜窗口没有截断告警窗口
  h.setNow("2026-09-22T06:00:30+08:00");
  const tickResult = await h.tick();
  assert.equal(tickResult.notifications.length, pending.length);
  assert.equal(h.sentSms.length, pending.length);

  // 再 tick 不重复发送
  h.advance(MIN);
  await h.tick();
  assert.equal(h.sentSms.length, pending.length);

  const view = h.services.engine.alertDetail(result.alerts[0].id);
  assert.equal(view.window.firstExceedAt, "2026-09-21T15:10:00.000Z");
});

test("跨午夜告警窗口完整：23:50 首越限、00:30 仍越限属于同一告警", async (t) => {
  const h = makeHarness("2026-09-21T23:50:00+08:00");
  t.after(() => h.cleanup());
  await h.ingestReading(reading({ id: "m-1", at: h.now, t: 24 }));
  h.setNow("2026-09-22T00:30:00+08:00");
  const result = await h.ingestReading(reading({ id: "m-2", at: h.now, t: 24 }));
  assert.equal(result.alerts.length, 1);
  const view = result.alerts[0];
  assert.equal(view.window.firstExceedAt, "2026-09-21T15:50:00.000Z");
  assert.equal(view.window.lastExceedAt, "2026-09-21T16:30:00.000Z");
});

test("非静默时段通知即时发送并按值班表优先匹配联系人", async (t) => {
  // 周一凌晨：night-lead 的 nights 含周一(1)，其跨午夜班次覆盖凌晨
  const h = makeHarness("2026-09-22T02:00:00+08:00");
  t.after(() => h.cleanup());
  await h.ingestReading(reading({ id: "d-1", at: h.now, t: 24 }));
  h.advance(6 * MIN);
  await h.ingestReading(reading({ id: "d-2", at: h.now, t: 24 }));
  await h.tick();
  const targets = new Set(h.sentSms.map((s) => s.target));
  assert.ok(targets.has("+8613800000001"), "夜间值守长应收到通知");
  assert.ok(targets.has("+8613800000002"), "A 区保护人员应收到通知");
});
