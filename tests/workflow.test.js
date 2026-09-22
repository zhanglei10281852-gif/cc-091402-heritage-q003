import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, MIN, reading } from "./helpers.js";

const T0 = Date.parse("2026-09-22T10:00:00+08:00");

function activeBreach(h, deviceId = "sensor-shuhua-01", at = T0, extra = {}) {
  return h.engine.ingestReading(
    reading({ deviceId, at, temperature: 25, humidity: 70, ...extra }),
  );
}

test("持续越限按15/30分钟升级，每级留原因并通知对应角色", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { alert } = activeBreach(h);

  h.clock.set(T0 + 10 * MIN);
  activeBreach(h, "sensor-shuhua-01", T0 + 10 * MIN);
  h.engine.runScheduledChecks(T0 + 10 * MIN);
  assert.equal(alert.level, 1);

  h.clock.set(T0 + 15 * MIN);
  activeBreach(h, "sensor-shuhua-01", T0 + 15 * MIN);
  assert.equal(alert.level, 2, "第15分钟读数触发L2");
  assert.equal(alert.escalations.at(-1).reason, "越限持续15分钟未确认");
  assert.equal(alert.escalations.at(-1).cause, "duration");

  h.clock.set(T0 + 30 * MIN);
  activeBreach(h, "sensor-shuhua-01", T0 + 30 * MIN);
  assert.equal(alert.level, 3);
  assert.match(alert.escalations.at(-1).reason, /30分钟/);

  const levels = h.messages.map((m) => m.notification.level);
  assert.deepEqual(levels, [1, 2, 3]);
  assert.deepEqual(
    h.messages[2].contacts.map((c) => c.id).sort(),
    ["contact-head-01"],
  );
});

test("定时检查即使没有新读数也能在墙钟到期时升级（跨午夜窗口不截断）", () => {
  const h = makeHarness();
  // 23:50 开窗，L3 截止于次日 00:20
  const openAt = Date.parse("2026-09-22T23:50:00+08:00");
  h.clock.set(openAt);
  const { alert } = activeBreach(h, "sensor-ciqi-01", openAt); // 瓷器 20/40 分钟升级

  h.clock.set(openAt + 25 * MIN); // 次日 00:15
  h.engine.runScheduledChecks();
  assert.equal(alert.level, 2);

  h.clock.set(openAt + 45 * MIN); // 次日 00:35
  h.engine.runScheduledChecks();
  assert.equal(alert.level, 3);
  // 告警仍是同一条，窗口跨过午夜
  assert.equal(h.store.listAlerts().length, 1);
  assert.equal(alert.openedAt, openAt);
});

test("确认后暂停时间升级；复测失败立即再升级并附证据", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { alert } = activeBreach(h);

  h.clock.set(T0 + 5 * MIN);
  h.engine.acknowledge(alert.id, "赵");
  assert.equal(alert.status, "acknowledged");

  h.clock.set(T0 + 40 * MIN);
  activeBreach(h, "sensor-shuhua-01", T0 + 40 * MIN);
  h.engine.runScheduledChecks();
  assert.equal(alert.level, 1, "确认后不因时间升级");

  // 现场复测：先一次合格证据
  h.engine.addRecheck(alert.id, { by: "赵", result: "pass", temperature: 18, humidity: 55, note: "空调已启动" });
  assert.equal(alert.latestRecheckResult, "pass");

  // 但传感器继续越限，值守员再到现场复测失败
  h.clock.set(T0 + 50 * MIN);
  h.engine.addRecheck(alert.id, {
    by: "赵",
    result: "fail",
    temperature: 24,
    humidity: 68,
    note: "靠近展柜一侧仍超温",
  });
  assert.equal(alert.latestRecheckResult, "fail");
  assert.equal(alert.status, "open", "复测失败打破确认锁定");
  assert.equal(alert.level, 2, "复测失败立即升级");
  assert.equal(alert.escalations.at(-1).cause, "recheck_failed");
  assert.match(alert.escalations.at(-1).reason, /现场复测仍不合格/);
});

test("复测不合格时禁止直接关闭，除非显式 force", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { alert } = activeBreach(h);
  h.engine.addRecheck(alert.id, { by: "赵", result: "fail", temperature: 25, humidity: 70 });

  assert.throws(
    () => h.engine.close(alert.id, { by: "吴", reason: "先关了再说" }),
    /复测仍不合格/,
  );
  const forced = h.engine.close(alert.id, { by: "吴", reason: "设备故障已报修，按异常流程强制关闭", force: true });
  assert.equal(forced.status, "closed");
  assert.equal(forced.closedWithoutRecheck, true, "没有合格复测记录要明确标注");
});

test("复测合格后关闭并撤销未发送通知", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { alert } = activeBreach(h);
  h.clock.set(T0 + 5 * MIN);
  h.engine.addRecheck(alert.id, { by: "赵", result: "pass", temperature: 18, humidity: 55 });
  h.engine.close(alert.id, { by: "赵", reason: "复测合格，空调恢复正常" });

  assert.equal(alert.status, "closed");
  assert.equal(alert.closedWithoutRecheck, false);
  for (const n of h.store.listNotifications().filter((n) => n.alertId === alert.id)) {
    assert.ok(n.status === "sent" || n.status === "cancelled");
  }
});

test("转派记录角色链与经办人", () => {
  const h = makeHarness();
  h.clock.set(T0);
  const { alert } = activeBreach(h);
  h.engine.assign(alert.id, { by: "赵", toRole: "值班主管", toPerson: "周", note: "持续未恢复" });
  h.engine.assign(alert.id, { by: "周", toRole: "保护部门负责人", toPerson: "吴", note: "需要专业处置" });

  assert.equal(alert.assignments.length, 2);
  assert.equal(alert.assignee.role, "保护部门负责人");
  assert.equal(alert.assignments[0].from, null);
  assert.equal(alert.assignments[1].from.role, "值班主管");
});
