import { formatLocal } from "./time.js";

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function serializeReading(reading, timezone) {
  return {
    id: reading.id,
    deviceId: reading.deviceId,
    zoneId: reading.zoneId,
    sensitivity: reading.sensitivity,
    deviceTime: iso(reading.deviceTime),
    collectedAt: iso(reading.collectedAt),
    receivedAt: iso(reading.receivedAt),
    skewMs: reading.skewMs,
    skewSeconds: Math.round(reading.skewMs / 1000),
    flaggedClockDrift: reading.flaggedClockDrift,
    backfill: reading.backfill,
    calibrationId: reading.calibrationId,
    calibrationOverdue: reading.calibrationOverdue,
    metrics: reading.metrics,
    corrected: reading.corrected,
    violations: reading.violations,
    collectedLocal: timezone ? formatLocal(timezone, reading.collectedAt) : undefined,
  };
}

export function serializeNotification(n) {
  return {
    ...n,
    dueAt: iso(n.dueAt),
    createdAt: iso(n.createdAt),
    sentAt: iso(n.sentAt),
    resumeAt: iso(n.resumeAt),
  };
}

export function serializeAlert(alert, { timezone, readings = [], notifications = [] } = {}) {
  const out = {
    ...alert,
    openedAt: iso(alert.openedAt),
    lastBreachAt: iso(alert.lastBreachAt),
    lastReadingAt: iso(alert.lastReadingAt),
    recoveredSince: iso(alert.recoveredSince),
    closedAt: iso(alert.closedAt),
    escalations: alert.escalations.map((e) => ({
      ...e,
      at: iso(e.at),
      recordedAt: iso(e.recordedAt),
    })),
    acknowledgements: alert.acknowledgements.map((a) => ({ ...a, at: iso(a.at) })),
    assignments: alert.assignments.map((a) => ({ ...a, at: iso(a.at) })),
    assignee: alert.assignee ? { ...alert.assignee, at: iso(alert.assignee.at) } : null,
    rechecks: alert.rechecks.map((r) => ({ ...r, at: iso(r.at), recordedAt: iso(r.recordedAt) })),
    clockDrift: {
      detected: alert.clockDrift.detected,
      devices: Object.fromEntries(
        Object.entries(alert.clockDrift.devices).map(([id, d]) => [
          id,
          { ...d, skewSeconds: Math.round(d.skewMs / 1000) },
        ]),
      ),
    },
    openedLocal: timezone ? formatLocal(timezone, alert.openedAt) : undefined,
  };
  if (readings.length) out.readings = readings.map((r) => serializeReading(r, timezone));
  if (notifications.length) out.notifications = notifications.map(serializeNotification);
  return out;
}
