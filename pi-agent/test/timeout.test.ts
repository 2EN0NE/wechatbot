import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InactivityTimer } from "../src/timeout.js";

describe("InactivityTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the timeout when no activity", () => {
    const onTimeout = vi.fn();
    const timer = new InactivityTimer(1000, onTimeout);
    timer.arm();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("resets the deadline on touch, so activity postpones the timeout", () => {
    const onTimeout = vi.fn();
    const timer = new InactivityTimer(1000, onTimeout);
    timer.arm();
    vi.advanceTimersByTime(600);
    timer.touch();
    vi.advanceTimersByTime(600); // 1200ms total since arm, but 600ms since touch
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400); // 1000ms since touch
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("notifies at most once per arm, ignoring further touch calls", () => {
    const onTimeout = vi.fn();
    const timer = new InactivityTimer(1000, onTimeout);
    timer.arm();
    vi.advanceTimersByTime(1000);
    timer.touch();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does nothing when touch is called while disarmed", () => {
    const onTimeout = vi.fn();
    const timer = new InactivityTimer(1000, onTimeout);
    timer.touch();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("disarm stops the timer and allows a fresh arm", () => {
    const onTimeout = vi.fn();
    const timer = new InactivityTimer(1000, onTimeout);
    timer.arm();
    vi.advanceTimersByTime(500);
    timer.disarm();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();

    timer.arm();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("exposes isArmed", () => {
    const timer = new InactivityTimer(1000, () => {});
    expect(timer.isArmed).toBe(false);
    timer.arm();
    expect(timer.isArmed).toBe(true);
    timer.disarm();
    expect(timer.isArmed).toBe(false);
  });
});
