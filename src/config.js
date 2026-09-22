import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "reference",
  "environment.json",
);

export function loadConfig(configPath = process.env.ENV_CONFIG ?? DEFAULT_CONFIG_PATH) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const sensors = new Map(raw.sensors.map((sensor) => [sensor.deviceId, sensor]));
  const zones = new Map(raw.zones.map((zone) => [zone.id, zone]));
  const calibrationByDevice = new Map();
  for (const record of raw.calibration ?? []) {
    const list = calibrationByDevice.get(record.deviceId) ?? [];
    list.push(record);
    calibrationByDevice.set(record.deviceId, list);
  }
  for (const list of calibrationByDevice.values()) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  return {
    timezone: raw.timezone ?? "Asia/Shanghai",
    maxClockSkewSeconds: raw.maxClockSkewSeconds ?? 300,
    backfillGraceSeconds: raw.backfillGraceSeconds ?? 120,
    sensors,
    zones,
    contacts: raw.contacts ?? [],
    calibrationByDevice,
  };
}

export function getSensor(config, deviceId) {
  const sensor = config.sensors.get(deviceId);
  if (!sensor) return null;
  return sensor;
}

export function getZone(config, sensor) {
  return config.zones.get(sensor.zoneId) ?? null;
}

// 取读数时刻之前最近一次已生效的校准记录。
export function calibrationAt(config, deviceId, atMs) {
  const list = config.calibrationByDevice.get(deviceId) ?? [];
  let current = null;
  for (const record of list) {
    if (Date.parse(record.at) <= atMs && record.status === "applied") current = record;
  }
  return current;
}

export function latestCalibration(config, deviceId) {
  const list = config.calibrationByDevice.get(deviceId) ?? [];
  return list.length ? list[list.length - 1] : null;
}

// 按 分区 + 敏感等级 取阈值。metric: temperature | humidity
export function resolveThreshold(zone, sensitivity, metric) {
  const table = zone.thresholds?.[metric]?.[sensitivity];
  if (!table) return null;
  return table;
}
