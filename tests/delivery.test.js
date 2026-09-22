import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock, makeHarness, MIN, reading, tmpDataFile } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { MonitoringEngine, Notifier } from "../src/engine.js";
import { JsonlStore } from "../src/store.js";

const NIGHT = Date.parse("2026-09-22T22:30:00+08:00"); // 书画分区静默 22:00-06:30

test("静默时段内低级别升级被抑制，静默结束发跨午夜摘要；高级别仍即时发送", () => {
  const h = makeHarness();
  h.clock.set(NIGHT);
  // 22:30 首次越限：L1（<2）被静默抑制，06:30 摘要
  const { alert } = h.engine.ingestReading(
    reading({ at: NIGHT, temperature: 25, humidity: 70 }),
  );
  const l1 = h.store
    .listNotifications()
    .filter((n) => n.alertId === alert.id && n.level === 1 && !n.digest)
    .at(-1);
  assert.equal(l1.status, "suppressed");
  assert.equal(l1.suppressedReason, "quiet_hours");
  assert.equal(new Date(l1.resumeAt).toISOString(), new Date(Date.parse("2026-09-23T06:30:00+08:00")).toISOString());
  assert.equal(h.messages.length, 0, "静默期间不发送 L1");

  // 30 分钟后到 L3：L2/L3（>=suppressBelowLevel=2）即使静默也即时发送
  h.clock.set(NIGHT + 30 * MIN);
  h.engine.ingestReading(reading({ at: NIGHT + 30 * MIN, temperature: 26, humidity: 71 }));
  assert.equal(alert.level, 3);
  const l3 = h.store
    .listNotifications()
    .filter((n) => n.alertId === alert.id && n.level === 3)
    .at(-1);
  assert.equal(l3.status, "sent");
  assert.deepEqual(h.messages.map((m) => m.notification.level), [2, 3]);

  // 时间推进到次日 06:30，定时检查发送摘要
  const morning = Date.parse("2026-09-23T06:30:00+08:00");
  h.clock.set(morning);
  h.engine.runScheduledChecks();
  const digest = h.store
    .listNotifications()
    .find((n) => n.alertId === alert.id && n.digest);
  assert.equal(digest.status, "sent");
  assert.equal(digest.sentAt, morning);
  assert.match(h.messages.at(-1).text, /静默时段摘要/);
});

test("断网期间批量补传：登记全部证据与升级但零通知，恢复后实时读数每级补发一次", () => {
  const h = makeHarness();
  // 02:00-03:00 断网（且处于静默时段，这里不依赖静默语义）
  const recoveredAt = Date.parse("2026-09-22T03:00:00+08:00");
  h.clock.set(recoveredAt);

  const result = h.engine.ingestBatch([
    reading({ at: Date.parse("2026-09-22T02:00:00+08:00"), temperature: 25, humidity: 70, batch: true }),
    reading({ at: Date.parse("2026-09-22T02:10:00+08:00"), temperature: 26, humidity: 71, batch: true }),
    reading({ at: Date.parse("2026-09-22T02:20:00+08:00"), temperature: 26, humidity: 71, batch: true }),
    reading({ at: Date.parse("2026-09-22T02:35:00+08:00"), temperature: 26, humidity: 71, batch: true }),
  ]);
  assert.equal(result.notificationsSent, 0);

  const alert = h.store.listAlerts()[0];
  assert.equal(alert.readingIds.length, 4, "断网期间原始数据全部保留");
  assert.ok(alert.level >= 2, "补传证据推进了升级等级");
  for (const n of h.store.listNotifications()) {
    assert.equal(n.status, "suppressed");
    assert.equal(n.suppressedReason, "backfill_no_replay");
  }
  assert.equal(h.messages.length, 0);

  // 03:00 网络恢复，实时读数仍越限：按当前级别补发一次（非重放每条升级）
  const live = h.engine.ingestReading(
    reading({ at: recoveredAt, temperature: 26, humidity: 71 }),
  );
  const recoveryNotices = h.store
    .listNotifications()
    .filter((n) => n.dedupeKey.includes("recovery"));
  assert.equal(recoveryNotices.length, 1);
  assert.equal(recoveryNotices[0].status, "sent");
  assert.match(recoveryNotices[0].reason, /网络恢复/);
  assert.equal(live.sent, 1);

  // 再来一条实时越限：不重复补发
  h.clock.set(recoveredAt + 2 * MIN);
  const again = h.engine.ingestReading(
    reading({ at: recoveredAt + 2 * MIN, temperature: 26, humidity: 71 }),
  );
  assert.equal(again.sent, 0);

  // 整批补传重复提交：幂等，零新增
  h.clock.set(recoveredAt + 5 * MIN);
  const replay = h.engine.ingestBatch([
    reading({ at: Date.parse("2026-09-22T02:00:00+08:00"), temperature: 25, humidity: 70, batch: true }),
    reading({ at: Date.parse("2026-09-22T02:20:00+08:00"), temperature: 26, humidity: 71, batch: true }),
  ]);
  assert.equal(replay.count, 2);
  assert.equal(replay.duplicated, 2);
  assert.equal(replay.notificationsSent, 0);
  assert.equal(h.messages.length, 1);
});

