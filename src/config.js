// 参考数据与运行时配置加载。参考数据目录与数据落盘目录均可通过环境变量覆盖，
// 测试不依赖主机隐藏状态（见 docs/domain.md）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInstant } from "./time.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env) {
  const referenceDir = env.REFERENCE_DIR
    ? path.resolve(env.REFERENCE_DIR)
    : path.join(projectRoot, "reference");
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(projectRoot, ".data");

  const readJson = (name) => JSON.parse(readFileSync(path.join(referenceDir, name), "utf8"));
  const settings = readJson("settings.json");
  const sensors = readJson("sensors.json");
  const zones = readJson("zones.json");
  const contacts = readJson("contacts.json");
  const calibrationsRaw = readJson("calibrations.json");
  const roster = readJson("roster.json");

  const zoneMap = new Map();
  for (const zone of zones) {
    if (zoneMap.has(zone.zone)) throw new Error(`分区重复: ${zone.zone}`);
    zoneMap.set(zone.zone, zone);
  }

  const sensorMap = new Map();
  for (const sensor of sensors) {
    if (sensorMap.has(sensor.id)) throw new Error(`传感器重复: ${sensor.id}`);
    if (!zoneMap.has(sensor.zone)) throw new Error(`传感器 ${sensor.id} 引用了未知分区 ${sensor.zone}`);
    sensorMap.set(sensor.id, sensor);
  }

  // 一台设备只有一条有效校准记录；校准偏移以校准时的对时结果为准。
  const calibrationMap = new Map();
  for (const cal of calibrationsRaw) {
    if (!sensorMap.has(cal.sensorId)) throw new Error(`校准记录引用了未知传感器 ${cal.sensorId}`);
    if (calibrationMap.has(cal.sensorId)) throw new Error(`传感器 ${cal.sensorId} 存在多条校准记录`);
    calibrationMap.set(cal.sensorId, {
      sensorId: cal.sensorId,
      calibratedAtMs: parseInstant(cal.calibratedAt, "calibratedAt"),
      clockOffsetMs: Number(cal.clockOffsetMs),
      toleranceMs: Number(cal.toleranceMs),
      maxAgeMs: Number(cal.maxAgeDays) * 86_400_000,
      note: cal.note ?? null,
    });
  }

  const contactMap = new Map();
  for (const contact of contacts) {
    if (contactMap.has(contact.id)) throw new Error(`联系人重复: ${contact.id}`);
    contactMap.set(contact.id, contact);
  }

  return {
    timezone: settings.timezone,
    referenceDir,
    dataDir,
    sensors: sensorMap,
    zones: zoneMap,
    contacts: contactMap,
    calibrations: calibrationMap,
    roster,
    ingest: settings.ingest,
    alerting: settings.alerting,
    httpPort: Number.parseInt(env.PORT ?? "8000", 10),
    httpHost: env.HOST ?? "0.0.0.0",
  };
}
