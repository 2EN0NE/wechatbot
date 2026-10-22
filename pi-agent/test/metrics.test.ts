import { describe, it, expect } from "vitest";
import {
  createBridgeMetrics,
  createQueueDepthMonitor,
  formatBridgeCounters,
} from "../src/metrics.js";

describe("桥指标计数器（adr/0013）", () => {
  it("初始全为 0", () => {
    expect(createBridgeMetrics().snapshot()).toEqual({
      admitted: 0,
      settled: 0,
      replayed: 0,
      dropped: 0,
      stalled: 0,
    });
  });

  it("五个计数各自独立递增", () => {
    const metrics = createBridgeMetrics();
    metrics.admitted();
    metrics.admitted();
    metrics.settled();
    metrics.replayed();
    metrics.dropped();
    metrics.stalled();
    expect(metrics.snapshot()).toEqual({
      admitted: 2,
      settled: 1,
      replayed: 1,
      dropped: 1,
      stalled: 1,
    });
  });

  it("snapshot 返回副本，改它不影响内部状态", () => {
    const metrics = createBridgeMetrics();
    metrics.admitted();
    const snap = metrics.snapshot();
    snap.admitted = 99;
    expect(metrics.snapshot().admitted).toBe(1);
  });
});

describe("formatBridgeCounters（/status 桥侧行）", () => {
  it("全 0 时返回 null —— 不留空行、不显示纯 0 噪音", () => {
    expect(
      formatBridgeCounters({
        admitted: 0,
        settled: 0,
        replayed: 0,
        dropped: 0,
        stalled: 0,
      }),
    ).toBeNull();
  });

  it("只列非零项，顺序固定为 admitted / settled / replayed / dropped / stalled", () => {
    expect(
      formatBridgeCounters({
        admitted: 3,
        settled: 0,
        replayed: 1,
        dropped: 0,
        stalled: 2,
      }),
    ).toBe("Bridge: admitted 3 · replayed 1 · stalled 2");
  });

  it("单项非零也能成行", () => {
    expect(
      formatBridgeCounters({
        admitted: 0,
        settled: 1,
        replayed: 0,
        dropped: 0,
        stalled: 0,
      }),
    ).toBe("Bridge: settled 1");
  });
});

describe("队列深度跨越阈值事件（adr/0013）", () => {
  it("深度在 1–3 之间波动不产生任何事件", () => {
    const monitor = createQueueDepthMonitor();
    expect(monitor.update(1)).toEqual([]);
    expect(monitor.update(3)).toEqual([]);
    expect(monitor.update(2)).toEqual([]);
  });

  it("向上越过 3 记一次 rising，同一次持续堆积不重复", () => {
    const monitor = createQueueDepthMonitor();
    expect(monitor.update(4)).toEqual([
      { kind: "rising", depth: 4, threshold: 3 },
    ]);
    expect(monitor.update(5)).toEqual([]);
    expect(monitor.update(7)).toEqual([]);
  });

  it("继续涨过 10 再记一次 rising", () => {
    const monitor = createQueueDepthMonitor();
    monitor.update(4);
    expect(monitor.update(11)).toEqual([
      { kind: "rising", depth: 11, threshold: 10 },
    ]);
    expect(monitor.update(12)).toEqual([]);
  });

  it("一次跳到 11 时把两个阈值都补记", () => {
    const monitor = createQueueDepthMonitor();
    expect(monitor.update(11)).toEqual([
      { kind: "rising", depth: 11, threshold: 3 },
      { kind: "rising", depth: 11, threshold: 10 },
    ]);
  });

  it("从 4 回落到 2 不产生事件；再次越界时重新记一次", () => {
    const monitor = createQueueDepthMonitor();
    monitor.update(4);
    expect(monitor.update(2)).toEqual([]);
    expect(monitor.update(4)).toEqual([
      { kind: "rising", depth: 4, threshold: 3 },
    ]);
  });

  it("归 0 记一次 drained；重复 0 不重复记", () => {
    const monitor = createQueueDepthMonitor();
    monitor.update(4);
    expect(monitor.update(0)).toEqual([{ kind: "drained", depth: 0 }]);
    expect(monitor.update(0)).toEqual([]);
  });
  it("单条消息进出（0→1→0）不产生任何事件 —— 归零只在越过阈值后才算消退", () => {
    const monitor = createQueueDepthMonitor();
    expect(monitor.update(1)).toEqual([]);
    expect(monitor.update(0)).toEqual([]);
  });


  it("从未有深度时 update(0) 不产生事件", () => {
    expect(createQueueDepthMonitor().update(0)).toEqual([]);
  });
});