test("非静默分区补传同样不重放通知", () => {
  const h = makeHarness();
  const recoveredAt = Date.parse("2026-09-22T13:00:00+08:00"); // 白天
  h.clock.set(recoveredAt);
  h.engine.ingestBatch([
    reading({ deviceId: "sensor-ciqi-01", at: recoveredAt - 50 * MIN, temperature: 30, batch: true }),
    reading({ deviceId: "sensor-ciqi-01", at: recoveredAt - 10 * MIN, temperature: 31, batch: true }),
  ]);
  const notes = h.store.listNotifications();
  assert.ok(notes.length >= 1);
  assert.ok(notes.every((n) => n.status === "suppressed" && n.suppressedReason === "backfill_no_replay"));
  assert.equal(h.messages.length, 0);

  // 纯补传开窗：之后无论跑多少次定时检查（含重启追赶）都不能补发墙钟期间的升级
  h.clock.set(recoveredAt + 60 * MIN);
  h.engine.runScheduledChecks();
  h.engine.runScheduledChecks();
  assert.equal(h.messages.length, 0);
  assert.ok(h.store.listAlerts()[0].lastLiveBreachAt === null);
});

test("进程重启：未发送通知按原截止时间继续处理，lateMs 反映延迟", () => {
  const file = tmpDataFile();
  const clock = new FakeClock(Date.parse("2026-09-22T10:00:00+08:00"));
  const build = () => {
    const config = loadConfig();
    const store = new JsonlStore(file).load();
    const messages = [];
    const notifier = new Notifier({
      sink: (n, contacts, text) => {
        const id = `msg-${messages.length + 1}`;
        messages.push({ id, level: n.level, at: clock.now(), text });
        return id;
      },
    });
    return { engine: new MonitoringEngine({ config, store, notifier, now: () => clock.now() }), store, messages };
  };

  const first = build();
  // 10:00 开窗，L1 即时发出；L2 应 10:15 到期
  first.engine.ingestReading(reading({ at: clock.now(), temperature: 25, humidity: 70 }));
  assert.equal(first.messages.length, 1);

  // 模拟进程在 10:10 退出、10:25 才重启（L2 已逾期 10 分钟）
  clock.set(Date.parse("2026-09-22T10:25:00+08:00"));
  const second = build();
  second.engine.runScheduledChecks(); // 启动追赶
  const l2 = second.store
    .listNotifications()
    .filter((n) => n.level === 2)
    .at(-1);
  assert.equal(l2.status, "sent");
  assert.equal(new Date(l2.dueAt).toISOString(), new Date(Date.parse("2026-09-22T10:15:00+08:00")).toISOString(), "截止时间保持原值");
  assert.equal(l2.sentAt, Date.parse("2026-09-22T10:25:00+08:00"));
  assert.equal(l2.lateMs, 10 * MIN);

  // 告警状态也从日志完整恢复：确认/关闭后不再升级
  const alert = second.store.listAlerts()[0];
  second.engine.acknowledge(alert.id, "赵");
  clock.set(Date.parse("2026-09-22T11:00:00+08:00"));
  const third = build();
  third.engine.runScheduledChecks();
  assert.equal(third.store.getAlert(alert.id).status, "acknowledged");
  assert.equal(third.store.getAlert(alert.id).level, 2, "确认状态持久化，重启后不补升级");
});
