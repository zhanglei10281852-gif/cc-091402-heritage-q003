// 时间处理统一约定：
// - 内部一律使用 epoch 毫秒（Date.now 同源），告警窗口按绝对时间计算，天然跨午夜不截断。
// - 对外传输使用带时区的 ISO 8601 字符串；设备上报若不带偏移，按配置时区解释为墙钟时间。
// - 真值基准是采集时间（采集网关戳记），设备时间仅用于计算时钟漂移。

const DAY_MS = 24 * 60 * 60 * 1000;

const PART_FIELDS = [
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
];

const formatterCache = new Map();

function partsFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function localParts(timeZone, instant) {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  const secondsOfDay = hour * 3600 + minute * 60 + second;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  // 当地当天零点对应的 epoch 毫秒（用墙钟构成的 UTC 时刻减去该瞬间的 UTC 偏移）
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMs = Date.UTC(year, month - 1, day, hour, minute, second) - instant;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    secondsOfDay,
    dayStart: wallAsUtc - offsetMs,
  };
}

function hhmmToSeconds(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`非法时刻: ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

// 判断某瞬间是否落在静默时段。end <= start 表示跨午夜（如 22:00-06:30）。
export function isInQuietHours(instant, quietHours, timeZone) {
  if (!quietHours?.enabled) return false;
  const { secondsOfDay } = localParts(timeZone, instant);
  const start = hhmmToSeconds(quietHours.start);
  const end = hhmmToSeconds(quietHours.end);
  if (end > start) return secondsOfDay >= start && secondsOfDay < end;
  // 跨午夜：当晚 start 之后 或 次日 end 之前
  return secondsOfDay >= start || secondsOfDay < end;
}

// 返回当前静默区间的结束瞬间；若不在静默时段返回 null。
export function quietHoursEnd(instant, quietHours, timeZone) {
  if (!isInQuietHours(instant, quietHours, timeZone)) return null;
  const parts = localParts(timeZone, instant);
  const end = hhmmToSeconds(quietHours.end);
  const start = hhmmToSeconds(quietHours.start);
  const endOfToday = parts.dayStart + end * 1000;
  if (end > start) return endOfToday;
  // 跨午夜且当前位于 start 之后，结束点在次日；当前位于凌晨段时结束点即当天 end。
  return parts.secondsOfDay >= start ? endOfToday + DAY_MS : endOfToday;
}

export function nextQuietHoursEnd(instant, quietHours, timeZone) {
  return quietHoursEnd(instant, quietHours, timeZone);
}

// 解析时间字符串。带偏移或 Z 的按绝对时间解析；不带偏移的按配置时区解释为墙钟时间。
export function parseTime(value, timeZone, field = "时间") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field}必须是 ISO 8601 字符串`);
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`${field}无法解析: ${value}`);
    return ms;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
  if (!match) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`${field}无法解析: ${value}`);
    return ms;
  }
  const [, y, mo, d, h, mi, s] = match;
  // 先用 UTC 猜测，再用该瞬间的时区偏移反推，迭代一次消除 DST 边界误差。
  let guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const offsetAt = (instant) => {
    const p = localParts(timeZone, instant);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
  };
  let instant = guess - offsetAt(guess);
  instant = guess - offsetAt(instant);
  return instant;
}

export function formatLocal(timeZone, instant) {
  const p = localParts(timeZone, instant);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function durationMinutes(from, to) {
  return Math.max(0, Math.round((to - from) / 60000));
}
