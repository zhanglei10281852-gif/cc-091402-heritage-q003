// 时间与时钟漂移工具。所有业务判定一律使用可信的采集时间（collectedAt），
// 设备时间（deviceTime）只用于评估时钟漂移，不参与排序和告警窗口计算。

export const SEVERITY_ORDER = Object.freeze({ ok: 0, warn: 1, critical: 2, emergency: 3 });

export function bumpSeverity(severity) {
  if (severity === "warn") return "critical";
  if (severity === "critical") return "emergency";
  return "emergency";
}

/** 解析带时区的 ISO 8601 字符串，非法时间抛出错误。 */
export function parseInstant(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须是 ISO 8601 字符串`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${field} 不是合法时间: ${value}`);
  return ms;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

const tzFormatterCache = new Map();

function formatter(timeZone) {
  let dtf = tzFormatterCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    tzFormatterCache.set(timeZone, dtf);
  }
  return dtf;
}

/** 取某一瞬间在指定时区的墙上时间分量。hour12:false 下午夜可能返回 "24"。 */
export function zonedParts(instantMs, timeZone) {
  const parts = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  const hour = Number.parseInt(parts.hour, 10) % 24;
  return {
    year: Number.parseInt(parts.year, 10),
    month: Number.parseInt(parts.month, 10),
    day: Number.parseInt(parts.day, 10),
    hour,
    minute: Number.parseInt(parts.minute, 10),
    second: Number.parseInt(parts.second, 10),
  };
}

/** 指定时区相对 UTC 的偏移（毫秒）。 */
export function tzOffsetMs(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instantMs;
}

/** 把指定时区的墙上时间换算为 epoch 毫秒（自动处理夏令时边界，国内时区无 DST）。 */
export function wallTimeToInstant(timeZone, year, month, day, hour, minute, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const instant = guess - tzOffsetMs(guess, timeZone);
  const p = zonedParts(instant, timeZone);
  if (p.hour !== hour || p.minute !== minute || p.day !== day) {
    return guess - tzOffsetMs(instant, timeZone);
  }
  return instant;
}

export function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`时间窗格式应为 HH:MM: ${value}`);
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour > 23 || minute > 59) throw new Error(`时间窗越界: ${value}`);
  return hour * 60 + minute;
}

/** 本地时区日历日键，例如 2026-09-21，用于值班表匹配。 */
export function ymdKey(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** 本地时区一天中的分钟数（0–1439）。 */
export function wallMinutes(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone);
  return p.hour * 60 + p.minute;
}

export const DAY_MS = 86_400_000;

/**
 * 判断跨午夜周期时间窗（如 23:00–06:00）是否覆盖某一瞬间。
 * 返回 { covered, untilMs }，untilMs 为窗口结束瞬间（用于延后通知）。
 */
export function evaluateRecurringWindow(instantMs, startMinutes, endMinutes, timeZone) {
  const durationMs = ((endMinutes - startMinutes + 1440) % 1440) * 60_000;
  if (durationMs === 0) return { covered: false, untilMs: null };
  const p = zonedParts(instantMs, timeZone);
  const todayStart = wallTimeToInstant(timeZone, p.year, p.month, p.day, 0, 0, 0) + startMinutes * 60_000;
  for (const start of [todayStart, todayStart - DAY_MS]) {
    const end = start + durationMs;
    if (instantMs >= start && instantMs < end) return { covered: true, untilMs: end };
  }
  return { covered: false, untilMs: null };
}

/**
 * 评估设备时钟漂移。
 * offsetMs = deviceTime - collectedAt（正数表示设备时钟快）。
 * 校准记录给出校准时的已知偏移与允差；无校准时按默认允差判定并标记 uncalibrated。
 */
export function evaluateClock({ deviceTimeMs, collectedAtMs, calibration, toleranceMs, nowMs }) {
  const offsetMs = deviceTimeMs - collectedAtMs;
  const expectedOffsetMs = calibration ? calibration.clockOffsetMs : 0;
  const deviationMs = offsetMs - expectedOffsetMs;
  const absDeviationMs = Math.abs(deviationMs);
  const effectiveToleranceMs = calibration ? calibration.toleranceMs : toleranceMs;
  let status = "ok";
  if (deviationMs > effectiveToleranceMs) status = "fast";
  else if (deviationMs < -effectiveToleranceMs) status = "slow";

  let calibrationStale = false;
  if (calibration && Number.isFinite(calibration.maxAgeMs)) {
    calibrationStale = nowMs - calibration.calibratedAtMs > calibration.maxAgeMs;
  }
  return {
    deviceTime: iso(deviceTimeMs),
    collectedAt: iso(collectedAtMs),
    offsetMs,
    expectedClockOffsetMs: expectedOffsetMs,
    deviationMs,
    toleranceMs: effectiveToleranceMs,
    status,
    flagged: status !== "ok",
    uncalibrated: !calibration,
    calibrationStale,
  };
}
