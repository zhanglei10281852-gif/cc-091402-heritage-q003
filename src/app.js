import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { MonitoringEngine, Notifier } from "./engine.js";
import { badRequest, HttpError } from "./errors.js";
import { Scheduler } from "./scheduler.js";
import { serializeAlert, serializeNotification, serializeReading } from "./serializers.js";
import { JsonlStore } from "./store.js";
import { parseTime } from "./time.js";

const JSON_LIMIT = 1_048_576;

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > JSON_LIMIT) throw badRequest("请求体过大");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function matchPath(pathname, pattern) {
  const a = pathname.split("/").filter(Boolean);
  const b = pattern.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (b[i].startsWith(":")) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (b[i] !== a[i]) return null;
  }
  return params;
}

export function createApp(deps = {}) {
  const config = deps.config ?? loadConfig();
  const store = deps.store ?? new JsonlStore(process.env.DATA_FILE ?? ".data/events.jsonl").load();
  const notifier = deps.notifier ?? new Notifier();
  const engine = deps.engine ?? new MonitoringEngine({ config, store, notifier });

  const detail = (alertId, { includeReadings = false } = {}) => {
    const alert = store.getAlert(alertId);
    if (!alert) return null;
    const notifications = store
      .listNotifications()
      .filter((n) => n.alertId === alert.id);
    const readings = includeReadings
      ? alert.readingIds.map((id) => store.readings.get(id)).filter(Boolean)
      : [];
    return serializeAlert(alert, { timezone: config.timezone, readings, notifications });
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const { pathname } = url;
    try {
      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "heritage-environment-monitor" });
        return;
      }

      // ---- 读数接入 ----
      if (request.method === "POST" && pathname === "/api/v1/readings") {
        const input = await readJson(request);
        const result = engine.ingestReading(input);
        sendJson(response, 202, {
          duplicated: result.duplicated,
          notificationsSent: result.sent,
          reading: serializeReading(result.reading, config.timezone),
          alert: result.alert ? detail(result.alert.id) : null,
          clockDriftFlagged: result.reading.flaggedClockDrift,
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/readings/batch") {
        const list = await readJson(request);
        const result = engine.ingestBatch(list);
        sendJson(response, 202, result);
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/readings") {
        const filter = {};
        if (url.searchParams.get("deviceId")) filter.deviceId = url.searchParams.get("deviceId");
        if (url.searchParams.get("from")) {
          filter.from = parseTime(url.searchParams.get("from"), config.timezone, "from");
        }
        if (url.searchParams.get("to")) {
          filter.to = parseTime(url.searchParams.get("to"), config.timezone, "to");
        }
        const readings = store.listReadings(filter);
        sendJson(response, 200, {
          count: readings.length,
          readings: readings.map((r) => serializeReading(r, config.timezone)),
        });
        return;
      }

      // ---- 当前未闭环风险 ----
      if (request.method === "GET" && (pathname === "/api/v1/risks" || pathname === "/api/v1/alerts")) {
        const statusFilter = url.searchParams.get("status") ?? (pathname === "/api/v1/risks" ? "active" : "all");
        let alerts = store.listAlerts();
        if (statusFilter === "active") alerts = alerts.filter((a) => a.status !== "closed");
        else if (statusFilter !== "all") alerts = alerts.filter((a) => a.status === statusFilter);
        sendJson(response, 200, {
          count: alerts.length,
          alerts: alerts.map((a) => detail(a.id)),
        });
        return;
      }

      const alertMatch = matchPath(pathname, "/api/v1/alerts/:id/:action");
      const alertOnly = !alertMatch && matchPath(pathname, "/api/v1/alerts/:id");
      if (request.method === "GET" && alertOnly) {
        const { id } = matchPath(pathname, "/api/v1/alerts/:id");
        const alert = detail(id, { includeReadings: true });
        if (!alert) throw new HttpError(404, "not_found", `告警不存在: ${id}`);
        sendJson(response, 200, alert);
        return;
      }

      if (request.method === "POST" && alertMatch) {
        const { id, action } = alertMatch;
        const body = await readJson(request);
        let alert;
        switch (action) {
          case "acknowledge":
            alert = engine.acknowledge(id, body.by);
            break;
          case "assign":
            alert = engine.assign(id, body);
            break;
          case "rechecks":
            alert = engine.addRecheck(id, body);
            break;
          case "close":
            alert = engine.close(id, body);
            break;
          default:
            throw new HttpError(404, "not_found", `未知操作: ${action}`);
        }
        sendJson(response, 200, detail(alert.id, { includeReadings: true }));
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/checks/run") {
        sendJson(response, 200, engine.runScheduledChecks());
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/notifications") {
        let notifications = store.listNotifications();
        const statusFilter = url.searchParams.get("status");
        if (statusFilter) notifications = notifications.filter((n) => n.status === statusFilter);
        sendJson(response, 200, {
          count: notifications.length,
          notifications: notifications.map(serializeNotification),
        });
        return;
      }

      throw new HttpError(404, "not_found", "路由不存在");
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, {
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      } else {
        console.error(error);
        sendJson(response, 500, { error: "internal_error", message: error.message });
      }
    }
  });

  return { server, engine, store, config, notifier };
}
