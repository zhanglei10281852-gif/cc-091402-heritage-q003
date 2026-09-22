import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, reading, MIN } from "./helpers.js";
import { buildServices } from "../src/bootstrap.js";

const START = "2026-09-21T20:00:00+08:00";

test("进程重启后：未确认告警按原截止时间补升级，待发通知按原 notBefore 补发送", async (t) => {
  const h = makeHarness(START);
  t.after(() => h.cleanup());

  // 开出 warn 告警（opened 通知当时已发）
  await h.ingestReading(reading({ id: "k-1", at: h.now, t: 24 }));
  h.advance(6 * MIN);
  await h.ingestReading(reading({ id: "k-2", at: h.now, t: 24 }));
  await h.tick();
  const openedCount = h.sentSms.length;
  assert.ok(openedCount > 0);
  const alertId = h.services.engine.state.alerts[0].id;

  // 重启前记录原截止时间
  const beforeRestart = h.services.engine.alertDetail(alertId);
  const originalDeadline = beforeRestart.nextDeadline;
  assert.ok(originalDeadline);

  // 模拟进程重启：重新装配，虚拟时钟直接跳到停机 12 分钟后（已超过确认超时 10 分钟）
  const restartMs = h.now + 12 * MIN;
  let restartNow = restartMs;
  const restartedSms = [];
  const sender2 = {
    async send(notification) {
      restartedSms.push({ id: notification.id, kind: notification.kind, target: notification.target });
      return { status: "sent" };
    },
  };
  const services2 = buildServices(
    { DATA_DIR: h.dataDir },
    { clock: () => restartNow, sender: sender2 },
  );
  services2.scheduler.start(); // 启动立即补跑
  // setInterval 处于 unref 状态，手动让出微任务队列
  await new Promise((resolve) => setImmediate(resolve));

  const alert2 = services2.store.state.alerts.find((a) => a.id === alertId);
  assert.equal(alert2.status, "open");
  assert.equal(alert2.severity, "critical", "重启后应按原截止时间补做超时升级");
  const escalation = alert2.escalations.at(-1);
  assert.match(escalation.reason, /无人确认/);
  assert.equal(new Date(escalation.deadlineMs).toISOString(), originalDeadline);

  // 升级短信已补发（重启前的 opened 通知不重放）
  assert.ok(restartedSms.some((s) => s.kind === "escalation"));
  assert.ok(!restartedSms.some((s) => s.kind === "opened"), "重启不得重放已到期过的 opened 通知");
});

test("进程重启后：静默延后的通知在窗口结束后按原 notBefore 发出", async (t) => {
  const h = makeHarness("2026-09-21T23:10:00+08:00");
  t.after(() => h.cleanup());
  await h.ingestReading(reading({ id: "q-1", sensor: "sensor-C-01", at: h.now, t: 23 }));
  h.advance(6 * MIN);
  await h.ingestReading(reading({ id: "q-2", sensor: "sensor-C-01", at: h.now, t: 23 }));
  await h.tick();
  assert.equal(h.sentSms.length, 0);

  // 在静默期间重启
  let restartNow = Date.parse("2026-09-22T06:10:00+08:00");
  const restartedSms = [];
  const services2 = buildServices(
    { DATA_DIR: h.dataDir },
    {
      clock: () => restartNow,
      sender: {
        async send(n) {
          restartedSms.push(n.id);
          return { status: "sent" };
        },
      },
    },
  );
  services2.scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(restartedSms.length > 0, "过了原 notBefore 的通知应在重启补跑时发出");

  // 再 tick 不重发
  const count = restartedSms.length;
  restartNow += MIN;
  await services2.scheduler.tick();
  assert.equal(restartedSms.length, count);
});
