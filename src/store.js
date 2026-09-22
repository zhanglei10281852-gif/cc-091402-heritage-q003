import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// 极简 JSONL 事件存储：所有状态变更先追加日志再进入内存，进程重启后逐条重放恢复。
// 告警、通知均以完整快照写入，读取侧无需理解历史结构即可重建。
export class JsonlStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.readings = new Map();
    this.alerts = new Map();
    this.activeAlerts = new Map(); // `${zoneId}:${sensitivity}` -> 未闭环告警
    this.notifications = new Map();
    this.seq = 0;
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return this;
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed);
      this._apply(event);
      this.seq = Math.max(this.seq, event.seq ?? 0);
    }
    return this;
  }

  _apply(event) {
    switch (event.type) {
      case "reading":
        this.readings.set(event.reading.id, event.reading);
        break;
      case "alert":
        this.alerts.set(event.alert.id, event.alert);
        if (event.alert.status === "closed") {
          this.activeAlerts.delete(activeKey(event.alert));
        } else {
          this.activeAlerts.set(activeKey(event.alert), event.alert.id);
        }
        break;
      case "notification":
        this.notifications.set(event.notification.id, event.notification);
        break;
      default:
        throw new Error(`未知事件类型: ${event.type}`);
    }
  }

  _record(type, payload) {
    this.seq += 1;
    const event = { seq: this.seq, at: new Date().toISOString(), type, ...payload };
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    }
    this._apply(event);
    return event;
  }

  putReading(reading) {
    if (this.readings.has(reading.id)) return reading;
    this._record("reading", { reading });
    return reading;
  }

  putAlert(alert) {
    this._record("alert", { alert });
    return alert;
  }

  putNotification(notification) {
    this._record("notification", { notification });
    return notification;
  }

  getActiveAlert(zoneId, sensitivity) {
    const id = this.activeAlerts.get(`${zoneId}:${sensitivity}`);
    return id ? this.alerts.get(id) : null;
  }

  getAlert(id) {
    return this.alerts.get(id) ?? null;
  }

  listAlerts() {
    return [...this.alerts.values()].sort((a, b) => a.openedAt - b.openedAt);
  }

  listNotifications() {
    return [...this.notifications.values()].sort((a, b) => a.dueAt - b.dueAt);
  }

  listReadings({ deviceId, from, to } = {}) {
    return [...this.readings.values()]
      .filter((r) => {
        if (deviceId && r.deviceId !== deviceId) return false;
        if (from !== undefined && r.collectedAt < from) return false;
        if (to !== undefined && r.collectedAt > to) return false;
        return true;
      })
      .sort((a, b) => a.collectedAt - b.collectedAt);
  }
}

export function activeKey(alert) {
  return `${alert.zoneId}:${alert.sensitivity}`;
}
