# 文物库房环境监测后端

面向博物馆保护部门的温湿度连续监测与告警服务：接收传感器上报（同时携带**设备时间**与网关**采集时间**），按库房分区与文物敏感等级判定越限、生成去重告警，支持值守员确认、转派、现场复测与闭环，并完整保留告警期间的原始数据。

纯 Node.js 22 内置模块实现（`node:http`、JSONL 事件日志），无第三方运行时依赖。

## 运行

```bash
npm ci
npm start          # 默认 0.0.0.0:8000
npm test           # node --test，25 个用例
docker compose up --build
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ENV_CONFIG` | `reference/environment.json` | 传感器/分区/阈值/静默/联系人配置 |
| `DATA_FILE` | `.data/events.jsonl` | JSONL 事件日志（落盘位置可配置） |
| `CHECK_INTERVAL_MS` | `15000` | 定时检查周期；**进程启动时立即追赶一次** |

## 核心业务语义

- **双时间戳与时钟漂移**：判定一律以 `collectedAt`（采集网关时间）为准，`deviceTime` 只用于计算 `skewMs = collectedAt - deviceTime`。偏差超过 `maxClockSkewSeconds`（默认 300s）的读数与告警都会明确标出 `flaggedClockDrift` / `clockDrift`，通知文案注明“时钟漂移，判定以采集时间为准”。设备时钟快 20 分钟不会影响开窗时刻与巡检顺序。
- **分区 + 敏感等级去重**：同一分区、同一敏感等级下任意设备的连续越限合并为一条告警（同分区多台设备读数挂接到同一告警）；恢复到阈值内不自动关窗，读数继续保留并标记 `recoveredSince`。
- **分级升级**：首次越限 L1，持续未确认按分区配置升级（样例 15/30 分钟到值班主管、部门负责人）。值守员确认后暂停时间升级；**现场复测不合格立即再升一级**。每次升级都保留原因、触发方式（`opened`/`duration`/`recheck_failed`/`backfill_recovery`）和关联通知。
- **静默时段（可跨午夜）**：低级别升级在静默期内抑制，静默结束时刻合并发送一条摘要；达到 `suppressBelowLevel` 的高级别仍即时发送。所有窗口按绝对 epoch 时间计算，跨午夜不截断。
- **断网补传不重放通知**：`batch:true` 或收到时间晚于采集时间超过宽限期的读数标记为 `backfill`，证据与升级照常登记，通知一律置为 `suppressed/backfill_no_replay`；网络恢复后的**实时**读数若仍越限，仅按当前级别补发一次（`backfill_recovery`），不是逐条重放。重复上报按内容哈希幂等丢弃。
- **现场复测与闭环**：复测记录（经办人、时刻、温湿度、合格/不合格、备注）作为证据挂接告警；最近复测不合格时禁止关闭（除非 `force`）；未复测即关闭会标记 `closedWithoutRecheck`；关闭撤销尚未发送的通知（记录保留为 `cancelled`）。
- **重启续办**：告警与通知（含 `dueAt` 截止时间）全部在 JSONL 日志中。重启后重放日志，立即执行一次定时检查：到期升级照常发生、逾期通知按**原截止时间**补发并记录 `lateMs`，不会把截止时间重置为重启时刻。

## API 摘要

详见 [docs/api.md](docs/api.md)。

- `POST /api/v1/readings` / `POST /api/v1/readings/batch` — 上报/补传
- `GET  /api/v1/readings?deviceId=&from=&to=` — 原始读数
- `GET  /api/v1/risks` — 当前未闭环风险
- `GET  /api/v1/alerts`、`GET /api/v1/alerts/:id` — 告警列表/详情（含升级原因、复测证据、原始读数、漂移标记）
- `POST /api/v1/alerts/:id/acknowledge|assign|rechecks|close`
- `GET  /api/v1/notifications?status=` — 通知台账（sent/pending/suppressed/cancelled）
- `POST /api/v1/checks/run` — 手动触发一次定时检查
- `GET  /health` — 仅表示进程存活

时间字段统一使用带时区的 ISO 8601（不带偏移时按配置时区 `Asia/Shanghai` 解释）。
