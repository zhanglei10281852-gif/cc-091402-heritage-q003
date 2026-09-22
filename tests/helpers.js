// 测试公共助手：临时数据目录 + 虚拟时钟 + 可计数的假短信发送器。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServices } from "../src/bootstrap.js";
import { createApp } from "../src/app.js";

export function isoTime(value) {
  return new Date(value).toISOString();
}

/**
 * @param {string} startLocal 本地起始时间（Asia/Shanghai），例如 "2026-09-21T22:30:00+08:00"
 */
export function makeHarness(startLocal) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "heritage-test-"));
  let now = Date.parse(startLocal);
  const sentSms = [];
  const sender = {
    async send(notification) {
      sentSms.push({ id: notification.id, target: notification.target, kind: notification.kind, at: now });
      return { status: "sent" };
    },
  };
  const services = buildServices({ DATA_DIR: dataDir }, { clock: () => now, sender });

  return {
    dataDir,
    services,
    get now() {
      return now;
    },
    setNow(value) {
      now = typeof value === "number" ? value : Date.parse(value);
    },
    advance(ms) {
      now += ms;
    },
    sentSms,
    async tick() {
      return services.scheduler.tick();
    },
    async ingestReading(reading) {
      return services.engine.ingest({ readings: [reading] }, now);
    },
    async ingestBatch(readings) {
      return services.engine.ingest({ readings }, now);
    },
    cleanup() {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function startHttp(services) {
  const server = createApp(services);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 构造一条读数。deviceClockDeltaMs 表示设备时钟相对采集时间的偏差（正=快）。
 */
export function reading({
  id,
  sensor = "sensor-A-01",
  at,
  deviceClockDeltaMs = 0,
  t = 20,
  h = 55,
  batch,
}) {
  const collectedAt = typeof at === "number" ? at : Date.parse(at);
  return {
    readingId: id,
    sensorId: sensor,
    deviceTime: isoTime(collectedAt + deviceClockDeltaMs),
    collectedAt: isoTime(collectedAt),
    metrics: { temperature: t, humidity: h },
    ...(batch ? { batch } : {}),
  };
}

export const MIN = 60_000;
