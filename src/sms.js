// 短信发送器。默认实现把短信写入日志并返回成功；生产环境可替换为网关客户端。
// 接口契约：send(notification, atMs) -> { status: "sent" }，失败时抛错，由引擎重试。
export class ConsoleSmsSender {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.sent = [];
  }

  async send(notification) {
    const text =
      `[环境监测告警 ${notification.alertId}] ${notification.reason} ` +
      `等级=${notification.severity}，请在系统中处置。`;
    const record = {
      to: notification.target,
      text,
      sentAt: notification.notBeforeMs,
      notificationId: notification.id,
    };
    this.sent.push(record);
    this.log(`短信 → ${notification.target}（${notification.contactName}）: ${text}`);
    return { status: "sent", detail: "console-stub" };
  }
}
