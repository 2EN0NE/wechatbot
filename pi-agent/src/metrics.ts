/**
 * 桥侧进程内累计计数（adr/0013）。
 *
 * 日志是耐久真源，这里只是「当场看一眼」/status 的便利计数——重启（含 /new
 * 重建扩展实例）归零是刻意的。纯逻辑，无 IO、无日志，接口即测试面。
 */

export interface BridgeCounters {
  /** journal 准入条数（adr/0011 的 admitted）。 */
  admitted: number;
  /** journal 结算条数（回发成功 / 中止 / 折叠 / 发送最终失败）。 */
  settled: number;
  /** 崩溃回放重放的 turn 数。 */
  replayed: number;
  /** 交给 pi 重试耗尽后被丢弃的 turn 数。 */
  dropped: number;
  /** 触发不活跃超时提示的轮次计数。 */
  stalled: number;
}

export interface BridgeMetrics {
  admitted(): void;
  settled(): void;
  replayed(): void;
  dropped(): void;
  stalled(): void;
  /** 返回计数副本，调用方改它不影响内部状态。 */
  snapshot(): BridgeCounters;
}

export function createBridgeMetrics(): BridgeMetrics {
  const counters: BridgeCounters = {
    admitted: 0,
    settled: 0,
    replayed: 0,
    dropped: 0,
    stalled: 0,
  };
  return {
    admitted: () => void counters.admitted++,
    settled: () => void counters.settled++,
    replayed: () => void counters.replayed++,
    dropped: () => void counters.dropped++,
    stalled: () => void counters.stalled++,
    snapshot: () => ({ ...counters }),
  };
}

/** 计数展示顺序，固定不变（跨版本可比）。 */
const COUNTER_ORDER: ReadonlyArray<keyof BridgeCounters> = [
  "admitted",
  "settled",
  "replayed",
  "dropped",
  "stalled",
];

/**
 * 渲染 /status 的桥侧行。全 0 时返回 null——不显示纯 0 噪音，也不留空行。
 * 只列非零项，避免长尾计数把行撑满。
 */
export function formatBridgeCounters(counters: BridgeCounters): string | null {
  const parts: string[] = [];
  for (const key of COUNTER_ORDER) {
    if (counters[key] > 0) parts.push(`${key} ${counters[key]}`);
  }
  if (parts.length === 0) return null;
  return `Bridge: ${parts.join(" · ")}`;
}

/** 队列深度阈值：越过 3 表示用户在追赶，越过 10 表示明显堆积。 */
const QUEUE_DEPTH_THRESHOLDS = [3, 10] as const;

export type QueueDepthEvent =
  | { kind: "rising"; depth: number; threshold: number }
  | { kind: "drained"; depth: 0 };

export interface QueueDepthMonitor {
  /**
   * 记录一次深度观测，返回需要落日志的跨越事件。
   *
   * 只在「向上越过阈值」与「归零」时产生事件——深度是状态量，记跨越事件的
   * 成本是 O(事件数)，定时采样是 O(分钟数)（adr/0013）。下穿阈值不记录，但
   * 再次上穿会重新记一次：深度在 4→2→4 抖动时，同一档位会出两条 rising。
   */
  update(depth: number): QueueDepthEvent[];
}

export function createQueueDepthMonitor(): QueueDepthMonitor {
  let level = 0; // 已记录的档位：0 = 未越任何阈值，1 = 越过 3，2 = 越过 10
  let backlogged = false; // 自上次归零以来是否曾经越过阈值
  return {
    update(depth) {
      const events: QueueDepthEvent[] = [];
      let nextLevel = 0;
      for (let i = 0; i < QUEUE_DEPTH_THRESHOLDS.length; i++) {
        const threshold = QUEUE_DEPTH_THRESHOLDS[i];
        if (depth > threshold) {
          nextLevel = i + 1;
          // 一次跳到高深度时，把沿途每个阈值都补记，避免漏档。
          if (nextLevel > level) {
            events.push({ kind: "rising", depth, threshold });
          }
        }
      }
      // 归零只在「曾经越过阈值」时才算积压消退（粘滞标记），否则每条普通消息
      // 的入队-立刻出队（0→1→0）都会打一条 drained，变成噪音。
      if (nextLevel > 0) backlogged = true;
      level = nextLevel;
      if (depth === 0 && backlogged) {
        events.push({ kind: "drained", depth: 0 });
        backlogged = false;
      }
      return events;
    },
  };
}
