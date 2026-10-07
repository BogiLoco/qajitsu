/** A case time limit that stands still while a person looks at a paused step (REQ-EXEC-16/AC3). */
export interface Deadline {
  pause(): void;
  resume(): void;
  clear(): void;
}

/**
 * Starts a time limit of `ms` milliseconds that calls `onTimeout` once it runs out; paused time does not count.
 *
 * @param ms - The limit.
 * @param onTimeout - Called when the limit is reached.
 * @param now - Clock in milliseconds.
 */
export function startDeadline(ms: number, onTimeout: () => void, now: () => number = Date.now): Deadline {
  let left = ms;
  let since = now();
  let cleared = false;
  let timer: NodeJS.Timeout | undefined = setTimeout(onTimeout, left);
  return {
    pause() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      left -= now() - since;
    },
    resume() {
      if (timer !== undefined || cleared) return;
      since = now();
      timer = setTimeout(onTimeout, Math.max(0, left));
    },
    clear() {
      clearTimeout(timer);
      timer = undefined;
      cleared = true;
    },
  };
}

/** The step a pause shows: its action and expected result from the approved plan. */
export function pausedStep(
  plan: {
    readonly cases: readonly {
      readonly id: string;
      readonly steps: readonly {
        readonly id: string;
        readonly action: string;
        readonly expect: { readonly description: string };
      }[];
    }[];
  },
  caseId: string,
  stepId: string,
): { caseId: string; stepId: string; action: string; expected: string } {
  const step = plan.cases.find((c) => c.id === caseId)?.steps.find((s) => s.id === stepId);
  return { caseId, stepId, action: step?.action ?? "", expected: step?.expect.description ?? "" };
}
