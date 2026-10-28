import { describe, expect, it } from "vitest";
import { planGesture } from "./gestures.js";

const screen = { x: 0, y: 0, width: 400, height: 800 };

describe("touch gestures (REQ-EXEC-41, REQ-EXEC-63/AC2)", () => {
  it("REQ-EXEC-41/AC1+AC2: swipes, taps, long presses, pinches and pull to refresh are planned relative to their target", () => {
    expect(planGesture({ kind: "swipe", direction: "left", distance: 0.5, speed: "fast" }, screen)).toEqual({
      fingers: [
        {
          points: [
            { x: 300, y: 400 },
            { x: 100, y: 400 },
          ],
          holdMs: 0,
          moveMs: 200,
        },
      ],
      repeat: 1,
    });
    expect(
      planGesture({ kind: "swipe", direction: "up", distance: 1, speed: "slow" }, screen).fingers[0]?.points,
    ).toEqual([
      { x: 200, y: 800 },
      { x: 200, y: 0 },
    ]);
    // The same gesture on a twice larger screen lands at twice the coordinates.
    const big = planGesture(
      { kind: "swipe", direction: "right", distance: 0.5, speed: "normal" },
      { x: 0, y: 0, width: 800, height: 1600 },
    );
    expect(big.fingers[0]?.points).toEqual([
      { x: 200, y: 800 },
      { x: 600, y: 800 },
    ]);
    expect(
      planGesture({ kind: "doubleTap", selector: "testid:x" }, { x: 10, y: 20, width: 100, height: 40 }),
    ).toEqual({
      fingers: [{ points: [{ x: 60, y: 40 }], holdMs: 50, moveMs: 0 }],
      repeat: 2,
    });
    expect(
      planGesture({ kind: "longPress", selector: "testid:x", seconds: 1.5 }, screen).fingers[0]?.holdMs,
    ).toBe(1500);
    const pinch = planGesture({ kind: "pinch", direction: "out", scale: 0.8 }, screen);
    expect(pinch.fingers).toHaveLength(2);
    expect(pinch.fingers[0]?.points).toEqual([
      { x: 176, y: 352 },
      { x: 40, y: 80 },
    ]);
    const pinchIn = planGesture({ kind: "pinch", direction: "in", scale: 0.8 }, screen);
    expect(pinchIn.fingers[1]?.points).toEqual([
      { x: 360, y: 720 },
      { x: 224, y: 448 },
    ]);
    expect(
      planGesture({ kind: "swipe", direction: "down", distance: 0.5, speed: "normal" }, screen).fingers[0]
        ?.points,
    ).toEqual([
      { x: 200, y: 200 },
      { x: 200, y: 600 },
    ]);
    expect(planGesture({ kind: "tap", selector: "testid:x" }, screen).repeat).toBe(1);
    expect(planGesture({ kind: "pullToRefresh" }, screen).fingers[0]?.points).toEqual([
      { x: 200, y: 160 },
      { x: 200, y: 600 },
    ]);
  });

  it("REQ-EXEC-41/AC1: numbers outside their limits are refused, never clipped", () => {
    expect(() => planGesture({ kind: "swipe", direction: "up", distance: 2, speed: "fast" }, screen)).toThrow(
      "ui.swipe(): the distance (share of the target) must be between 0.1 and 1",
    );
    expect(() => planGesture({ kind: "pinch", direction: "in", scale: 0 }, screen)).toThrow(
      "ui.pinch(): the scale",
    );
    expect(() => planGesture({ kind: "longPress", selector: "testid:x", seconds: 30 }, screen)).toThrow(
      "ui.longPress(): the hold (seconds) must be between 0.3 and 10",
    );
  });
});
