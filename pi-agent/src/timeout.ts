/**
 * 不活跃超时计时器（纯逻辑，可注入 fake timers 单测）。
 *
 * 见 docs/adr/0006-inactivity-timeout.md：arm() 启动一轮跟踪，
 * touch() 记录活动（重置计时），超时后回调一次（每轮至多一次），disarm() 收尾。
 */

export class InactivityTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armed = false;
  private notified = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  /** 记录活动（仅在已 arm 且未通知时有效）。 */
  touch(): void {
    if (!this.armed || this.notified) return;
    this.restart();
  }

  /** 开始一轮不活跃跟踪。 */
  arm(): void {
    this.armed = true;
    this.notified = false;
    this.restart();
  }

  /** 停止跟踪（轮次结束 / 中止）。 */
  disarm(): void {
    this.armed = false;
    this.notified = false;
    this.clear();
  }

  get isArmed(): boolean {
    return this.armed;
  }

  private restart(): void {
    this.clear();
    this.timer = setTimeout(() => {
      if (this.armed && !this.notified) {
        this.notified = true;
        this.onTimeout();
      }
    }, this.timeoutMs);
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
