# API 说明

所有接口返回 JSON；时间字段为带时区的 ISO 8601 字符串。写操作需记录经办人（`by`）。

## 读数上报

### `POST /api/v1/readings`

请求体：

```json
{
  "deviceId": "sensor-shuhua-01",
  "deviceTime": "2026-09-22T03:20:00+08:00",
  "collectedAt": "2026-09-22T03:00:00+08:00",
  "temperature": 25.4,
  "humidity": 71,
  "batch": false
}
```

- `deviceTime`：设备自身时钟；`collectedAt`：采集网关戳记。二者缺一不可，判定以采集时间为准。
- `temperature` / `humidity` 至少一项；数值先按读数时刻前最近一次校准记录修正，再与分区阈值（按设备敏感等级选取）比较。
- `batch: true` 或服务器收到时间晚于采集时间超过宽限期（`backfillGraceSeconds`）视为断网补传。
- 相同 `(deviceId, deviceTime, collectedAt, 数值)` 的重复上报幂等忽略。

响应 `202`：

```json
{
  "duplicated": false,
  "notificationsSent": 0,
  "clockDriftFlagged": true,
  "reading": {
    "skewMs": -1200000,
    "skewSeconds": -1200,
    "flaggedClockDrift": true,
    "backfill": true,
    "calibrationId": "cal-2026-0001",
    "calibrationOverdue": false,
    "metrics": { "temperature": 25.4 },
    "corrected": { "temperature": 25.6 },
    "violations": [
      { "metric": "temperature", "rawValue": 25.4, "value": 25.6,
        "min": 14, "max": 20, "unit": "C", "severity": "critical", "direction": "high" }
    ]
  },
  "alert": { }
}
```

### `POST /api/v1/readings/batch`

请求体为上述对象的数组（断网恢复后的批量补传）。服务先按 `collectedAt` 排序再处理，返回 `{ count, duplicated, notificationsSent, alerts }`。补传批次 `notificationsSent` 恒为 0。

### `GET /api/v1/readings?deviceId=&from=&to=`

查询原始读数（含告警关闭后的数据），按采集时间升序。

## 风险与告警

### `GET /api/v1/risks`

当前未闭环风险（`status != closed`）。支持 `?status=open|acknowledged|all`。

### `GET /api/v1/alerts` / `GET /api/v1/alerts/:id`

告警列表 / 详情。详情内嵌告警期间全部原始 `readings` 与 `notifications`。告警对象关键字段：

- `zoneId` / `zoneName` / `sensitivity`：去重维度
- `openedAt`：首次越限的**采集时间**（绝对时间，跨午夜窗口不截断）
- `lastBreachAt` / `recoveredSince` / `lastReadingAt`
- `level`：当前最高级别；`escalations[]`：每次升级的 `reason`、`cause`、`at`、`toRole`、`notificationId`
- `clockDrift.detected` 与各设备 `maxAbsSkewMs` / `skewSeconds` / `count`
- `acknowledgements[]`、`assignments[]`、`assignee`、`rechecks[]`、`latestRecheckResult`
- `status`（`open` / `acknowledged` / `closed`）、`closedAt`、`closeReason`、`closedBy`、`closedWithoutRecheck`
- `readingIds[]`：告警期间全部原始数据（含恢复后读数）

### 值守员操作（均为 `POST`）

| 路径 | 请求体 | 说明 |
| --- | --- | --- |
| `/api/v1/alerts/:id/acknowledge` | `{ "by": "赵" }` | 确认；确认后暂停按时间升级 |
| `/api/v1/alerts/:id/assign` | `{ "by": "赵", "toRole": "值班主管", "toPerson": "周", "note": "持续未恢复" }` | 转派，保留角色链 |
| `/api/v1/alerts/:id/rechecks` | `{ "by": "赵", "result": "pass\|fail", "temperature": 18, "humidity": 55, "note": "空调已启动", "at": "..." }` | 现场复测证据；`fail` 立即再升一级 |
| `/api/v1/alerts/:id/close` | `{ "by": "周", "reason": "复测合格", "force": false }` | 闭环；最近复测 `fail` 时须 `force:true` |

## 通知

### `GET /api/v1/notifications?status=sent|pending|suppressed|cancelled`

通知台账。字段：

- `dueAt`：**原截止时间**，落盘持久化；重启后逾期补发仍以此为准，`lateMs` 记录延迟
- `status`：`pending`（待到点）/ `sent` / `suppressed`（`quiet_hours` 或 `backfill_no_replay`）/ `cancelled`（告警闭环撤销）
- `digest: true`：静默结束时合并发送的摘要
- `mode`：`realtime` / `backfill`；补传通知永不发送

### `POST /api/v1/checks/run`

手动执行一次定时检查（升级判定 + 到期通知发送）。进程启动与调度周期也会自动执行。

## 错误格式

```json
{ "error": "bad_request|not_found|conflict|internal_error", "message": "..." }
```
