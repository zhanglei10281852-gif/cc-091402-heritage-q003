import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MonitoringEngine, Notifier } from "../src/engine.js";
import { JsonlStore } from "../src/store.js";

export class FakeClock {
  constructor(initial = Date.now()) {
    this.current = initial;
  }
  now() {
    return this.current;
  }
  advance(ms) {
    this.current += ms;
    return this.current;
  }
  set(ms) {
    this.current = ms;
  }
}

export function makeHarness({ dataFile = null, clock = new FakeClock() } = {}) {
  const config = loadConfig();
  const store = new JsonlStore(dataFile).load();
  const messages = [];
  const sink = (notification, contacts, text) => {
    const messageId = `msg-${messages.length + 1}`;
    messages.push({ notification, contacts, text, messageId, at: clock.now() });
    return messageId;
  };
  const notifier = new Notifier({ sink });
  const engine = new MonitoringEngine({ config, store, notifier, now: () => clock.now() });
  return { config, store, engine, notifier, clock, messages, dataFile };
}

export function tmpDataFile() {
  const dir = mkdtempSync(join(tmpdir(), "env-monitor-"));
  const file = join(dir, "events.jsonl");
  after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

// HTTP 测试用应用（内存存储）
export async function startHttpApp() {
  const harness = makeHarness();
  const { server } = createApp({
    config: harness.config,
    store: harness.store,
    notifier: harness.notifier,
    engine: harness.engine,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return { ...harness, base, request: jsonRequest(base) };
}

export function jsonRequest(base) {
  return async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, body: json };
  };
}

export const MIN = 60_000;

export function reading({
  deviceId = "sensor-shuhua-01",
  at,
  deviceAt = null,
  temperature = 25,
  humidity = 70,
  batch = undefined,
}) {
  return {
    deviceId,
    collectedAt: new Date(at).toISOString(),
    deviceTime: new Date(deviceAt ?? at).toISOString(),
    temperature,
    humidity,
    ...(batch === undefined ? {} : { batch }),
  };
}
