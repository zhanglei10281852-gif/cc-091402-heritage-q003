# 文物库房环境监测 API

所有时间字段均为带时区的 ISO 8601 字符串；内部一律以网关采集时间 `collectedAt`（可信时间）
判定告警窗口，设备时间 `deviceTime` 仅用于时钟漂移评估。

## POST /readings

上报单条或批量读数（断网恢复后的批量补传使用同一接口）。

```json
{
  "readings": [
    {
      "readingId": "gateway-20260921-0001",
      "sensorId": "sensor-A-01",
      "deviceTime": "2026-09-21T22:50:00+08:00",
      "collectedAt": "2026-09-21T22:30:00+08:00",
      "metrics": { "temperature": 24.2, "humidity": 55 },
      "batch": "backfill-20260921"
    }
  ]
}
```

响应 `202`（部分失败不整体拒绝，逐行给出结论）：

- `accepted` / `duplicates` / `rejected`：入库、幂等忽略、拒绝的读数及原因。
  重复 `readingId`（含跨进程重传）幂等忽略，**不重放任何通知**。
- `clockWarnings[]`：时钟漂移明细，含 `status`（`fast`/`slow`/`ok`）、
  `offsetMs`（设备时钟−采集时间，正=快）、`deviationMs`（相对校准基线的偏离）、
  `expectedClockOffsetMs`、`toleranceMs`、`uncalibrated`、`calibrationStale`。
- `alerts[]`：本次入库触及的告警视图。

## GET /risks

当前未闭环风险（`open`/`acknowledged`/`recheck`），按 越限等级 → 文物敏感等级 → 首次越限时间 排序。
每条包含告警窗口、`clockAnomalies`、`escalations`（每次升级的原因/触发器/截止时间）、
`rechecks`（复测证据）、`nextDeadline`、当班联系人。

## GET /alerts?status=all|active|open|acknowledged|recheck|closed

告警列表。

## GET /alerts/:id

告警详情：窗口、全部升级记录与原因、复测证据、事件流、**告警期间全部原始读数**
（含设备时间与每条读数的时钟判定）、通知记录。

生命周期操作（POST，操作需带 `operator`）：

| 接口 | 说明 |
|---|---|
| `/alerts/:id/acknowledge` | 值守员确认 `{operator, note}` |
| `/alerts/:id/assign` | 转派 `{operator, toContactId, note}`，仅可转给负责本分区的联系人；转派同时向新经办人发短信 |
| `/alerts/:id/recheck` | 现场复测 `{operator, measuredAt, measurements, method, note}`；必须包含告警指标实测值；仍越限则记录证据并可触发升级 |
| `/alerts/:id/close` | 关闭 `{operator, resolution: resolved|false_alarm|maintenance|other, note}`；`resolved` 必须先有合规复测证据（或显式 `force:true`） |

## GET /notifications?status=pending|sent|failed

通知台账：`kind`（opened/escalation/assigned/recheck_failed/recheck_overdue/closed 等）、
接收人、`createdAt`、`notBefore`、`deferredBySilence`、发送状态与尝试次数。

## GET /reference/zones · /reference/sensors · /reference/contacts

分区阈值（含静默时段）、传感器清单、通知联系人只读视图。

## POST /maintenance/tick

立即执行一次到期检查（定时调度每 15 秒自动执行一次；进程重启后首次 tick 会按
**原始截止时间**补跑停机期间到期的全部升级与未发送通知）。

## 告警与升级规则（参考 `reference/settings.json`）

- 去抖：同一 `分区+指标` 连续越限满 5 分钟才开告警；同分区多台设备并入同一告警。
- 等级：`warn → critical → emergency`；读数越过 critical 阈值带或复测仍越限立即升级。
- `open` 超时未确认：普通分区 10 分钟、critical 敏感分区 5 分钟自动升级。
- `acknowledged`：high/critical 敏感分区确认后 10 分钟未提交复测自动升级。
- `recheck`：提交复测后 15 分钟未闭环自动升级；达最高级后改发催办。
- 末次越限后读数恢复并持续 30 分钟宽限，系统自动关闭；30 分钟去重窗内再次越限重开同一告警。
- 静默时段只延后短信（`notBefore` 置为窗口结束），不阻断告警生成；支持跨午夜窗口，
  跨午夜的告警窗口与班次不会按日截断。
