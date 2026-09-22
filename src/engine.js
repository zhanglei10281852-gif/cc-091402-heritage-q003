import { createHash } from "node:crypto";
import { calibrationAt, getSensor, getZone, latestCalibration, resolveThreshold } from "./config.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { isInQuietHours, nextQuietHoursEnd, parseTime } from "./time.js";

const METRICS = ["temperature", "humidity"];

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readingId(input) {
  const basis = JSON.stringify([
    input.deviceId,
    input.deviceTime,
    input.collectedAt,
    input.temperature,
    input.humidity,
  ]);
  return "rdg-" + createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function parseTimeSafe(value, timeZone, field) {
  if (value === undefined || value === null) throw new Error(`${field} 必填`);
  if (typeof value === "number") return value;
  return parseTime(String(value), timeZone, field);
}

// 默认短信出口：仅写日志，部署方可注入真实网关。抛出异常时通知保留 pending，由后续重试。
function defaultSmsSink(notification, contacts, text) {
  console.log(
    `[SMS->${contacts.map((c) => c.phone).join(",") || notification.toRole}] ${text}`,
  );
  return `sms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class Notifier {
  constructor({ sink = defaultSmsSink } = {}) {
    this.sink = sink;
    this.sent = []; // 测试观察点：实际交给出口的通知
  }

  send(notification, contacts, text) {
    const messageId = this.sink(notification, contacts, text);
    this.sent.push({ id: notification.id, messageId });
    return messageId;
  }
}

export class MonitoringEngine {
  constructor({ config, store, notifier = new Notifier(), now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.notifier = notifier;
    this.now = now;
  }

  // ---- 读数接入 ----------------------------------------------------------------

  ingestReading(input) {
    const receivedAt = this.now();
    const sensor = getSensor(this.config, input.deviceId);
    if (!sensor) throw badRequest(`未知设备: ${input.deviceId}`);
    const zone = getZone(this.config, sensor);
    if (!zone) throw badRequest(`设备未分配到有效分区: ${input.deviceId}`);

    let deviceMs;
    let collectedMs;
    try {
      deviceMs = parseTimeSafe(input.deviceTime, this.config.timezone, "deviceTime");
      collectedMs = parseTimeSafe(input.collectedAt, this.config.timezone, "collectedAt");
    } catch (error) {
      throw badRequest(error.message);
    }

    const metrics = {};
    for (const metric of METRICS) {
      if (input[metric] !== undefined && input[metric] !== null) {
        const value = Number(input[metric]);
        if (!Number.isFinite(value)) throw badRequest(`${metric} 必须是数值`);
        metrics[metric] = value;
      }
    }
    if (Object.keys(metrics).length === 0) throw badRequest("至少需要一个测量值");

    const id = readingId(input);
    if (this.store.readings.has(id)) {
      // 幂等：同机同时刻同读数重复上报（含补传重放）直接忽略，不重放任何告警或通知
      return { reading: this.store.readings.get(id), duplicated: true, alert: null, sent: 0 };
    }

    // 时钟漂移 = 采集时间 - 设备时间；判定一律以采集时间为准，漂移仅做标记
    const skewMs = collectedMs - deviceMs;
    const flaggedClockDrift = Math.abs(skewMs) > this.config.maxClockSkewSeconds * 1000;
    // 采集时间与服务器收到时间相差超过宽限期，或报文显式标记 batch，视为断网补传
    const backfill =
      input.batch === true || receivedAt - collectedMs > this.config.backfillGraceSeconds * 1000;

    const cal = calibrationAt(this.config, sensor.deviceId, collectedMs);
    const latestCal = latestCalibration(this.config, sensor.deviceId);
    const calibrationOverdue =
      !!latestCal &&
      collectedMs - Date.parse(latestCal.at) > sensor.calibrationIntervalDays * 86400_000;

    const corrected = {};
    for (const [metric, value] of Object.entries(metrics)) {
      const offset = cal?.offsets?.[metric] ?? 0;
      corrected[metric] = Number((value + offset).toFixed(3));
    }

    const violations = [];
    for (const metric of Object.keys(metrics)) {
      const threshold = resolveThreshold(zone, sensor.sensitivity, metric);
      if (!threshold) continue;
      const value = corrected[metric];
      const margin = threshold.criticalMargin ?? 0;
      if (value < threshold.min || value > threshold.max) {
        const critical = value <= threshold.min - margin || value >= threshold.max + margin;
        violations.push({
          metric,
          rawValue: metrics[metric],
          value,
          min: threshold.min,
          max: threshold.max,
          unit: threshold.unit,
          severity: critical ? "critical" : "warning",
          direction: value < threshold.min ? "low" : "high",
        });
      }
    }

    const reading = {
      id,
      deviceId: sensor.deviceId,
      zoneId: zone.id,
      sensitivity: sensor.sensitivity,
      deviceTime: deviceMs,
      collectedAt: collectedMs,
      receivedAt,
      skewMs,
      flaggedClockDrift,
      backfill,
      calibrationId: cal?.recordId ?? null,
      calibrationOverdue,
      metrics,
      corrected,
      violations,
    };
    this.store.putReading(reading);

    const existed = this.store.getActiveAlert(zone.id, sensor.sensitivity);
    let alert;
    if (existed && collectedMs >= existed.openedAt) {
      // 告警期间的原始数据：无论是否仍越限都挂接保留，跨午夜窗口同样保留
      alert = existed;
      this._attachReading(alert, reading);
    } else if (violations.length > 0) {
      alert = this._openAlert(zone, sensor, reading);
    }

    let sent = 0;
    if (alert) {
      if (violations.length > 0) {
        alert.lastBreachAt = Math.max(alert.lastBreachAt, collectedMs);
        if (!backfill) alert.lastLiveBreachAt = Math.max(alert.lastLiveBreachAt ?? 0, collectedMs);
      }
      alert.lastReadingAt = Math.max(alert.lastReadingAt, collectedMs);
      this._markClockDrift(alert, reading);
      this.store.putAlert(alert);
      // 补传数据把连续越限证据推进到采集时刻，但只登记升级、不重放通知
      this._advance(alert, alert.lastBreachAt, { source: backfill ? "backfill" : "realtime" });
      if (!backfill) this._realtimeRecoveryIfNeeded(alert);
      sent = this._deliverDue(receivedAt);
    }

    return { reading, duplicated: false, alert: alert ?? null, sent };
  }

  ingestBatch(list) {
    if (!Array.isArray(list)) throw badRequest("batch 必须是读数数组");
    // 先按采集时间排序，保证断网期间的连续越限按真实顺序开窗与升级
    const ordered = list
      .map((item) => {
        try {
          return { item, collectedAt: parseTimeSafe(item.collectedAt, this.config.timezone, "collectedAt") };
        } catch {
          return { item, collectedAt: 0 };
        }
      })
      .sort((a, b) => a.collectedAt - b.collectedAt);
    const results = ordered.map(({ item }) => this.ingestReading(item));
    return {
      count: results.length,
      duplicated: results.filter((r) => r.duplicated).length,
      notificationsSent: results.reduce((sum, r) => sum + r.sent, 0),
      alerts: [...new Set(results.map((r) => r.alert?.id).filter(Boolean))],
    };
  }

  _attachReading(alert, reading) {
    if (!alert.readingIds.includes(reading.id)) alert.readingIds.push(reading.id);
    if (!alert.deviceIds.includes(reading.deviceId)) alert.deviceIds.push(reading.deviceId);
    for (const metric of Object.keys(reading.metrics)) {
      if (!alert.metrics.includes(metric)) alert.metrics.push(metric);
    }
    if (reading.violations.length === 0) {
      alert.recoveredSince ??= reading.collectedAt;
    } else {
      alert.recoveredSince = null;
    }
  }

  _openAlert(zone, sensor, reading) {
    const alert = {
      id: newId("alrt"),
      zoneId: zone.id,
      zoneName: zone.name,
      sensitivity: sensor.sensitivity,
      status: "open",
      openedAt: reading.collectedAt,
      lastBreachAt: reading.collectedAt,
      lastLiveBreachAt: reading.backfill ? null : reading.collectedAt,
      lastReadingAt: reading.collectedAt,
      recoveredSince: null,
      closedAt: null,
      closeReason: null,
      closedBy: null,
      closedWithoutRecheck: false,
      deviceIds: [sensor.deviceId],
      metrics: Object.keys(reading.metrics),
      readingIds: [reading.id],
      level: 0,
      escalations: [],
      acknowledgements: [],
      assignments: [],
      assignee: null,
      rechecks: [],
      latestRecheckResult: null,
      clockDrift: { detected: false, devices: {} },
    };
    this.store.putAlert(alert);
    const first = zone.escalations.find((step) => step.level === 1) ?? zone.escalations[0];
    this._addEscalation(alert, {
      level: first.level,
      reason: first.reason,
      toRole: first.toRole,
      cause: "opened",
      at: reading.collectedAt,
      source: reading.backfill ? "backfill" : "realtime",
      violation: reading.violations[0] ?? null,
    });
    return this.store.getAlert(alert.id);
  }

  _markClockDrift(alert, reading) {
    if (!reading.flaggedClockDrift) return;
    alert.clockDrift.detected = true;
    const known = alert.clockDrift.devices[reading.deviceId] ?? {
      maxAbsSkewMs: 0,
      skewMs: reading.skewMs,
      count: 0,
      firstAt: reading.collectedAt,
    };
    known.maxAbsSkewMs = Math.max(known.maxAbsSkewMs, Math.abs(reading.skewMs));
    known.skewMs = reading.skewMs;
    known.count += 1;
    known.firstAt = Math.min(known.firstAt, reading.collectedAt);
    alert.clockDrift.devices[reading.deviceId] = known;
  }

  // ---- 升级（定时检查与实时推进共用） -------------------------------------------

  // 依据连续越限证据已覆盖到的时刻 evidenceMs 把告警推到应达级别。
  // 定时检查在未收到恢复读数时用墙钟时刻作为证据；升级记录与通知只增一次，天然幂等。
  _advance(alert, evidenceMs, { source }) {
    if (alert.status === "closed") return 0;
    const zone = this.config.zones.get(alert.zoneId);
    let planned = 0;
    const locked = alert.status === "acknowledged"; // 值守员确认后暂停按时间升级
    for (const step of zone.escalations) {
      if (step.level <= alert.level) continue;
      if (locked) break;
      const dueAt = alert.openedAt + step.afterMinutes * 60_000;
      if (dueAt <= evidenceMs) {
        this._addEscalation(alert, {
          level: step.level,
          reason: step.reason,
          toRole: step.toRole,
          cause: "duration",
          at: dueAt,
          source,
        });
        planned += 1;
      }
    }
    return planned;
  }

  // 补传只能登记被抑制的升级；网络恢复后若实时数据证明风险仍在，按当前级别补发一次实时通知，
  // 这不是重放（每个告警每级别仅一次，且文案标明来自补传恢复）。
  _realtimeRecoveryIfNeeded(alert) {
    if (alert.status === "closed" || alert.recoveredSince !== null) return;
    // 仅当存在断网补传期间被抑制的通知时才补发
    const hasBackfillSuppression = [...this.store.notifications.values()].some(
      (n) => n.alertId === alert.id && n.mode === "backfill",
    );
    if (!hasBackfillSuppression) return;
    const dedupeKey = `${alert.id}:recovery:${alert.level}`;
    const exists = [...this.store.notifications.values()].some((n) => n.dedupeKey === dedupeKey);
    if (exists) return;
    const hasRealtimeNoticeAtLevel = [...this.store.notifications.values()].some(
      (n) =>
        n.alertId === alert.id &&
        n.level === alert.level &&
        n.mode === "realtime" &&
        n.status !== "suppressed",
    );
    if (hasRealtimeNoticeAtLevel) return;
    const zone = this.config.zones.get(alert.zoneId);
    const step = zone.escalations.find((e) => e.level === alert.level) ?? zone.escalations.at(-1);
    this._addEscalation(alert, {
      level: alert.level,
      reason: "网络恢复后实时读数仍越限；断网期间补传只登记升级、未重放通知，此为当前级别补发",
      toRole: step.toRole,
      cause: "backfill_recovery",
      at: this.now(),
      source: "realtime",
    });
  }

  _addEscalation(alert, { level, reason, toRole, cause, at, source, violation }) {
    const escalation = {
      id: newId("escl"),
      level,
      reason,
      toRole,
      cause,
      at,
      recordedAt: this.now(),
      source,
      violation: violation ?? null,
      notificationId: null,
    };
    alert.escalations.push(escalation);
    if (level > alert.level) alert.level = level;
    const notification = this._planNotification(alert, escalation, { source });
    escalation.notificationId = notification.id;
    this.store.putAlert(alert);
    if (!this.store.notifications.has(notification.id)) this.store.putNotification(notification);
    return escalation;
  }

  _contactsForRole(role) {
    return this.config.contacts.filter((contact) => contact.roles.includes(role));
  }

  _planNotification(alert, escalation, { source }) {
    const dedupeKey =
      escalation.cause === "backfill_recovery"
        ? `${alert.id}:recovery:${escalation.level}`
        : `${alert.id}:${escalation.id}`;
    const existing = [...this.store.notifications.values()].find((n) => n.dedupeKey === dedupeKey);
    if (existing) return existing;

    const base = {
      id: newId("note"),
      alertId: alert.id,
      escalationId: escalation.id,
      dedupeKey,
      level: escalation.level,
      toRole: escalation.toRole,
      contactIds: this._contactsForRole(escalation.toRole).map((c) => c.id),
      channel: "sms",
      reason: escalation.reason,
      dueAt: escalation.at,
      createdAt: this.now(),
      sentAt: null,
      status: "pending",
      suppressedReason: null,
      mode: source === "backfill" ? "backfill" : "realtime",
      lateMs: null,
      digest: false,
    };

    // 补传只补证据，绝不重放通知
    if (source === "backfill") {
      return { ...base, status: "suppressed", suppressedReason: "backfill_no_replay" };
    }

    const zone = this.config.zones.get(alert.zoneId);
    if (
      zone.quietHours?.enabled &&
      escalation.level < (zone.quietHours.suppressBelowLevel ?? Infinity) &&
      isInQuietHours(escalation.at, zone.quietHours, this.config.timezone)
    ) {
      const quietEnd = nextQuietHoursEnd(escalation.at, zone.quietHours, this.config.timezone);
      this._planQuietDigest(alert, zone, quietEnd);
      return {
        ...base,
        status: "suppressed",
        suppressedReason: "quiet_hours",
        resumeAt: quietEnd,
      };
    }
    return base;
  }

  // 静默期内被抑制的低级别升级，在静默结束时合并为一条摘要发送（跨午夜按绝对时刻，不截断）
  _planQuietDigest(alert, zone, quietEnd) {
    const dedupeKey = `${alert.id}:quiet:${quietEnd}`;
    if ([...this.store.notifications.values()].some((n) => n.dedupeKey === dedupeKey)) return;
    this.store.putNotification({
      id: newId("note"),
      alertId: alert.id,
      escalationId: null,
      dedupeKey,
      level: zone.quietHours.suppressBelowLevel - 1,
      toRole: "值守员",
      contactIds: this._contactsForRole("值守员").map((c) => c.id),
      channel: "sms",
      reason: "静默时段告警摘要",
      dueAt: quietEnd,
      createdAt: this.now(),
      sentAt: null,
      status: "pending",
      suppressedReason: null,
      mode: "realtime",
      lateMs: null,
      digest: true,
    });
  }

  // ---- 定时检查（进程重启后按原截止时间继续） --------------------------------------

  runScheduledChecks(now = this.now()) {
    let escalations = 0;
    for (const alert of this.store.alerts.values()) {
      if (alert.status === "closed") continue;
      // 只有收到过实时越限读数，墙钟走到才可视为风险持续；纯补传告警不能用当前时刻延伸证据
      const evidenceMs =
        alert.recoveredSince === null && alert.lastLiveBreachAt != null
          ? now
          : alert.lastBreachAt;
      escalations += this._advance(alert, evidenceMs, { source: "realtime" });
      if (alert.recoveredSince === null && alert.lastLiveBreachAt != null) {
        this._realtimeRecoveryIfNeeded(alert);
      }
    }
    const sent = this._deliverDue(now);
    return { escalations, sent, at: now };
  }

  _deliverDue(now) {
    let sent = 0;
    for (const notification of this.store.listNotifications()) {
      if (notification.status !== "pending" || notification.dueAt > now) continue;
      if (this._deliver(notification, now)) sent += 1;
    }
    return sent;
  }

  _deliver(notification, now) {
    const alert = this.store.getAlert(notification.alertId);
    const contacts = notification.contactIds
      .map((id) => this.config.contacts.find((c) => c.id === id))
      .filter(Boolean);
    const text = notification.digest
      ? this._digestText(notification)
      : this._notificationText(alert, notification);
    let messageId;
    try {
      messageId = this.notifier.send(notification, contacts, text);
    } catch (error) {
      // 网关失败：保留 pending 与原截止时间，下个检查周期重试
      console.error(`通知发送失败，保留待发 ${notification.id}:`, error.message);
      return false;
    }
    this.store.putNotification({
      ...notification,
      status: "sent",
      sentAt: now,
      lateMs: Math.max(0, now - notification.dueAt),
      messageId,
    });
    return true;
  }

  _notificationText(alert, notification) {
    const drift = alert.clockDrift.detected
      ? `；注意 ${Object.keys(alert.clockDrift.devices).join("、")} 时钟漂移，判定以采集时间为准`
      : "";
    return (
      `[环境告警] ${alert.zoneName}(${alert.sensitivity}) L${notification.level}：${notification.reason}` +
      `，始于 ${new Date(alert.openedAt).toISOString()}，状态=${alert.status}${drift}`
    );
  }

  _digestText(notification) {
    const alert = this.store.getAlert(notification.alertId);
    const suppressed = this.store.listNotifications().filter(
      (n) =>
        n.alertId === alert.id &&
        n.status === "suppressed" &&
        n.suppressedReason === "quiet_hours" &&
        n.resumeAt === notification.dueAt,
    );
    return (
      `[静默时段摘要] ${alert.zoneName} 告警 ${alert.id} 当前 L${alert.level}，` +
      `静默期间积压 ${suppressed.length} 条升级：${suppressed.map((n) => n.reason).join("；")}`
    );
  }

  // ---- 值守员处置 ---------------------------------------------------------------

  acknowledge(alertId, by) {
    const alert = this._requireAlert(alertId);
    if (!by) throw badRequest("by 必填");
    if (alert.status === "closed") throw conflict("告警已闭环，不能确认");
    alert.acknowledgements.push({ by, at: this.now() });
    alert.status = "acknowledged";
    alert.acknowledgedBy = by;
    this.store.putAlert(alert);
    return alert;
  }

  assign(alertId, { by, toRole, toPerson, note }) {
    const alert = this._requireAlert(alertId);
    if (!by) throw badRequest("by 必填");
    if (!toRole) throw badRequest("toRole 必填");
    if (alert.status === "closed") throw conflict("告警已闭环，不能转派");
    alert.assignments.push({
      from: alert.assignee ?? null,
      toRole,
      toPerson: toPerson ?? null,
      by,
      note: note ?? "",
      at: this.now(),
    });
    alert.assignee = { role: toRole, person: toPerson ?? null, at: this.now() };
    this.store.putAlert(alert);
    return alert;
  }

  addRecheck(alertId, body) {
    const alert = this._requireAlert(alertId);
    if (alert.status === "closed") throw conflict("告警已闭环，不能追加复测");
    const { by, result, temperature, humidity, note, deviceId } = body;
    if (!by) throw badRequest("by 必填");
    if (!["pass", "fail"].includes(result)) throw badRequest("result 必须为 pass 或 fail");
    const measuredAt = body.at
      ? parseTimeSafe(body.at, this.config.timezone, "at")
      : this.now();
    const recheck = {
      id: newId("rchk"),
      by,
      at: measuredAt,
      recordedAt: this.now(),
      deviceId: deviceId ?? null,
      temperature: temperature ?? null,
      humidity: humidity ?? null,
      result,
      note: note ?? "",
    };
    alert.rechecks.push(recheck);
    alert.latestRecheckResult = result;
    this.store.putAlert(alert);

    if (result === "fail") {
      // 复测仍越限：打破确认锁定，立即再升一级并通知对应角色
      alert.status = "open";
      const zone = this.config.zones.get(alert.zoneId);
      const maxLevel = Math.max(...zone.escalations.map((e) => e.level));
      const nextLevel = Math.min(alert.level + 1, maxLevel);
      const step = zone.escalations.find((e) => e.level === nextLevel) ?? zone.escalations.at(-1);
      this._addEscalation(alert, {
        level: step.level,
        reason: `现场复测仍不合格：${note || "温湿度仍越限"}`,
        toRole: step.toRole,
        cause: "recheck_failed",
        at: this.now(),
        source: "realtime",
      });
      this._deliverDue(this.now());
    }
    return this.store.getAlert(alert.id);
  }

  close(alertId, { by, reason, force = false }) {
    const alert = this._requireAlert(alertId);
    if (!by) throw badRequest("by 必填");
    if (!reason) throw badRequest("关闭原因 reason 必填");
    if (alert.status === "closed") throw conflict("告警已经是闭环状态");
    if (alert.latestRecheckResult === "fail" && !force) {
      throw conflict("最近一次现场复测仍不合格，需复测合格或显式 force 才能关闭");
    }
    alert.status = "closed";
    alert.closedAt = this.now();
    alert.closeReason = reason;
    alert.closedBy = by;
    // 未现场复测即关闭会明确标注，促使事后复核
    alert.closedWithoutRecheck = alert.latestRecheckResult !== "pass";
    this.store.putAlert(alert);
    // 未发送的待办通知随闭环撤销，记录保留可审计
    for (const notification of this.store.listNotifications()) {
      if (notification.alertId === alert.id && notification.status === "pending") {
        this.store.putNotification({
          ...notification,
          status: "cancelled",
          suppressedReason: "alert_closed",
        });
      }
    }
    return alert;
  }

  _requireAlert(alertId) {
    const alert = this.store.getAlert(alertId);
    if (!alert) throw notFound(`告警不存在: ${alertId}`);
    return alert;
  }
}
