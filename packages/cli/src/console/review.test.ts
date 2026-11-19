import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { analysis, apiService, createBuildProject, draft } from "../../../../tests/support/cli-build.js";
import { gitExec } from "../../../../tests/support/cli-project.js";
import { scriptedModel } from "../../../../tests/support/mock-model.js";
import { consoleActions } from "../commands/console.js";
import { startConsole, type ConsoleActions } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A fetched and planned DEMO-1 (plan v1, not approved) and a console over it with the given buttons. */
const setup = async (actions?: (home: string) => ConsoleActions, config?: string) => {
  const p = await createBuildProject(config === undefined ? undefined : `${apiService()}\n${config}`);
  cleanups.push(p.cleanup);
  expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
  expect((await p.run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }])).exitCode).toBe(0);
  const index = JSON.parse(await readFile(join(p.home, "runs", "DEMO-1", "index.json"), "utf8")) as {
    latest: string;
  };
  const runDir = join(p.home, "runs", "DEMO-1", index.latest);
  const server = await startConsole({
    env: {},
    userHome: p.home,
    token: "fictional-review-token-0123456789abcdef",
    ...(actions ? { actions: actions(p.home) } : {}),
  });
  cleanups.push(server.close);
  const start = new URL(server.url);
  const prefix = start.pathname.replace(/\/signin$/, "");
  const signin = await fetch(server.url, { redirect: "manual" });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const base = `/p/demo/t/DEMO-1/r/${index.latest}`;
  const get = (path: string) => fetch(`${start.origin}${prefix}${path}`, { headers: { cookie } });
  const csrfOf = async () =>
    /name="csrf" value="([^"]+)"/.exec(await (await get(`${base}/review`)).text())?.[1] ?? "";
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${start.origin}${prefix}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: start.origin,
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  return { p, runDir, base, get, post, csrfOf, prefix };
};
/** The ports the real buttons run with (the same mock model as the project's commands). */
const realActions = (home: string, turns: { text: string }[] = [{ text: draft }]): ConsoleActions =>
  consoleActions(
    {
      env: { DEMO_USER_PASSWORD: "fictional-demo-password" },
      home,
      now: () => new Date(),
      random: () => 0.5,
      fetch: globalThis.fetch,
      gitExec,
      extraModels: { mock: () => scriptedModel(turns).mock },
    },
    "qa-lead",
  );

