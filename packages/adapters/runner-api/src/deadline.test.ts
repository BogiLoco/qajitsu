import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pausedStep, startDeadline } from "./deadline.js";

describe("case time limit (REQ-EXEC-16/AC3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("REQ-EXEC-16/AC3: time spent paused does not count toward the limit", () => {
    const timedOut = vi.fn();
    const deadline = startDeadline(1000, timedOut, () => Date.now());
    vi.advanceTimersByTime(600);
    deadline.pause();
    deadline.pause();
    vi.advanceTimersByTime(60_000);
    expect(timedOut).not.toHaveBeenCalled();
    deadline.resume();
    deadline.resume();
    vi.advanceTimersByTime(399);
    expect(timedOut).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timedOut).toHaveBeenCalledTimes(1);
  });

  it("a cleared limit never fires, even after resume", () => {
    const timedOut = vi.fn();
    const deadline = startDeadline(100, timedOut);
    deadline.clear();
    deadline.resume();
    vi.advanceTimersByTime(10_000);
    expect(timedOut).not.toHaveBeenCalled();
  });

  it("shows the step's action and expected result from the approved plan", () => {
    const plan = {
      cases: [{ id: "TC-01", steps: [{ id: "S1", action: "GET /cart", expect: { description: "Total" } }] }],
    };
    expect(pausedStep(plan, "TC-01", "S1")).toEqual({
      caseId: "TC-01",
      stepId: "S1",
      action: "GET /cart",
      expected: "Total",
    });
    expect(pausedStep(plan, "TC-09", "S1")).toEqual({
      caseId: "TC-09",
      stepId: "S1",
      action: "",
      expected: "",
    });
  });
});
