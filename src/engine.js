// 告警引擎：读数入库、阈值评估、去抖与分区去重、生命周期动作、定时升级判定。
// 关键不变量：
//  1. 一切窗口与排序只用可信采集时间 collectedAt；deviceTime 仅用于漂移判定。
//  2. 去重维度 = 库房分区 + 指标；同分区多台设备的越限并入同一条告警。
//  3. 告警期间全部原始读数挂在告警上，关闭后也不裁剪。
//  4. 所有截止时间都是绝对 epoch 毫秒，重启后按原截止时间继续处理。
import { bumpSeverity, evaluateClock, iso, parseInstant, SEVERITY_ORDER } from "./time.js";
import { createNotifications, matchingContacts, rosterAssignee } from "./notify.js";

const FUTURE_SKEW_MS = 60_000;

export class AlertEngine {
  constructor({ store, config, clock = () => Date.now() }) {
    this.store = store;
    this.state = store.state;
    this.config = config;
    this.clock = clock;
  }

  now() {
    return this.clock();
  }

  // ---------- 读数入库 ----------

  /**
   * 批量入库。payload: { readings: [...] } 或单个读数对象。
   * 批内按 collectedAt 排序后顺序处理；重复 readingId 幂等跳过，不重放任何通知。
   */
  async ingest(payload, arrivalMs = this.now()) {
    const list = Array.isArray(payload) ? payload : payload.readings;
    if (!Array.isArray(list)) throw httpError(400, "请求体需要 readings 数组");
    if (list.length === 0) throw httpError(400, "readings 不能为空");
    if (list.length > this.config.ingest.maxBatchSize) {
      throw httpError(413, `批量超过上限 ${this.config.ingest.maxBatchSize}`);
    }

    const accepted = [];
    const duplicates = [];
    const rejected = [];
    const touched = new Map();
    const clockWarnings = [];

    const normalized = [];
    const inBatchIds = new Set();
    for (const item of list) {
      try {
        if (item && typeof item.readingId === "string" && inBatchIds.has(item.readingId)) {
          const error = new Error("同一批次内 readingId 重复");
          error.duplicate = true;
          error.readingId = item.readingId;
          throw error;
        }
        const normalizedItem = this.normalizeReading(item, arrivalMs);
        inBatchIds.add(normalizedItem.readingId);
        normalized.push(normalizedItem);
      } catch (error) {
        if (error.duplicate) {
          duplicates.push({ readingId: error.readingId, reason: error.message });
        } else {
          rejected.push({ readingId: item?.readingId ?? null, reason: error.message });
        }
      }
    }
    normalized.sort((a, b) => a.collectedAtMs - b.collectedAtMs);

    for (const reading of normalized) {
      accepted.push(reading.readingId);
      this.state.ingested[reading.readingId] = {
        arrivalMs,
        sensorId: reading.sensorId,
        collectedAtMs: reading.collectedAtMs,
        batch: reading.batch ?? null,
      };
      if (reading.clock.flagged || reading.clock.uncalibrated || reading.clock.calibrationStale) {
        clockWarnings.push({
          readingId: reading.readingId,
          sensorId: reading.sensorId,
          ...reading.clock,
        });
      }
      for (const metricResult of reading.metricResults) {
        const alert = this.applyMetric(reading, metricResult, arrivalMs);
        if (alert) touched.set(alert.id, alert);
      }
    }

    await this.store.flush();
    return {
      received: list.length,
      acceptedCount: accepted.length,
      accepted,
      duplicates,
      rejected,
      clockWarnings,
      alerts: [...touched.values()].map((alert) => this.alertView(alert, arrivalMs)),
    };
  }

  normalizeReading(item, arrivalMs) {
    if (!item || typeof item !== "object") throw httpError(400, "读数格式错误");
    const readingId = item.readingId;
    if (typeof readingId !== "string" || readingId.trim() === "") {
      throw httpError(400, "缺少 readingId");
    }
    if (this.state.ingested[readingId]) {
      const error = new Error("读数已入库，重复补传已忽略，不重放通知");
      error.duplicate = true;
      error.readingId = readingId;
      throw error;
    }
    const sensor = this.config.sensors.get(item.sensorId);
    if (!sensor) throw httpError(400, `未知传感器: ${item.sensorId}`);
    if (sensor.active === false) throw httpError(400, `传感器已停用: ${item.sensorId}`);

    const deviceTimeMs = parseInstant(item.deviceTime, "deviceTime");
    const collectedAtMs = parseInstant(item.collectedAt, "collectedAt");
    if (collectedAtMs > arrivalMs + FUTURE_SKEW_MS) {
      throw httpError(422, "采集时间晚于当前时间，拒绝入库（请检查网关时钟）");
    }
    if (collectedAtMs < arrivalMs - this.config.ingest.lateArrivalWindowMs) {
      throw httpError(422, "采集时间超出补传保留窗口");
    }
    const values = item.metrics ?? {};
    const metricResults = [];
    for (const metric of sensor.metrics) {
      const value = values[metric];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw httpError(422, `${item.sensorId} 缺少指标 ${metric} 的数值`);
      }
      metricResults.push({ metric, value, ...this.classify(sensor.zone, metric, value) });
    }

