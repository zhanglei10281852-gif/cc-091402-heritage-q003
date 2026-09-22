// HTTP 接口层。createApp 接收已装配的引擎/调度器，便于测试注入虚拟时钟与发送器。
import { createServer } from "node:http";
import { iso } from "./time.js";

const MAX_BODY_BYTES = 5_000_000;

const STATUS_ERRORS = {
  400: "bad_request",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  422: "unprocessable",
  500: "internal_error",
};

export function createApp({ engine, config, scheduler }) {
  return createServer((request, response) => {
    handle(request, response, { engine, config, scheduler }).catch((error) => {
      const status = error.status ?? 500;
      sendJson(response, status, {
        error: status === 500 ? "internal_error" : error.code ?? STATUS_ERRORS[status] ?? "error",
        message: error.message,
      });
      if (status === 500) console.error(error);
    });
  });
}

async function handle(request, response, services) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "heritage-environment-monitor", time: iso(Date.now()) });
    return;
  }

  // 参考数据只读视图
  if (request.method === "GET" && pathname === "/reference/zones") {
    sendJson(response, 200, [...services.config.zones.values()]);
    return;
  }
  if (request.method === "GET" && pathname === "/reference/sensors") {
    sendJson(response, 200, [...services.config.sensors.values()]);
    return;
  }
  if (request.method === "GET" && pathname === "/reference/contacts") {
    sendJson(response, 200, [...services.config.contacts.values()]);
    return;
  }

  // 读数入库（单条或批量补传）
  if (request.method === "POST" && pathname === "/readings") {
    const body = await readJson(request);
    const result = await services.engine.ingest(body);
    sendJson(response, 202, result);
    return;
  }

  // 当前未闭环风险
  if (request.method === "GET" && pathname === "/risks") {
    sendJson(response, 200, { risks: services.engine.openRisks() });
    return;
  }

  if (request.method === "GET" && pathname === "/alerts") {
    const statusFilter = url.searchParams.get("status") ?? "all";
    sendJson(response, 200, { alerts: services.engine.listAlerts({ status: statusFilter }) });
    return;
  }

  const alertAction = matchAlertRoute(pathname);
  if (alertAction) {
    const { id, action } = alertAction;
    const body = ["GET"].includes(request.method) ? null : await readJson(request);
    await routeAlertAction(response, services, id, action, request.method, body);
    return;
  }

  if (request.method === "GET" && pathname === "/notifications") {
    const statusFilter = url.searchParams.get("status");
    const rows = services.engine.state.notifications
      .filter((n) => !statusFilter || n.status === statusFilter)
      .map((n) => ({
        id: n.id,
        alertId: n.alertId,
        kind: n.kind,
        severity: n.severity,
        reason: n.reason,
        contactId: n.contactId,
        contactName: n.contactName,
        channel: n.channel,
        target: n.target,
        createdAt: iso(n.createdAtMs),
        notBefore: iso(n.notBeforeMs),
        deferredBySilence: n.deferredBySilence,
        status: n.status,
        sentAt: n.sentAtMs ? iso(n.sentAtMs) : null,
        attempts: n.attempts.length,
      }));
    sendJson(response, 200, { notifications: rows });
    return;
  }

  // 管理接口：立即执行一次到期检查（生产环境也安全；主要用于演示与运维排障）
  if (request.method === "POST" && pathname === "/maintenance/tick") {
    const result = await services.scheduler.tick();
    sendJson(response, 200, { ranAt: iso(services.engine.now()), result });
    return;
  }

  sendJson(response, 404, { error: "not_found", message: `未知路径: ${pathname}` });
}

async function routeAlertAction(response, services, id, action, method, body) {
  const engine = services.engine;
  if (method === "GET" && action === null) {
    sendJson(response, 200, engine.alertDetail(id));
    return;
  }
  if (method !== "POST") throw { status: 405, message: "仅支持 GET/POST" };

  switch (action) {
    case "acknowledge":
      sendJson(response, 200, await engine.acknowledge(id, body ?? {}));
      return;
    case "assign":
      sendJson(response, 200, await engine.assign(id, body ?? {}));
      return;
    case "recheck":
      sendJson(response, 200, await engine.submitRecheck(id, body ?? {}));
      return;
    case "close":
      sendJson(response, 200, await engine.close(id, body ?? {}));
      return;
    default:
      throw { status: 404, message: `未知告警操作: ${action}` };
  }
}

function matchAlertRoute(pathname) {
  const match = /^\/alerts\/([^/]+)(?:\/(acknowledge|assign|recheck|close))?$/.exec(pathname);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]), action: match[2] ?? null };
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw { status: 413, message: "请求体过大" };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw { status: 400, message: "请求体不是合法 JSON" };
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
