import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { headlessFor } from "./live.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const setup = async (options: Parameters<typeof createBuildProject>[1] = {}) => {
  const p = await createBuildProject(undefined, options);
  cleanups.push(p.cleanup);
  const dir = await p.prepare();
  const status = async (caseId: string) =>
    (
      JSON.parse(await readFile(join(dir, "results", `${caseId}.json`), "utf8")) as {
        attempts: { outcome: string; error?: string }[];
      }
    ).attempts;
  return { ...p, dir, status };
};

describe("run one case with a live view (REQ-EXEC-16)", () => {
  it("REQ-EXEC-16/AC1: only the chosen cases run; the others are NOT_RUN and get no spec written", async () => {
    const p = await setup();
    const r = await p.run(["run", "DEMO-1", "--build", "--cases", "TC-02"]);
    expect(r.err).toBe("");
    expect(r.exitCode).toBe(2);
    expect(r.out).toMatch(/\| TC-01 \| .* \| NOT_RUN \|/);
    expect(r.out).toMatch(/\| TC-02 \| .* \| PASSED \|/);
    expect(await p.status("TC-01")).toEqual([
      expect.objectContaining({ outcome: "skipped", error: "not selected (--cases)" }),
    ]);
    const again = await p.run(["run", "DEMO-1", "--cases", "TC-02"]);
    expect(again.exitCode).toBe(3);
    expect(again.err).toContain(
      "to watch cases again start a new run: qajitsu fetch DEMO-1, qajitsu approve DEMO-1 --reuse-from",
    );
  }, 240_000);

  it("REQ-EXEC-16/AC1+AC2: unknown cases, a headed run without a display and --step without a terminal are refused first", async () => {
    const p = await setup({ ports: { platform: "linux" } });
    const unknown = await p.run(["run", "DEMO-1", "--cases", "TC-02,TC-09"]);
    expect(unknown.exitCode).toBe(3);
    expect(unknown.err).toContain(
      "[RUN_CASES_UNKNOWN]: Not cases of the approved plan: TC-09 (plan has TC-01, TC-02).",
    );
    const empty = await p.run(["run", "DEMO-1", "--cases", ","]);
    expect(empty.err).toContain("[RUN_CASES_UNKNOWN]: --cases needs case ids");
    const headed = await p.run(["run", "DEMO-1", "--headed"]);
    expect(headed.err).toContain("[HEADED_NO_DISPLAY]");
    const step = await p.run(["run", "DEMO-1", "--step"]);
    expect(step.err).toContain("[STEP_NEEDS_TERMINAL]");
    const slow = await p.run(["run", "DEMO-1", "--slow-mo", "fast"]);
    expect(slow.err).toContain("[SLOW_MO_INVALID]");
    // Nothing ran: the run can still be executed.
    await expect(readFile(join(p.dir, "results", "TC-01.json"), "utf8")).rejects.toThrow();
  }, 240_000);

  it("REQ-EXEC-16/AC3+AC4: --step shows each step and waits; quitting before a step leaves the case BLOCKED", async () => {
    const p = await setup();
    const r = await p.run(["run", "DEMO-1", "--build", "--cases", "TC-02", "--step"], undefined, {
      ask: ["", "q", "c"],
    });
    expect(r.out).toContain("⏸ TC-02 S1:");
    expect(r.out).toContain("⏸ TC-02 S2:");
    expect(r.out).toMatch(/\| TC-02 \| .* \| BLOCKED \|/);
    // The stop holds for the retry too: every attempt errors, none passes.
    const attempts = await p.status("TC-02");
    expect(attempts.map((a) => a.outcome).every((o) => o === "error")).toBe(true);
    expect(attempts[0]?.error).toContain("stopped by the tester before S2");
  }, 240_000);

  it("REQ-EXEC-16/AC3: [c]ontinue runs the rest without stopping and the case passes as usual", async () => {
    // A machine with a display (macOS): on a Linux CI runner without one, --headed is refused (tested above).
    const p = await setup({ ports: { platform: "darwin" } });
    const r = await p.run(
      ["run", "DEMO-1", "--build", "--cases", "TC-02", "--step", "--headed", "--slow-mo", "10"],
      undefined,
      {
        ask: ["c"],
      },
    );
    expect(r.out).toContain("⏸ TC-02 S1:");
    expect(r.out).not.toContain("⏸ TC-02 S2:");
    expect(r.out).toMatch(/\| TC-02 \| .* \| PASSED \|/);
  }, 240_000);

  it("REQ-EXEC-16/AC2: --headed shows the browser and the emulator window, whatever the configuration says", () => {
    expect(headlessFor(true, undefined)).toBe(true);
    expect(headlessFor(true, { headed: false })).toBe(true);
    expect(headlessFor(true, { headed: true })).toBe(false);
    expect(headlessFor(false, undefined)).toBe(false);
  });
});