    const calibration = this.config.calibrations.get(item.sensorId) ?? null;
    const clock = evaluateClock({
      deviceTimeMs,
      collectedAtMs,
      calibration,
      toleranceMs: this.config.ingest.defaultClockToleranceMs,
      nowMs: arrivalMs,
    });

    return {
      readingId,
      sensorId: item.sensorId,
      zone: sensor.zone,
      deviceTimeMs,
      collectedAtMs,
      arrivalMs,
      batch: item.batch ?? null,
      metricResults,
      clock,
      raw: item.raw ?? null,
    };
  }

  classify(zoneId, metric, value) {
    const spec = this.config.zones.get(zoneId).metrics[metric];
    if (!spec) throw httpError(400, `分区 ${zoneId} 未配置指标 ${metric}`);
    if (value >= spec.warn.min && value <= spec.warn.max) return { level: "ok", breached: false };
    if (value >= spec.critical.min && value <= spec.critical.max) return { level: "warn", breached: true };
    return { level: "critical", breached: true };
  }

  applyMetric(reading, { metric, value, level, breached }, arrivalMs) {
    const key = `${reading.zone}|${metric}`;
    const snapshot = {
      readingId: reading.readingId,
      sensorId: reading.sensorId,
      metric,
      value,
      level,
      collectedAtMs: reading.collectedAtMs,
      deviceTimeMs: reading.deviceTimeMs,
      arrivalMs: reading.arrivalMs,
      clock: reading.clock,
    };

    const active = this.findActiveAlert(key) ?? this.reopenIfRecent(key, arrivalMs);
    if (active) {
      this.absorbIntoAlert(active, snapshot, reading, level, breached, arrivalMs);
      return active;
    }

    if (!breached) {
      if (this.state.pending[key]) delete this.state.pending[key];
      return null;
    }

    const pending = this.state.pending[key];
    if (pending) {
      pending.readings.push(snapshot);
      // 补传可能乱序到达，边界一律取采集时间的最小/最大值。
      pending.firstExceedAtMs = Math.min(pending.firstExceedAtMs, reading.collectedAtMs);
      pending.lastExceedAtMs = Math.max(pending.lastExceedAtMs, reading.collectedAtMs);
      this.mergeClockAnomaly(pending.clockAnomalies, reading);
      if (!pending.sensorIds.includes(reading.sensorId)) pending.sensorIds.push(reading.sensorId);
      if (pending.lastExceedAtMs - pending.firstExceedAtMs >= this.config.alerting.debounceMs) {
        return this.openAlert(pending, reading, arrivalMs);
      }
      return null;
    }

    this.state.pending[key] = {
      key,
      zone: reading.zone,
      metric,
      firstExceedAtMs: reading.collectedAtMs,
      lastExceedAtMs: reading.collectedAtMs,
      sensorIds: [reading.sensorId],
      readings: [snapshot],
      clockAnomalies: this.collectClockAnomaly(reading),
    };
    return null;
  }

  absorbIntoAlert(alert, snapshot, reading, level, breached, atMs) {
    alert.readings.push(snapshot);
    // 补传的旧读数可能乱序到达，窗口边界统一按采集时间从全部读数重算，不允许回退。
    this.recomputeWindowFromReadings(alert);
    alert.updatedAtMs = atMs;
    if (!alert.sensorIds.includes(reading.sensorId)) alert.sensorIds.push(reading.sensorId);
    this.mergeClockAnomaly(alert.clockAnomalies, reading);

    if (breached) {
      if (SEVERITY_ORDER[level] > SEVERITY_ORDER[alert.severity]) {
        const from = alert.severity;
        alert.severity = level;
        // 迟到超过去抖窗口的历史读数（断网补传）只记录升级事实，不补发短信。
        const historical = atMs - reading.collectedAtMs > this.config.alerting.debounceMs;
        this.recordEscalation(alert, {
          atMs: reading.collectedAtMs,
          from,
          to: level,
          reason: historical
            ? `补传历史读数显示当时越限等级已达 ${level}（断网补传，不重放通知）`
            : `读数越限等级升高（${from} → ${level}）`,
          trigger: historical ? "reading_backfill" : "reading",
          notificationSuppressed: historical,
        });
        if (!historical) {
          this.dispatchForAlert(alert, "escalation", `告警升级为 ${level}：读数越限等级升高`, reading.collectedAtMs);
        }
      }
    }
  }

  openAlert(pending, reading, atMs) {
    const zone = this.config.zones.get(pending.zone);
    const orderedReadings = pending.readings.toSorted((a, b) => a.collectedAtMs - b.collectedAtMs);
    const maxLevel = orderedReadings.reduce(
      (max, r) => (SEVERITY_ORDER[r.level] > SEVERITY_ORDER[max] ? r.level : max),
      "warn",
    );
    // 整个越限窗口都来自迟到超过去抖窗口的补传：告警照开（风险可见），但不补发短信。
    const historical = atMs - pending.lastExceedAtMs > this.config.alerting.debounceMs;
    const alert = {
      id: this.store.nextId("alr"),
      key: pending.key,
      zone: pending.zone,
      zoneName: zone.name,
      sensitivity: zone.sensitivity,
      metric: pending.metric,
      status: "open",
      severity: maxLevel,
      sensorIds: [...pending.sensorIds],
      firstExceedAtMs: pending.firstExceedAtMs,
      openedAtMs: atMs,
      lastExceedAtMs: pending.lastExceedAtMs,
      firstOkAtMs: null,
      lastReadingAtMs: pending.lastExceedAtMs,
      updatedAtMs: atMs,
      acknowledgedAtMs: null,
      acknowledgedBy: null,
      recheckAtMs: null,
      assignee: null,
      closedAtMs: null,
      closure: null,
      escalationsCount: 0,
      lastEscalationAtMs: null,
      readings: orderedReadings,
      clockAnomalies: pending.clockAnomalies,
      openedFromBackfill: historical,
      events: [
        {
          type: "opened",
          atMs,
          detail: {
            firstExceedAtMs: pending.firstExceedAtMs,
            debounceMs: this.config.alerting.debounceMs,
            notificationSuppressed: historical,
            reason: historical
              ? `断网补传还原出分区 ${zone.name}（敏感等级 ${zone.sensitivity}）${pending.metric} 的连续越限窗口，不重放通知`
              : `分区 ${zone.name}（敏感等级 ${zone.sensitivity}）${pending.metric} 连续越限超过去抖窗口`,
          },
        },
      ],
      escalations: [],
      rechecks: [],
      dutyAtOpen: rosterAssignee(this.config, atMs, pending.zone),
    };
    delete this.state.pending[pending.key];
    this.state.alerts.push(alert);
    if (!historical) {
      this.dispatchForAlert(
        alert,
        "opened",
        `${zone.name} ${pending.metric} 越限告警（${maxLevel}）`,
        atMs,
      );
    }
    return alert;
  }

  findActiveAlert(key) {
    return this.state.alerts.find((a) => a.key === key && a.status !== "closed") ?? null;
  }

  /**
   * 按采集时间从全部读数重算窗口边界。读数可能随补传乱序到达，
   * 因此任何派生字段都不能做单调回退假设。
   */
  recomputeWindowFromReadings(alert) {
    const sorted = alert.readings.toSorted((a, b) => a.collectedAtMs - b.collectedAtMs);
    alert.firstExceedAtMs = sorted[0].collectedAtMs;
    alert.lastReadingAtMs = sorted.at(-1).collectedAtMs;
    let lastExceed = null;
    for (const r of sorted) if (r.level !== "ok") lastExceed = r.collectedAtMs;
    if (lastExceed === null) {
      alert.lastExceedAtMs = alert.firstExceedAtMs;
      alert.firstOkAtMs = sorted[0].collectedAtMs;
      return;
    }
    alert.lastExceedAtMs = lastExceed;
    const firstOkAfter = sorted.find((r) => r.level === "ok" && r.collectedAtMs > lastExceed);
    alert.firstOkAtMs = firstOkAfter ? firstOkAfter.collectedAtMs : null;
  }

  // ---------- 生命周期动作 ----------

  getAlertOrThrow(id) {
    const alert = this.state.alerts.find((a) => a.id === id);
    if (!alert) throw httpError(404, `告警不存在: ${id}`);
    return alert;
  }

  async acknowledge(id, { operator, note } = {}, atMs = this.now()) {
    const alert = this.getAlertOrThrow(id);
    if (alert.status === "closed") throw httpError(409, "告警已关闭，不能确认");
    if (alert.status !== "open") throw httpError(409, "告警已被确认");
    alert.status = "acknowledged";
    alert.acknowledgedAtMs = atMs;
    alert.acknowledgedBy = operator ?? null;
    alert.updatedAtMs = atMs;
    alert.events.push({ type: "acknowledged", atMs, operator: operator ?? null, note: note ?? null });
    await this.store.flush();
    return this.alertView(alert, atMs);
  }

  async assign(id, { operator, toContactId, note } = {}, atMs = this.now()) {
    const alert = this.getAlertOrThrow(id);
    if (alert.status === "closed") throw httpError(409, "告警已关闭，不能转派");
    const contact = this.config.contacts.get(toContactId);
    if (!contact) throw httpError(400, `未知联系人: ${toContactId}`);
    if (!contact.zones.includes(alert.zone)) {
      throw httpError(409, `联系人 ${contact.name} 不负责分区 ${alert.zone}`);
    }
    const previous = alert.assignee;
    alert.assignee = toContactId;
    if (alert.status === "open") {
      alert.status = "acknowledged";
      alert.acknowledgedAtMs ??= atMs;
      alert.acknowledgedBy ??= operator ?? null;
    }
    alert.updatedAtMs = atMs;
    alert.events.push({
      type: "reassigned",
      atMs,
      operator: operator ?? null,
      detail: { from: previous, to: toContactId, note: note ?? null },
    });
    this.dispatchForAlert(
      alert,
      "assigned",
      `告警已转派给 ${contact.name}`,
      atMs,
      [contact],
    );
    await this.store.flush();
    return this.alertView(alert, atMs);
  }

  async submitRecheck(id, body = {}, atMs = this.now()) {
    const alert = this.getAlertOrThrow(id);
    if (alert.status === "closed") throw httpError(409, "告警已关闭");
    const operator = body.operator;
    if (typeof operator !== "string" || operator.trim() === "") {
      throw httpError(400, "复测需要记录经办人 operator");
    }
    let measuredAtMs;
    try {
      measuredAtMs = parseInstant(body.measuredAt, "measuredAt");
    } catch (error) {
      throw httpError(400, error.message);
    }
    if (measuredAtMs > atMs + FUTURE_SKEW_MS) throw httpError(422, "复测时间不能晚于当前时间");
    const measurements = {};
    for (const [metric, value] of Object.entries(body.measurements ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw httpError(400, `复测指标 ${metric} 数值非法`);
      }
      const result = this.classify(alert.zone, metric, value);
      measurements[metric] = { value, ...result };
    }
    if (!measurements[alert.metric]) {
      throw httpError(400, `复测必须包含告警指标 ${alert.metric} 的实测值`);
    }
    const conforming = measurements[alert.metric].level === "ok";
    const evidence = {
      id: this.store.nextId("evd"),
      atMs,
      operator,
      measuredAtMs,
      measurements,
      conforming,
      method: body.method ?? null,
      note: body.note ?? null,
      sensorId: body.sensorId ?? null,
      escalated: false,
    };
    alert.rechecks.push(evidence);
    alert.status = "recheck";
    alert.recheckAtMs = atMs;
    alert.updatedAtMs = atMs;
    alert.events.push({
      type: "recheck_submitted",
      atMs,
      operator,
      detail: { evidenceId: evidence.id, conforming, measuredAtMs },
    });
    if (!conforming) {
      // 复测仍越限：作为新的越限证据参与等级判定。
      const level = measurements[alert.metric].level;
      if (SEVERITY_ORDER[level] > SEVERITY_ORDER[alert.severity]) {
        const from = alert.severity;
        alert.severity = level;
        this.recordEscalation(alert, {
          atMs,
          from,
          to: level,
          reason: "现场复测数值仍越限，等级升高",
          trigger: "recheck",
          evidenceId: evidence.id,
        });
        this.dispatchForAlert(alert, "escalation", `现场复测仍越限，告警升级为 ${level}`, atMs);
      } else {
        this.dispatchForAlert(alert, "recheck_failed", `现场复测仍越限（${alert.severity}），请继续处置`, atMs);
      }
    }
    await this.store.flush();
    return this.alertView(alert, atMs);
  }

  async close(id, body = {}, atMs = this.now()) {
    const alert = this.getAlertOrThrow(id);
    if (alert.status === "closed") throw httpError(409, "告警已关闭");
    const allowed = new Set(["resolved", "false_alarm", "maintenance", "other"]);
    const resolution = body.resolution ?? "resolved";
    if (!allowed.has(resolution)) throw httpError(400, `非法关闭原因: ${resolution}`);
    if (resolution === "resolved" && alert.rechecks.length === 0 && body.force !== true) {
      throw httpError(409, "resolved 关闭需要先提交现场复测证据（或显式 force）");
    }
    alert.status = "closed";
    alert.closedAtMs = atMs;
    alert.updatedAtMs = atMs;
    alert.closure = {
      resolution,
      operator: body.operator ?? null,
      note: body.note ?? null,
      requiredRecheck: resolution === "resolved",
    };
    alert.events.push({ type: "closed", atMs, operator: body.operator ?? null, detail: alert.closure });
    this.dispatchForAlert(alert, "closed", `告警已关闭（${resolution}）`, atMs);
    await this.store.flush();
    return this.alertView(alert, atMs);
  }

  // ---------- 定时检查（重启后按原截止时间补跑） ----------

  /**
   * 执行一次到期检查：超时升级、复测超时升级、恢复自动关闭、到期通知发送。
   * 由调度器周期性调用；进程重启后首次 tick 会立即处理所有已过期的截止项。
   */
  async runDueChecks(atMs = this.now()) {
    const actions = { escalations: [], autoClosed: [], notifications: [] };
    for (const alert of [...this.state.alerts]) {
      if (alert.status === "closed") continue;
      this.checkConfirmTimeout(alert, atMs, actions);
      this.checkHighSensitivityAction(alert, atMs, actions);
      this.checkRecheckTimeout(alert, atMs, actions);
      this.checkAutoClose(alert, atMs, actions);
    }
    actions.notifications = await this.sendDueNotifications(atMs);
    if (
      actions.escalations.length > 0 ||
      actions.autoClosed.length > 0 ||
      actions.notifications.length > 0
    ) {
      await this.store.flush();
    }
    return actions;
  }

  confirmTimeoutMs(alert) {
    return alert.severity === "critical" || alert.sensitivity === "critical"
      ? this.config.alerting.criticalConfirmTimeoutMs
      : this.config.alerting.confirmTimeoutMs;
  }

  checkConfirmTimeout(alert, atMs, actions) {
    if (alert.status !== "open") return;
    const timeoutMs = this.confirmTimeoutMs(alert);
    const deadlineMs = (alert.lastEscalationAtMs ?? alert.openedAtMs) + timeoutMs;
    if (atMs < deadlineMs) return;
    if (alert.escalationsCount >= this.config.alerting.maxEscalations) return;
    const from = alert.severity;
    const to = bumpSeverity(from);
    if (to === from) return;
    alert.severity = to;
    this.recordEscalation(alert, {
      atMs,
      from,
      to,
      reason: `超过 ${Math.round(timeoutMs / 60000)} 分钟无人确认，自动升级（${from} → ${to}）`,
      trigger: "confirm_timeout",
      deadlineMs,
      timeoutMs,
    });
    const duty = rosterAssignee(this.config, deadlineMs, alert.zone);
    this.dispatchForAlert(
      alert,
      "escalation",
      `无人确认超时，告警升级为 ${to}${duty ? `（当班：${duty}）` : ""}`,
      atMs,
    );
    actions.escalations.push({ alertId: alert.id, from, to, reason: alert.escalations.at(-1).reason });
  }

  checkHighSensitivityAction(alert, atMs, actions) {
    if (alert.status !== "acknowledged") return;
    if (alert.sensitivity !== "high" && alert.sensitivity !== "critical") return;
    const base = alert.acknowledgedAtMs ?? alert.openedAtMs;
    const timeoutMs = this.config.alerting.highSensitivityEscalationMs;
    const deadlineMs = base + timeoutMs;
    if (atMs < deadlineMs) return;
    if (alert.escalationsCount >= this.config.alerting.maxEscalations) return;
    const from = alert.severity;
    const to = bumpSeverity(from);
    if (to === from) return;
    alert.severity = to;
    this.recordEscalation(alert, {
      atMs,
      from,
      to,
      reason: `高敏感分区确认后 ${Math.round(timeoutMs / 60000)} 分钟内未提交现场复测，升级（${from} → ${to}）`,
      trigger: "action_timeout",
      deadlineMs,
      timeoutMs,
    });
    this.dispatchForAlert(alert, "escalation", `确认后久未现场复测，告警升级为 ${to}`, atMs);
    actions.escalations.push({ alertId: alert.id, from, to, reason: alert.escalations.at(-1).reason });
  }

  checkRecheckTimeout(alert, atMs, actions) {
    if (alert.status !== "recheck") return;
    const latest = alert.rechecks.at(-1);
    if (!latest || latest.escalated) return;
    const timeoutMs = this.config.alerting.recheckVerifyTimeoutMs;
    const deadlineMs = latest.atMs + timeoutMs;
    if (atMs < deadlineMs) return;
    // 到达闭环截止时间：无论复测是否合规，未闭环即升级或催办。
    latest.escalated = true;
    if (alert.escalationsCount >= this.config.alerting.maxEscalations) {
      this.dispatchForAlert(alert, "recheck_overdue", "复测后超过闭环时限仍未关闭，请立即处置", atMs);
      return;
    }
    const from = alert.severity;
    const to = bumpSeverity(from);
    if (to === from) {
      this.dispatchForAlert(alert, "recheck_overdue", "已达最高等级，复测后超时未闭环，请立即处置", atMs);
      return;
    }
    alert.severity = to;
    this.recordEscalation(alert, {
      atMs,
      from,
      to,
      reason: `现场复测提交后 ${Math.round(timeoutMs / 60000)} 分钟未闭环，升级（${from} → ${to}）`,
      trigger: "recheck_timeout",
      deadlineMs,
      timeoutMs,
      evidenceId: latest.id,
    });
    this.dispatchForAlert(alert, "escalation", `复测后超时未闭环，告警升级为 ${to}`, atMs);
    actions.escalations.push({ alertId: alert.id, from, to, reason: alert.escalations.at(-1).reason });
  }

  checkAutoClose(alert, atMs, actions) {
    if (alert.firstOkAtMs === null) return;
    const graceMs = this.config.alerting.autoCloseGraceMs;
    if (atMs < alert.lastExceedAtMs + graceMs) return;
    alert.status = "closed";
    alert.closedAtMs = atMs;
    alert.updatedAtMs = atMs;
    alert.closure = {
      resolution: "auto_recovered",
      operator: null,
      note: "末次越限后持续恢复超过宽限期，系统自动关闭；短期内再次越限将重开本告警",
      requiredRecheck: false,
    };
    alert.events.push({ type: "auto_closed", atMs, detail: alert.closure });
    this.dispatchForAlert(alert, "closed_auto", "环境持续恢复，告警自动关闭", atMs);
    actions.autoClosed.push(alert.id);
  }

  /** 告警自动关闭后短期内再次越限：重开同一告警，保证告警期间数据连续。 */
  reopenIfRecent(key, atMs) {
    const dedupeMs = this.config.alerting.dedupeWindowMs;
    for (let i = this.state.alerts.length - 1; i >= 0; i--) {
      const candidate = this.state.alerts[i];
      if (candidate.key !== key || candidate.status !== "closed") continue;
      if (candidate.closure?.resolution !== "auto_recovered") return null;
      if (atMs - candidate.closedAtMs > dedupeMs) return null;
      candidate.status = "open";
      candidate.closedAtMs = null;
      candidate.closure = null;
      candidate.updatedAtMs = atMs;
      candidate.events.push({ type: "reopened", atMs, detail: { reason: "自动关闭后短期内再次越限" } });
      this.dispatchForAlert(candidate, "reopened", "告警在去重窗口内再次越限，已重开", atMs);
      return candidate;
    }
    return null;
  }

  // ---------- 通知 ----------

  dispatchForAlert(alert, kind, reason, atMs, contactsOverride = null) {
    const zone = this.config.zones.get(alert.zone);
    const contacts = contactsOverride ?? matchingContacts(this.config, zone, atMs).contacts;
    // 不同目标等级的升级短信各自独立，避免被同一 kind 的去重键吞掉。
    const dedupeQualifier = kind === "escalation" ? `:${alert.severity}` : "";
    return createNotifications({
      state: this.state,
      store: this.store,
      config: this.config,
      alert,
      kind,
      reason,
      atMs,
      contacts,
      dedupeQualifier,
    });
  }

  async sendDueNotifications(atMs = this.now()) {
    const sent = [];
    for (const notification of this.state.notifications) {
      if (notification.status !== "pending") continue;
      if (notification.notBeforeMs > atMs) continue;
      const sender = this.config.sender;
      const attempt = { atMs };
      try {
        if (!sender) throw new Error("未配置通知发送器");
        const result = await sender.send(notification, atMs);
        notification.status = result?.status === "failed" ? "failed" : "sent";
        notification.sentAtMs = atMs;
        attempt.result = notification.status;
        if (result?.detail) attempt.detail = result.detail;
        sent.push({ id: notification.id, alertId: notification.alertId, status: notification.status });
      } catch (error) {
        attempt.result = "failed";
        attempt.error = error.message;
        notification.attempts.push(attempt);
        // 失败也落盘：重试退避截止时间（notBefore）必须跨重启保留。
        await this.store.flush();
        if (notification.attempts.length >= 5) {
          notification.status = "failed_permanent";
        } else {
          notification.notBeforeMs = atMs + 60_000 * notification.attempts.length;
        }
        await this.store.flush();
        continue;
      }
      notification.attempts.push(attempt);
    }
    return sent;
  }

  // ---------- 时钟异常汇总 ----------

  collectClockAnomaly(reading) {
    if (!reading.clock.flagged && !reading.clock.uncalibrated && !reading.clock.calibrationStale) return [];
    return [
      {
        sensorId: reading.sensorId,
        status: reading.clock.status,
        offsetMs: reading.clock.offsetMs,
        deviationMs: reading.clock.deviationMs,
        toleranceMs: reading.clock.toleranceMs,
        uncalibrated: reading.clock.uncalibrated,
        calibrationStale: reading.clock.calibrationStale,
        firstAtMs: reading.collectedAtMs,
        lastAtMs: reading.collectedAtMs,
      },
    ];
  }

  mergeClockAnomaly(list, reading) {
    const c = reading.clock;
    if (!c.flagged && !c.uncalibrated && !c.calibrationStale) return;
    const existing = list.find((x) => x.sensorId === reading.sensorId && x.status === c.status);
    if (existing) {
      existing.firstAtMs = Math.min(existing.firstAtMs, reading.collectedAtMs);
      existing.lastAtMs = Math.max(existing.lastAtMs, reading.collectedAtMs);
      existing.count = (existing.count ?? 1) + 1;
    } else {
      list.push({
        sensorId: reading.sensorId,
        status: c.status,
        offsetMs: c.offsetMs,
        deviationMs: c.deviationMs,
        toleranceMs: c.toleranceMs,
        uncalibrated: c.uncalibrated,
        calibrationStale: c.calibrationStale,
        firstAtMs: reading.collectedAtMs,
        lastAtMs: reading.collectedAtMs,
        count: 1,
      });
    }
  }

  recordEscalation(alert, entry) {
    alert.escalationsCount += 1;
    // 补传历史读数还原出的升级不重置实时处置截止锚点，否则会立刻误触发超时升级。
    if (!entry.notificationSuppressed) alert.lastEscalationAtMs = entry.atMs;
    alert.escalations.push(entry);
    alert.events.push({
      type: "escalated",
      atMs: entry.atMs,
      detail: { from: entry.from, to: entry.to, reason: entry.reason, trigger: entry.trigger },
    });
  }

  // ---------- 查询视图 ----------

  listAlerts({ status = "all" } = {}) {
    const atMs = this.now();
    let rows = this.state.alerts;
    if (status === "active") rows = rows.filter((a) => a.status !== "closed");
    else if (status !== "all") rows = rows.filter((a) => a.status === status);
    return rows.map((a) => this.alertView(a, atMs));
  }

  /** 当前未闭环风险：按风险等级排序，包含超时原因、当班信息与时钟异常。 */
  openRisks() {
    const atMs = this.now();
    return this.state.alerts
      .filter((a) => a.status !== "closed")
      .map((a) => this.alertView(a, atMs))
      .sort(compareRisk);
  }

  alertView(alert, atMs = this.now()) {
    const zone = this.config.zones.get(alert.zone);
    const pendingDeadline = this.pendingDeadline(alert);
    return {
      id: alert.id,
      zone: alert.zone,
      zoneName: alert.zoneName,
      sensitivity: alert.sensitivity,
      metric: alert.metric,
      unit: zone.metrics[alert.metric].unit,
      status: alert.status,
      severity: alert.severity,
      sensorIds: alert.sensorIds,
      assignee: alert.assignee,
      window: {
        firstExceedAt: iso(alert.firstExceedAtMs),
        openedAt: iso(alert.openedAtMs),
        lastExceedAt: iso(alert.lastExceedAtMs),
        lastReadingAt: iso(alert.lastReadingAtMs),
        closedAt: alert.closedAtMs ? iso(alert.closedAtMs) : null,
        durationMs: (alert.closedAtMs ?? atMs) - alert.firstExceedAtMs,
      },
      duty: {
        atOpen: alert.dutyAtOpen ?? null,
        current: rosterAssignee(this.config, atMs, alert.zone),
      },
      acknowledgedAt: alert.acknowledgedAtMs ? iso(alert.acknowledgedAtMs) : null,
      acknowledgedBy: alert.acknowledgedBy,
      recheckAt: alert.recheckAtMs ? iso(alert.recheckAtMs) : null,
      closure: alert.closure,
      clockAnomalies: alert.clockAnomalies.map(({ firstAtMs, lastAtMs, ...rest }) => ({
        ...rest,
        firstAt: iso(firstAtMs),
        lastAt: iso(lastAtMs),
      })),
      escalations: alert.escalations.map((e) => ({
        at: iso(e.atMs),
        from: e.from,
        to: e.to,
        reason: e.reason,
        trigger: e.trigger,
        deadline: e.deadlineMs ? iso(e.deadlineMs) : null,
        evidenceId: e.evidenceId ?? null,
      })),
      rechecks: alert.rechecks.map((r) => ({
        id: r.id,
        at: iso(r.atMs),
        measuredAt: iso(r.measuredAtMs),
        operator: r.operator,
        measurements: r.measurements,
        conforming: r.conforming,
        method: r.method,
        note: r.note,
      })),
      nextDeadline: pendingDeadline ? iso(pendingDeadline) : null,
      readingCount: alert.readings.length,
      latestReading: readingView(
        alert.readings.reduce((latest, r) =>
          !latest || r.collectedAtMs > latest.collectedAtMs ? r : latest,
        null),
      ),
      events: alert.events.map((e) => ({
        type: e.type,
        at: iso(e.atMs),
        operator: e.operator ?? null,
        detail: e.detail ?? null,
        note: e.note ?? null,
      })),
    };
  }

  alertDetail(id) {
    const alert = this.getAlertOrThrow(id);
    const view = this.alertView(alert, this.now());
    view.readings = alert.readings.map(readingView);
    view.notifications = this.state.notifications
      .filter((n) => n.alertId === id)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        severity: n.severity,
        reason: n.reason,
        contactId: n.contactId,
        contactName: n.contactName,
        channel: n.channel,
        target: n.target,
        createdAt: iso(n.createdAtMs),
        notBefore: iso(n.notBeforeMs),
        deferredBySilence: n.deferredBySilence,
        status: n.status,
        sentAt: n.sentAtMs ? iso(n.sentAtMs) : null,
        attempts: n.attempts,
      }));
    return view;
  }

  pendingDeadline(alert) {
    if (alert.status === "closed") return null;
    const candidates = [];
    if (alert.status === "open") {
      candidates.push((alert.lastEscalationAtMs ?? alert.openedAtMs) + this.confirmTimeoutMs(alert));
    }
    if (alert.status === "acknowledged" && (alert.sensitivity === "high" || alert.sensitivity === "critical")) {
      candidates.push((alert.acknowledgedAtMs ?? alert.openedAtMs) + this.config.alerting.highSensitivityEscalationMs);
    }
    if (alert.status === "recheck") {
      const latest = alert.rechecks.at(-1);
      if (latest && !latest.escalated) candidates.push(latest.atMs + this.config.alerting.recheckVerifyTimeoutMs);
    }
    if (alert.firstOkAtMs !== null) candidates.push(alert.lastExceedAtMs + this.config.alerting.autoCloseGraceMs);
    for (const n of this.state.notifications) {
      if (n.alertId === alert.id && n.status === "pending") candidates.push(n.notBeforeMs);
    }
    return candidates.length ? Math.min(...candidates) : null;
  }
}

function readingView(r) {
  return {
    readingId: r.readingId,
    sensorId: r.sensorId,
    metric: r.metric,
    value: r.value,
    level: r.level,
    collectedAt: iso(r.collectedAtMs),
    deviceTime: iso(r.deviceTimeMs),
    arrivalAt: iso(r.arrivalMs),
    clockStatus: r.clock.status,
    clockOffsetMs: r.clock.offsetMs,
    clockDeviationMs: r.clock.deviationMs,
  };
}

function compareRisk(a, b) {
  const severity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (severity !== 0) return severity;
  const sensW = { critical: 3, high: 2, medium: 1 };
  const sens = (sensW[b.sensitivity] ?? 0) - (sensW[a.sensitivity] ?? 0);
  if (sens !== 0) return sens;
  return a.window.firstExceedAt.localeCompare(b.window.firstExceedAt);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