describe("plan review in the console (REQ-WEB-07, REQ-WEB-01/AC3)", () => {
  it("REQ-WEB-07/AC1+AC2+AC3: an edit stores a new version; v1 and v2 side by side with the change, the coverage, then approval freezes v2", async () => {
    const { runDir, base, get, post, csrfOf } = await setup(realActions);
    const first = await (await get(`${base}/review`)).text();
    expect(first).toContain("Coverage (computed by code)");
    expect(first).toContain("Approve and freeze v1");
    // Edit: one case's title changes and one case is dropped.
    const v1 = parse(await readFile(join(runDir, "plan", "plan.v1.yaml"), "utf8")) as {
      cases: { id: string; title: string }[];
    };
    const [one] = v1.cases;
    if (!one) throw new Error("no case");
    one.title = "Cart total is rounded exactly once";
    v1.cases = [one];
    const edited = await post(`${base}/edit`, { csrf: await csrfOf(), plan: stringify(v1) });
    expect(await edited.text()).toContain("Plan v2 stored.");
    expect(edited.status).toBe(200);
    const review = await (await get(`${base}/review`)).text();
    expect(review).toContain(
      "Comparing <strong>v1</strong> (left) with <strong>v2</strong> (right): 0 added, 1 removed, 1 changed.",
    );
    expect(review).toMatch(/class="case changed"><h3>TC-01 Cart total is rounded exactly once/);
    expect(review).toMatch(/class="case removed"><h3>TC-02/);
    // With TC-02 gone something is no longer covered: approval needs the explicit confirmation, as on the CLI.
    expect(review).toContain("Changed but not tested");
    const refused = await post(`${base}/approve`, { csrf: await csrfOf(), version: "2" });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("PLAN_UNCOVERED");
    // The form token belongs to the session, not to a page: taken while the forms are still there.
    const csrf = await csrfOf();
    const approved = await post(`${base}/approve`, {
      csrf,
      version: "2",
      confirm_uncovered: "1",
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("Approved plan v2 of DEMO-1");
    const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as {
      data: { approval: { version: number; approver: string } };
    };
    expect(run.data.approval).toMatchObject({ version: 2, approver: "qa-lead" });
    // Approved and frozen: the screen offers nothing that changes it, and an edit is refused.
    expect(await (await get(`${base}/review`)).text()).toContain("is approved and frozen");
    expect(await (await post(`${base}/edit`, { csrf, plan: stringify(v1) })).text()).toContain(
      "PLAN_ALREADY_APPROVED",
    );
  }, 240_000);

  it("REQ-WEB-01/AC3: a change needs the console's origin, the session's form token and a small form", async () => {
    const calls: string[] = [];
    const fake: ConsoleActions = {
      approve: () => {
        calls.push("approve");
        return Promise.resolve({ ok: true, output: "approved" });
      },
      revise: () => Promise.resolve({ ok: true, output: "" }),
      edit: () => Promise.resolve({ ok: true, output: "" }),
    };
    const { base, post, csrfOf } = await setup(() => fake);
    const csrf = await csrfOf();
    expect(csrf.length).toBeGreaterThan(20);
    // Another site's form (its own Origin), no Origin, no or a wrong token, a JSON body, a huge form: refused.
    expect((await post(`${base}/approve`, { csrf }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(`${base}/approve`, { csrf }, { origin: "" })).status).toBe(403);
    expect((await post(`${base}/approve`, {})).status).toBe(403);
    expect((await post(`${base}/approve`, { csrf: "x".repeat(csrf.length) })).status).toBe(403);
    expect((await post(`${base}/approve`, { csrf }, { "content-type": "application/json" })).status).toBe(
      415,
    );
    expect((await post(`${base}/edit`, { csrf, plan: "x".repeat(600 * 1024) })).status).toBe(413);
    expect(calls).toEqual([]);
    // Exactly the version reviewed: without one nothing is approved.
    expect((await post(`${base}/approve`, { csrf })).status).toBe(400);
    expect((await post(`${base}/approve`, { csrf, version: "latest" })).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await post(`${base}/approve`, { csrf, version: "1" })).status).toBe(200);
    expect(calls).toEqual(["approve"]);
    // An unknown action or a run that does not exist goes nowhere.
    expect((await post(`${base}/delete`, { csrf })).status).toBe(404);
    expect((await post("/p/demo/t/DEMO-1/r/not-a-run/approve", { csrf, version: "1" })).status).toBe(404);
  }, 240_000);

  it("REQ-WEB-07/AC3: revise sends the reviewer's instruction to the planner, which writes the next version", async () => {
    const { runDir, base, post, csrfOf } = await setup(realActions);
    const empty = await post(`${base}/revise`, { csrf: await csrfOf(), instruction: "   " });
    expect(empty.status).toBe(400);
    const revised = await post(`${base}/revise`, {
      csrf: await csrfOf(),
      instruction: "Also check that a second code replaces the first",
    });
    expect(revised.status).toBe(200);
    expect(await revised.text()).toContain("Revising plan v1");
    expect(await readFile(join(runDir, "plan", "plan.v2.yaml"), "utf8")).toContain("TC-01");
    const journal = await readFile(join(runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"plan.version"');
    // Who asked for the revision and what is in the journal, as in the terminal review.
    expect(journal).toMatch(
      /"name":"qa-lead"\},"event":"plan.revision_requested","details":\{"instruction":"Also check that a second code replaces the first"\}/,
    );
  }, 240_000);

  it("REQ-WEB-01/AC3: without buttons configured the console stays read-only", async () => {
    const { base, post, csrfOf } = await setup();
    expect((await post(`${base}/approve`, { csrf: await csrfOf(), version: "1" })).status).toBe(404);
  }, 240_000);

  it("REQ-WEB-07/AC3 + REQ-PLAN-10: the console runs the project's whole approval flow; a model step that asks for a revision freezes nothing", async () => {
    const turns = [
      { text: JSON.stringify({ decision: "revise", reasons: ["TC-02 does not check the rounded total"] }) },
    ];
    const { runDir, base, post, csrfOf } = await setup(
      (home) => realActions(home, turns),
      "approval: { flow: [model, person], model: mock/approver }",
    );
    const answer = await post(`${base}/approve`, { csrf: await csrfOf(), version: "1" });
    const body = await answer.text();
    expect(answer.status).toBe(422);
    expect(body).toContain("TC-02 does not check the rounded total");
    await expect(readFile(join(runDir, "plan", "plan.approved.yaml"), "utf8")).rejects.toThrow();
  }, 240_000);

  it("REQ-WEB-07/AC1: a plan file whose content names another version is not shown or offered for approval", async () => {
    const { runDir, base, get } = await setup();
    const file = join(runDir, "plan", "plan.v1.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^version: 1$/m, "version: 2"));
    const review = await get(`${base}/review`);
    expect(review.status).toBe(404);
    expect(await review.text()).not.toContain("Approve and freeze");
  }, 240_000);
});
