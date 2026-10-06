import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEventLines } from "@qajitsu/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify, parse } from "yaml";
import { createCliProject, gitExec } from "../../../../tests/support/cli-project.js";
import { scriptedModel, type Turn } from "../../../../tests/support/mock-model.js";
import { createProgram } from "../program.js";

const draft = JSON.parse(
  readFileSync(new URL("../../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
) as { cases: unknown[] };
const analysis = {
  summary: "Cart API change.",
  change_type: ["api"],
  endpoints: [
    {
      method: "GET",
      path: "/cart",
      source: [
        { kind: "ac", id: "AC1" },
        { kind: "diff", repo: "shop", file: "cart.ts", lines: "1" },
      ],
    },
  ],
  confidence: "high",
};

describe("qajitsu plan / approve (REQ-PLAN-01..06, REQ-GEN-05)", () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    ({ home, project } = await createCliProject([
      "models: { roles: { default: mock/scripted }, token_budget: 100000 }",
    ]));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = async (
    args: string[],
    options: {
      script?: Turn[];
      answers?: string[];
      edit?: (file: string) => Promise<void>;
      beforeAnswer?: () => Promise<void>;
    } = {},
  ) => {
    let out = "";
    let err = "";
    let exitCode = 0;
    const model = scriptedModel(options.script ?? [{ text: "{}" }]);
    const answers = [...(options.answers ?? [])];
    await createProgram("1.0.0", {
      write: (t) => (out += t),
      writeError: (t) => (err += t),
      cwd: project,
      nodeVersion: "v22.22.0",
      setExitCode: (c) => (exitCode = c),
      user: "qa-lead",
      ...(options.answers
        ? {
            ask: async () => {
              await options.beforeAnswer?.();
              return answers.shift() ?? "q";
            },
          }
        : {}),
      ...(options.edit ? { openEditor: options.edit } : {}),
      ports: {
        env: {},
        home,
        now: () => new Date("2026-10-03T10:46:00Z"),
        random: () => 0,
        fetch: () => Promise.reject(new Error("no network")),
        gitExec,
        extraModels: { mock: () => model.mock },
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode, model };
  };
  const runDir = () => join(home, "runs", "DEMO-1", "20261003-1046-aaaa");
  const fetched = async () => {
    expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
  };
  const fullScript: Turn[] = [{ text: JSON.stringify(analysis) }, { text: JSON.stringify(draft) }];

  it("REQ-PLAN-02/AC4 + REQ-CTX-01/AC2: writes analysis.json and plan.v1 from the frozen snapshot (CI, no prompt)", async () => {
    await fetched();
    await writeFile(join(project, "tickets", "DEMO-1.json"), "{ changed after fetch");
    const result = await run(["plan", "DEMO-1"], { script: fullScript });
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Plan v1: 2 case(s), 0 open question(s)");
    expect(JSON.parse(await readFile(join(runDir(), "analysis.json"), "utf8"))).toMatchObject({
      change_type: ["api"],
    });
    expect(await readFile(join(runDir(), "plan", "plan.v1.md"), "utf8")).toContain("# Test plan DEMO-1 v1");
    const record = JSON.parse(await readFile(join(runDir(), "run.json"), "utf8")) as {
      data: { tokens: number };
    };
    expect(record.data.tokens).toBe(240);
    const events = parseEventLines(await readFile(join(runDir(), "journal", "events.jsonl"), "utf8"));
    expect(events.invalidLines).toEqual([]);
    expect(events.events.filter((e) => e.event === "model.usage")).toHaveLength(2);
  });

  it("REQ-PLAN-04/AC1+AC2: revise in the terminal creates v2 and shows the diff; accept freezes it", async () => {
    await fetched();
    const revised = { ...draft, cases: draft.cases.slice(0, 1) };
    const result = await run(["plan", "DEMO-1"], {
      script: [...fullScript, { text: JSON.stringify(revised) }],
      answers: ["r", "Drop TC-02", "a"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Changes v1 → v2:\n- TC-02");
    expect(result.out).toContain("Approved plan v2");
    const record = JSON.parse(await readFile(join(runDir(), "run.json"), "utf8")) as {
      data: { approval: { approver: string; version: number } };
    };
    expect(record.data.approval).toMatchObject({ approver: "qa-lead", version: 2 });
    const events = parseEventLines(
      await readFile(join(runDir(), "journal", "events.jsonl"), "utf8"),
    ).events.map((e) => e.event);
    expect(events).toContain("plan.revision_requested");
    expect(events).toContain("plan.approved");
  });

  it("REQ-PLAN-04/AC3: manual edits are schema-validated and source-checked before they become a version", async () => {
    await fetched();
    let editRound = 0;
    const edit = async (file: string) => {
      editRound += 1;
      const plan = parse(await readFile(file, "utf8")) as { cases: { title: string; source: unknown[] }[] };
      if (editRound === 1) plan.cases[0]!.source = [{ kind: "quote", text: "Invented by the editor" }];
      else plan.cases[0]!.title = "Edited title";
      await writeFile(file, stringify(plan));
    };
    const result = await run(["plan", "DEMO-1"], { script: fullScript, answers: ["e", "e", "q"], edit });
    expect(result.out).toContain("The edited plan was rejected:\n  - cases.TC-01");
    expect(result.out).toContain("Changes v1 → v2:\n~ TC-01");
  });

  it("REQ-PLAN-05/AC2: approving with open questions needs an explicit 'yes'", async () => {
    await fetched();
    const withQuestions = {
      ...draft,
      open_questions: [{ id: "Q1", question: "Half-up or bankers rounding?" }],
    };
    const result = await run(["plan", "DEMO-1"], {
      script: [fullScript[0]!, { text: JSON.stringify(withQuestions) }],
      answers: ["a", "no", "a", "yes"],
    });
    expect(result.out).toContain("? Q1: Half-up or bankers rounding?");
    const record = JSON.parse(await readFile(join(runDir(), "run.json"), "utf8")) as {
      data: { approval: { openQuestionsConfirmed: boolean } };
    };
    expect(record.data.approval.openQuestionsConfirmed).toBe(true);
  });

  it("REQ-PLAN-06/AC1: qj approve freezes the latest version; a second plan run is refused", async () => {
    await fetched();
    await run(["plan", "DEMO-1"], { script: fullScript });
    const approved = await run(["approve", "DEMO-1"]);
    expect(approved.exitCode).toBe(0);
    expect(approved.out).toMatch(/sha256 [0-9a-f]{64}/);
    expect((await run(["approve", "DEMO-1"])).err).toContain("[PLAN_ALREADY_APPROVED]");
    expect((await run(["plan", "DEMO-1", "--revise", "x"])).err).toContain("[PLAN_ALREADY_APPROVED]");
  });

  it("REQ-PLAN-03/AC2: qj approve re-checks sources of a hand-edited version", async () => {
    await fetched();
    await run(["plan", "DEMO-1"], { script: fullScript });
    const file = join(runDir(), "plan", "plan.v1.yaml");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("kind: ac\n        id: AC1", "kind: ac\n        id: AC9"),
    );
    const result = await run(["approve", "DEMO-1"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("[PLAN_SOURCES_INVALID]");
  });

  it("REQ-PLAN-04: --revise without a terminal writes the next version", async () => {
    await fetched();
    await run(["plan", "DEMO-1"], { script: fullScript });
    const again = await run(["plan", "DEMO-1"]);
    expect(again.out).toContain("Plan v1 exists");
    const revised = await run(["plan", "DEMO-1", "--revise", "Only TC-01"], {
      script: [{ text: JSON.stringify({ ...draft, cases: draft.cases.slice(0, 1) }) }],
    });
    expect(revised.out).toContain("Plan v2: 1 case(s)");
  });

  it("REQ-LLM-04/AC2 + REQ-LLM-07/AC2: invalid output exits 3; an exhausted token budget exits 2 (BLOCKED)", async () => {
    await fetched();
    const invalid = await run(["plan", "DEMO-1"], { script: [{ text: "not json" }] });
    expect(invalid.exitCode).toBe(3);
    expect(invalid.err).toContain("nothing was guessed");
    await writeFile(
      join(project, ".qa", "qa.project.yaml"),
      (await readFile(join(project, ".qa", "qa.project.yaml"), "utf8")).replace(
        "token_budget: 100000",
        "token_budget: 100",
      ),
    );
    const blocked = await run(["plan", "DEMO-1"], { script: fullScript });
    expect(blocked.exitCode).toBe(2);
    expect(blocked.err).toContain("[TOKEN_BUDGET_EXCEEDED]");
  });

  it("refuses to plan before fetch or for unknown tickets", async () => {
    expect((await run(["plan", "DEMO-1"])).err).toContain("[RUN_NOT_FOUND]");
    expect((await run(["plan", "bad"])).err).toContain("[TICKET_KEY_INVALID]");
    expect((await run(["approve", "DEMO-1"])).exitCode).toBe(3);
  });

  it("REQ-LLM-03/AC2: doctor --models probes the configured models", async () => {
    const probe: Turn[] = [{ tools: [{ name: "ping", input: { value: "ok" } }] }, { text: "done" }];
    const result = await run(["doctor", "--models"], {
      // Six tool roles, then summary (text only), then triage (tools).
      script: [...Array.from({ length: 6 }, () => probe).flat(), { text: "done" }, ...probe],
    });
    expect(result.out).toContain("✔ analyst: mock/scripted ok, tool calls work");
    expect(result.out).toContain("✔ summary: mock/scripted ok");
    expect(result.exitCode).toBe(0);
    const broken = await run(["doctor", "--models"], { script: [{ text: "no tools here" }] });
    expect(broken.out).toContain("✘ analyst");
    expect(broken.exitCode).toBe(3);
  });

  it("REQ-CFG-06/AC1: secrets referenced in config are known to the masker before agents run", async () => {
    const yaml = join(project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "jira: { type: file,",
        "jira: { email: secret://env/JIRA_EMAIL, type: file,",
      ),
    );
    await writeFile(join(project, ".env.local"), "JIRA_EMAIL=qa-lead-secret@example.com\n");
    await mkdir(join(project, ".qa", "knowledge"), { recursive: true });
    await writeFile(
      join(project, ".qa", "knowledge", "people.md"),
      "Ask qa-lead-secret@example.com about rounding.",
    );
    await fetched();
    const result = await run(["plan", "DEMO-1"], { script: fullScript });
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("[KNOWLEDGE_CONTAINS_SECRET]");
  });

  it("REQ-PLAN-06/AC1: interactive accept freezes the reviewed version, not a file dropped in later", async () => {
    await fetched();
    const v1 = await run(["plan", "DEMO-1"], { script: fullScript });
    expect(v1.exitCode).toBe(0);
    const planDir = join(runDir(), "plan");
    const smuggled = (await readFile(join(planDir, "plan.v1.yaml"), "utf8"))
      .replace("version: 1", "version: 2")
      .replace("total: 1.01", "total: 9.99");
    const result = await run(["plan", "DEMO-1"], {
      answers: ["a"],
      beforeAnswer: () => writeFile(join(planDir, "plan.v2.yaml"), smuggled),
    });
    expect(result.out).toContain("Approved plan v1");
    const approved = await readFile(join(planDir, "plan.approved.yaml"), "utf8");
    expect(approved).toContain("total: 1.01");
  });
});
