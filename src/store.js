// 简单的 JSON 原子持久化：所有状态（告警、通知、定时任务依据）落盘，
// 进程重启后按原始截止时间继续处理。写入采用 临时文件 + rename，避免半写文件。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const STATE_FILENAME = "state.json";
const TMP_FILENAME = "state.tmp.json";

const EMPTY_STATE = Object.freeze({
  version: 1,
  seq: 0,
  // readingId -> { arrivalMs }，用于补传幂等去重，防止重复入库重放通知。
  ingested: {},
  // 尚未形成告警的连续越限读数，按 key 归组，参与去抖判定，同样需要持久化。
  pending: {},
  alerts: [],
  notifications: [],
});

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, STATE_FILENAME);
    this.tmpFile = path.join(dataDir, TMP_FILENAME);
    this.state = null;
  }

  load() {
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed.version !== 1) throw new Error(`不支持的状态版本: ${parsed.version}`);
      this.state = { ...structuredClone(EMPTY_STATE), ...parsed };
    } else {
      this.state = structuredClone(EMPTY_STATE);
    }
    return this.state;
  }

  nextId(prefix) {
    this.state.seq += 1;
    return `${prefix}-${String(this.state.seq).padStart(6, "0")}`;
  }

  /** 同步原子落盘；调用方在关键状态迁移后 await flush() 以保证可测、可崩溃恢复。 */
  async flush() {
    mkdirSync(this.dataDir, { recursive: true });
    const payload = JSON.stringify(this.state);
    writeFileSync(this.tmpFile, payload);
    renameSync(this.tmpFile, this.file);
  }

  flushSync() {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.tmpFile, JSON.stringify(this.state));
    renameSync(this.tmpFile, this.file);
  }
}
