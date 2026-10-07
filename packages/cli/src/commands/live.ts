import { ConfigError, type EventLog, type PausedStep, type Plan, type StepPause } from "@qajitsu/core";
import type { CommandIO } from "./fetch.js";

/** Options of `qj run` for watching cases live (REQ-EXEC-16). */
export interface LiveOptions {
  /** Comma-separated case ids of the approved plan. */
  readonly cases?: string | undefined;
  /** Show the browser and the emulator window. */
  readonly headed?: boolean | undefined;
  /** Delay before every browser action, in ms. */
  readonly slowMo?: string | number | undefined;
  /** Pause before every step. */
  readonly step?: boolean | undefined;
}

/** What `qj run` does differently for a live run. */
export interface LiveRun {
  /** Only these cases run; the others are NOT_RUN ("not selected"). Undefined: every case. */
  readonly selected?: ReadonlySet<string> | undefined;
  readonly headed: boolean;
  readonly slowMoMs?: number | undefined;
  readonly pause?: StepPause | undefined;
}

/**
 * Whether the browser or emulator runs without a window: as configured, unless the run is `--headed`
 * (REQ-EXEC-16/AC2).
 *
 * @param configured - `web.headless` or `mobile.android.emulator.headless`.
 * @param live - The live run, if any.
 */
export function headlessFor(configured: boolean, live: Pick<LiveRun, "headed"> | undefined): boolean {
  return configured && live?.headed !== true;
}

/**
 * Validates the live options against the approved plan and the machine before anything runs (REQ-EXEC-16/AC1+AC2).
 *
 * @throws {ConfigError} `RUN_CASES_UNKNOWN`, `HEADED_NO_DISPLAY`, `STEP_NEEDS_TERMINAL` or `SLOW_MO_INVALID`.
 */
export function prepareLiveRun(
  options: LiveOptions,
  plan: Plan,
  io: CommandIO,
  events: EventLog,
  machine: { readonly platform: string; readonly env: Readonly<Record<string, string | undefined>> },
): LiveRun {
  let selected: Set<string> | undefined;
  if (options.cases !== undefined) {
    const ids = options.cases
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const known = new Set(plan.cases.map((c) => c.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (ids.length === 0 || unknown.length > 0)
      throw new ConfigError(
        "RUN_CASES_UNKNOWN",
        ids.length === 0
          ? "--cases needs case ids of the approved plan, e.g. TC-02,TC-03."
          : `Not cases of the approved plan: ${unknown.join(", ")} (plan has ${[...known].join(", ")}).`,
        {},
      );
    selected = new Set(ids);
  }
  const headed = options.headed === true;
  // A Linux machine without an X or Wayland display cannot show a window (CI, SSH).
  if (headed && machine.platform === "linux" && !machine.env["DISPLAY"] && !machine.env["WAYLAND_DISPLAY"])
    throw new ConfigError(
      "HEADED_NO_DISPLAY",
      "--headed needs a display (DISPLAY or WAYLAND_DISPLAY); run it on a desktop or without --headed.",
      {},
    );
  let slowMoMs: number | undefined;
  if (options.slowMo !== undefined) {
    slowMoMs = Number(options.slowMo);
    if (!Number.isInteger(slowMoMs) || slowMoMs < 0 || slowMoMs > 10_000)
      throw new ConfigError("SLOW_MO_INVALID", "--slow-mo takes milliseconds between 0 and 10000.", {});
  }
  let pause: StepPause | undefined;
  if (options.step === true) {
    const ask = io.ask;
    if (!ask)
      throw new ConfigError(
        "STEP_NEEDS_TERMINAL",
        "--step asks before every step; run it in a terminal.",
        {},
      );
    let stepping = true;
    // A case the person stopped stays stopped in its retries: a stop never turns into another attempt that passes.
    const stopped = new Set<string>();
    const user = { kind: "user", name: "cli" } as const;
    pause = async (step: PausedStep) => {
      if (stopped.has(step.caseId)) return "stop";
      if (!stepping) return "continue";
      io.write(`\n⏸ ${step.caseId} ${step.stepId}: ${step.action}\n  Expected: ${step.expected}\n`);
      const answer = (await ask("[Enter] run this step, [c]ontinue without stopping, [q]uit this case: "))
        .trim()
        .toLowerCase();
      if (answer === "q" || answer === "quit") {
        stopped.add(step.caseId);
        events.emit("run", user, "step.stopped", { caseId: step.caseId, stepId: step.stepId });
        return "stop";
      }
      if (answer === "c" || answer === "continue") stepping = false;
      events.emit("run", user, "step.resumed", { caseId: step.caseId, stepId: step.stepId });
      return "continue";
    };
  }
  return {
    ...(selected ? { selected } : {}),
    headed,
    ...(slowMoMs ? { slowMoMs } : {}),
    ...(pause ? { pause } : {}),
  };
}
