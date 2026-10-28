/**
 * Touch gestures of web and native cases (REQ-EXEC-41, REQ-EXEC-63/AC2), in coordinates relative to their target, so
 * the same step works on every screen size of the device matrix (REQ-EXEC-41/AC2).
 */
export type UiGesture =
  | { readonly kind: "tap"; readonly selector: string }
  | { readonly kind: "doubleTap"; readonly selector: string }
  | { readonly kind: "longPress"; readonly selector: string; readonly seconds: number }
  | {
      readonly kind: "swipe";
      /** An element, or the whole screen when absent. */
      readonly selector?: string | undefined;
      readonly direction: "up" | "down" | "left" | "right";
      /** Share of the target's size the finger travels, 0.1 to 1. */
      readonly distance: number;
      readonly speed: "slow" | "normal" | "fast";
    }
  | {
      readonly kind: "pinch";
      readonly selector?: string | undefined;
      /** `in` brings two fingers together (zoom out), `out` spreads them (zoom in). */
      readonly direction: "in" | "out";
      /** Share of the target's size the fingers travel, 0.1 to 1. */
      readonly scale: number;
    }
  | { readonly kind: "pullToRefresh" };

/** A rectangle in the coordinates the device takes (CSS pixels on the web, points or pixels on a phone). */
export interface GestureArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One finger's moves: where it goes down, the points it passes, and how long each part takes. */
export interface FingerPath {
  readonly points: readonly { readonly x: number; readonly y: number }[];
  /** Milliseconds the finger stays down before moving (a long press holds here). */
  readonly holdMs: number;
  /** Milliseconds of the move from the first point to the last. */
  readonly moveMs: number;
}

/** The fingers of a gesture, and how many times it is repeated (a double tap is two taps). */
export interface GesturePlan {
  readonly fingers: readonly FingerPath[];
  readonly repeat: number;
}

const SPEED_MS = { slow: 1200, normal: 500, fast: 200 } as const;

/**
 * Checks a gesture's numbers before anything moves: a gesture outside its limits is refused, never clipped.
 *
 * @throws {Error} Naming the gesture and the allowed range.
 */
export function checkGesture(g: UiGesture): void {
  const between = (v: number, lo: number, hi: number, what: string): void => {
    if (!Number.isFinite(v) || v < lo || v > hi)
      throw new Error(`ui.${g.kind}(): ${what} must be between ${String(lo)} and ${String(hi)}`);
  };
  if (g.kind === "swipe") between(g.distance, 0.1, 1, "the distance (share of the target)");
  if (g.kind === "pinch") between(g.scale, 0.1, 1, "the scale (share of the target)");
  if (g.kind === "longPress") between(g.seconds, 0.3, 10, "the hold (seconds)");
}

/**
 * The finger paths of a gesture on its target: swipes travel `distance` of the target through its centre, a pinch
 * moves two fingers along the diagonal, pull to refresh drags from the top fifth of the screen down. Pure: the drivers
 * turn the plan into touch events (web) or W3C pointer actions (Appium), and the evidence draws it.
 *
 * @param g - The gesture.
 * @param area - The target element's rectangle, or the screen for screen gestures.
 */
export function planGesture(g: UiGesture, area: GestureArea): GesturePlan {
  checkGesture(g);
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  const at = (x: number, y: number) => ({ x: Math.round(x), y: Math.round(y) });
  switch (g.kind) {
    case "tap":
      return { fingers: [{ points: [at(cx, cy)], holdMs: 50, moveMs: 0 }], repeat: 1 };
    case "doubleTap":
      return { fingers: [{ points: [at(cx, cy)], holdMs: 50, moveMs: 0 }], repeat: 2 };
    case "longPress":
      return {
        fingers: [{ points: [at(cx, cy)], holdMs: Math.round(g.seconds * 1000), moveMs: 0 }],
        repeat: 1,
      };
    case "swipe": {
      const dx = g.direction === "left" ? -1 : g.direction === "right" ? 1 : 0;
      const dy = g.direction === "up" ? -1 : g.direction === "down" ? 1 : 0;
      const half = { x: (area.width * g.distance) / 2, y: (area.height * g.distance) / 2 };
      return {
        fingers: [
          {
            points: [at(cx - dx * half.x, cy - dy * half.y), at(cx + dx * half.x, cy + dy * half.y)],
            holdMs: 0,
            moveMs: SPEED_MS[g.speed],
          },
        ],
        repeat: 1,
      };
    }
    case "pinch": {
      // Fingers on the diagonal: far apart at `scale` of the half-size, close together near the centre.
      const far = { x: (area.width * g.scale) / 2, y: (area.height * g.scale) / 2 };
      const near = { x: far.x * 0.15, y: far.y * 0.15 };
      const [from, to] = g.direction === "in" ? [far, near] : [near, far];
      return {
        fingers: [
          {
            points: [at(cx - from.x, cy - from.y), at(cx - to.x, cy - to.y)],
            holdMs: 0,
            moveMs: SPEED_MS.normal,
          },
          {
            points: [at(cx + from.x, cy + from.y), at(cx + to.x, cy + to.y)],
            holdMs: 0,
            moveMs: SPEED_MS.normal,
          },
        ],
        repeat: 1,
      };
    }
    case "pullToRefresh":
      return {
        fingers: [
          {
            points: [at(cx, area.y + area.height * 0.2), at(cx, area.y + area.height * 0.75)],
            holdMs: 0,
            moveMs: SPEED_MS.slow,
          },
        ],
        repeat: 1,
      };
  }
}
