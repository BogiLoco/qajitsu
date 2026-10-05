import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import type { Turn } from "../../../../tests/support/mock-model.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const pipeline = async (flag?: string) => {
  const p = await createDemoPipeline({ ticket: "DEMO-4", ...(flag ? { flag } : {}) });
  cleanups.push(p.cleanup);
  expect((await p.run(["fetch", "DEMO-4", "--ref", "shop=main"])).exitCode).toBe(0);
  return p;
};
const sessionOf = async (runDir: string, id = "S01") =>
  JSON.parse(await readFile(join(runDir, "explore", id, "session.json"), "utf8")) as {
    endReason: string;
    actions: { id: string; action: string; ok: boolean; screenshot?: string; url: string }[];
    observations: { id: string; steps: string[] }[];
    recordings: string[];
  };

/** The explorer of these tests: logs in, opens checkout, accepts the terms, tries to order, records what it saw. */
const CHECKOUT: Turn[] = [
  { tools: [{ name: "explore_look", input: {} }] },
  { tools: [{ name: "explore_login_as", input: { alias: "user:standard" } }] },
  { tools: [{ name: "explore_goto", input: { path: "/app/checkout" } }] },
  { tools: [{ name: "explore_click", input: { selector: "testid:accept-terms" } }] },
  { tools: [{ name: "explore_click", input: { selector: "testid:place-order" } }] },
  // An action outside the environment is refused by code before the browser sees it.
  { tools: [{ name: "explore_goto", input: { path: "https://evil.example.com/" } }] },
  {
    tools: [
      {
        name: "record_observation",
        input: {
          title: "Place order stays disabled after accepting the terms",
          kind: "possible-bug",
          severity: "high",
          description: "The button never becomes enabled.",
          steps: ["A02", "A03", "A04"],
          expected: "Place order is enabled",
          actual: "Place order is disabled",
        },
      },
      // Steps must be actions of this session.
      {
        name: "record_observation",
        input: { title: "Invented", kind: "ux", severity: "low", description: "x", steps: ["A77"] },
      },
    ],
  },
  { text: JSON.stringify({ summary: "Checkout cannot be completed." }) },
];

describe("qajitsu explore (REQ-EXEC-15)", () => {
  it("REQ-EXEC-15/AC1+AC2+AC3+AC6: explores in a real browser, records every action, keeps grounded observations and writes the review report", async () => {
    const { run, runDir } = await pipeline("BUG_CHECKOUT_BUTTON_DISABLED");
    const result = await run(["explore", "DEMO-4", "--goal", "Check checkout around the terms change"], {
      script: CHECKOUT,
    });
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    const session = await sessionOf(runDir);
    expect(session.endReason).toBe("finished");
    expect(session.actions.map((a) => [a.id, a.action, a.ok])).toEqual([
      ["A01", "login_as", true],
      ["A02", "goto", true],
      ["A03", "click", true],
      ["A04", "click", false],
    ]);
    expect(session.observations).toEqual([
      expect.objectContaining({ id: "O1", steps: ["A02", "A03", "A04"] }),
    ]);
    // Evidence is written by the trusted parent and listed in the manifest with hashes.
    const manifest = JSON.parse(
      await readFile(join(runDir, "explore", "S01", "evidence", "manifest.json"), "utf8"),
    ) as {
      path: string;
      sha256: string;
    }[];
    expect(manifest.map((m) => m.path)).toEqual(
      expect.arrayContaining([
        "A01.png",
        "A04.png",
        "recordings/video.webm",
        "recordings/network.har",
        "recordings/console.log",
      ]),
    );
    expect(session.recordings).toEqual(
      expect.arrayContaining(["recordings/video.webm", "recordings/trace.zip"]),
    );
    // No results, no statuses: exploration is not test execution.
    expect(await readdir(join(runDir, "results"))).toEqual([]);
    const report = await readFile(join(runDir, "explore", "S01", "report.html"), "utf8");
    expect(report).toContain("Place order stays disabled after accepting the terms");
    expect(report).toContain('<img src="evidence/A04.png"');
    expect(result.out).toContain("O1 [high] Place order stays disabled after accepting the terms");
    expect(result.out).toContain(join(runDir, "explore", "S01", "report.html"));
    const journal = await readFile(join(runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"explore.action"');
    expect(journal).toContain('"explore.refused"');
    expect(journal).toContain('"explore.end"');
    expect(journal).not.toContain("fictional-demo-password");
  }, 120_000);

  it("REQ-EXEC-15/AC5: the step budget is enforced by code and the session keeps what it recorded", async () => {
    const { run, runDir } = await pipeline();
    const looping: Turn[] = [{ tools: [{ name: "explore_goto", input: { path: "/app/products" } }] }];
    const result = await run(["explore", "DEMO-4", "--goal", "Wander", "--max-steps", "3"], {
      script: looping,
    });
    expect(result.exitCode).toBe(0);
    const session = await sessionOf(runDir);
    expect(session.endReason).toBe("step-budget");
    expect(session.actions).toHaveLength(3);
    expect(await readFile(join(runDir, "explore", "S01", "report.md"), "utf8")).toContain(
      "the step budget was used",
    );
  }, 120_000);

  it("REQ-EXEC-15/AC5: the time box is enforced by code", async () => {
    const { run, runDir } = await pipeline();
    const looping: Turn[] = [{ tools: [{ name: "explore_goto", input: { path: "/app/products" } }] }];
    const result = await run(
      ["explore", "DEMO-4", "--goal", "Wander", "--time-box", "0.05", "--max-steps", "1000"],
      {
        script: looping,
      },
    );
    expect(result.exitCode).toBe(0);
    const s = await sessionOf(runDir);
    expect(s.endReason, JSON.stringify(s).slice(0, 600) + result.err).toBe("time-box");
  }, 120_000);

  it("REQ-EXEC-15/AC4: an observation becomes a draft case in a new plan version, cited as its source; nothing runs before approval", async () => {
    const { run, runDir } = await pipeline("BUG_CHECKOUT_BUTTON_DISABLED");
    await run(["explore", "DEMO-4", "--goal", "Check checkout"], { script: CHECKOUT });
    const promoted = await run(["explore", "promote", "DEMO-4", "--session", "S01", "--observation", "O1"]);
    expect(promoted.err).toBe("");
    expect(promoted.exitCode).toBe(0);
    expect(promoted.out).toContain("plan v1");
    const plan = await readFile(join(runDir, "plan", "plan.v1.yaml"), "utf8");
    expect(plan).toContain("kind: observation");
    expect(plan).toContain("Place order stays disabled after accepting the terms");
    const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as {
      data: Record<string, unknown>;
    };
    expect(record.data["approval"]).toBeUndefined();
    expect((await run(["run", "DEMO-4"])).err).toContain("PLAN_NOT_APPROVED");
    const missing = await run(["explore", "promote", "DEMO-4", "--session", "S01", "--observation", "O7"]);
    expect(missing.exitCode).toBe(3);
  }, 120_000);

  it("REQ-EXEC-15/AC1: a session needs a goal and a fetched run", async () => {
    const { run } = await pipeline();
    const noGoal = await run(["explore", "DEMO-4"]);
    expect(noGoal.exitCode).toBe(3);
    expect(noGoal.err).toContain("--goal is required");
    expect((await run(["explore", "NOPE-1", "--goal", "x"])).exitCode).toBe(3);
  }, 60_000);
});
