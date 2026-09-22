// 通知策略：联系人匹配（分区 + 文物敏感等级 + 值班时段）、静默时段处理、通知去重。
// 静默时段不阻断告警生成，只把通知的最早发送时间（notBefore）推迟到窗口结束；
// 所有截止时间都是绝对瞬间，重启后仍按原截止时间处理。
import { evaluateRecurringWindow, parseHHMM, wallTimeToInstant, ymdKey, DAY_MS } from "./time.js";

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedDayParts(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: WEEKDAY_MAP[map.weekday],
  };
}

/** 判断某一瞬间是否落在联系人的周期值班时段内（支持跨午夜，凌晨归属前一日班次）。 */
function withinContactSchedule(schedule, atMs, timeZone) {
  const parts = zonedDayParts(atMs, timeZone);
  const startMin = parseHHMM(schedule.start);
  const endMin = parseHHMM(schedule.end);
  const crossMidnight = endMin <= startMin;
  const durationMin = (endMin - startMin + (crossMidnight ? 1440 : 0)) * 60_000;
  const candidates = [[0, parts.weekday]];
  if (crossMidnight) candidates.push([-1, (parts.weekday + 6) % 7]);
  for (const [dayOffset, weekday] of candidates) {
    if (!schedule.nights.includes(weekday)) continue;
    const shiftStart =
      wallTimeToInstant(timeZone, parts.year, parts.month, parts.day, 0, 0) +
      dayOffset * DAY_MS +
      startMin * 60_000;
    if (atMs >= shiftStart && atMs < shiftStart + durationMin) return true;
  }
  return false;
}

/** 匹配分区与文物敏感等级的联系人，值班表在岗者排最前。 */
export function matchingContacts(config, zone, atMs) {
  const onDuty = rosterAssignee(config, atMs, zone.zone);
  const contacts = [];
  for (const contact of config.contacts.values()) {
    if (!contact.zones.includes(zone.zone)) continue;
    if (!contact.sensitivity.includes(zone.sensitivity)) continue;
    if (contact.schedule && !withinContactSchedule(contact.schedule, atMs, config.timezone)) continue;
    contacts.push(contact);
  }
  contacts.sort((a, b) => {
    if (a.id === onDuty) return -1;
    if (b.id === onDuty) return 1;
    return a.id.localeCompare(b.id);
  });
  return { contacts, onDuty };
}

/** 查值班表：某一瞬间某分区在岗联系人 ID（支持跨午夜班次）。 */
export function rosterAssignee(config, atMs, zoneId) {
  const tz = config.timezone;
  const parts = zonedDayParts(atMs, tz);
  // 跨午夜班次登记在起始日，所以要同时查当天与前一天的排班。
  for (const dayOffset of [0, -1]) {
    const midnight = wallTimeToInstant(tz, parts.year, parts.month, parts.day, 0, 0) + dayOffset * DAY_MS;
    const dateKey = ymdKey(midnight, tz);
    for (const row of config.roster) {
      if (row.zone !== zoneId || row.date !== dateKey) continue;
      for (const shift of row.shifts) {
        const startMin = parseHHMM(shift.start);
        const endMin = parseHHMM(shift.end);
        const cross = shift.crossMidnight === true || endMin <= startMin;
        const durationMin = (endMin - startMin + (cross ? 1440 : 0)) * 60_000;
        const shiftStart = midnight + startMin * 60_000;
        if (atMs >= shiftStart && atMs < shiftStart + durationMin) return shift.assignee;
      }
    }
  }
  return null;
}

/** 计算某一瞬间触发的通知应延后到何时（静默时段结束），未命中静默返回 null。 */
export function silenceUntil(zone, atMs, timeZone) {
  let latestEnd = null;
  for (const win of zone.silenceWindows ?? []) {
    const { covered, untilMs } = evaluateRecurringWindow(
      atMs,
      parseHHMM(win.start),
      parseHHMM(win.end),
      timeZone,
    );
    if (covered && (latestEnd === null || untilMs > latestEnd)) latestEnd = untilMs;
  }
  return latestEnd;
}

/**
 * 为一次告警事件创建通知（去重：同一告警 + 事件类型 + 联系人 + 通道只发一次）。
 * 补传旧读数不会重新触发 open 事件（告警已存在），天然不重放。
 */
export function createNotifications({ state, store, config, alert, kind, reason, atMs, contacts, dedupeQualifier = "" }) {
  const created = [];
  for (const contact of contacts) {
    for (const channel of contact.channels) {
      const dedupeKey = `${alert.id}|${kind}${dedupeQualifier}|${contact.id}|${channel.type}`;
      if (state.notifications.some((n) => n.dedupeKey === dedupeKey && n.status !== "failed")) {
        continue;
      }
      const until = silenceUntil(config.zones.get(alert.zone), atMs, config.timezone);
      const notification = {
        id: store.nextId("ntf"),
        alertId: alert.id,
        contactId: contact.id,
        contactName: contact.name,
        channel: channel.type,
        target: channel.target,
        kind,
        severity: alert.severity,
        reason,
        createdAtMs: atMs,
        notBeforeMs: until ?? atMs,
        deferredBySilence: until !== null,
        attempts: [],
        status: "pending",
        sentAtMs: null,
        dedupeKey,
      };
      state.notifications.push(notification);
      created.push(notification);
    }
  }
  return created;
}
