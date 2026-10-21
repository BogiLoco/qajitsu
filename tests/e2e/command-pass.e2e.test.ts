// REQ-NFR-09/AC4: the flows of the exploratory pass that run without a person, on the demo shop: a run watched while it
// runs, publish to the ticket (file mode), export, promote to the tests repository, then the regression suite; and the
// CI helpers with a recorded GitHub event.
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../support/cli-build.js";
import { createDemoPipeline, flowScript } from "../support/cli-pipeline.js";
import { gitExec } from "../support/cli-project.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  });

/** A git repository `demo-org/shop-tests` on the project's local code host, declared as the tests repository. */
const addTestsRepo = async (home: string, project: string) => {
  const repo = join(home, "git", "demo-org", "shop-tests");
  const g = (...args: string[]) =>
    gitExec(["-C", repo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
  await gitExec(["init", "-q", "-b", "main", repo]);
  await mkdir(join(repo, "tests"));
  await writeFile(join(repo, "tests", "cart.spec.ts"), 'test("cart opens", () => {});\n');
  await g("add", ".");
  await g("commit", "-qm", "init");
  const yaml = join(project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace(
      "repos: { shop: { host: local, path: demo-org/demo-shop } }",
      "repos: { shop: { host: local, path: demo-org/demo-shop }, tests: { host: local, path: demo-org/shop-tests, role: tests } }",
    ),
  );
  return { repo, g };
};

describe("exploratory pass flows without a person (REQ-NFR-09/AC4)", () => {
  it("REQ-NFR-09/AC4: watch a run, publish, export, promote the PASSED case and run it again as regression", async () => {
    // Run ids come from the clock and a random suffix; the fixed test clock needs a real suffix for the second run.
    let random = (): number => 0;
    const p = await createDemoPipeline({
      flag: "BUG_CART_TOTAL_ROUNDING",
      ports: { random: () => random() },
    });
    cleanups.push(p.cleanup);
    const tests = await addTestsRepo(p.home, p.project);
    await p.run(["fetch", "DEMO-1"]);
    const [analysis, draft] = flowScript("DEMO-1");
    await p.run(["plan", "DEMO-1"], { script: [analysis as never, draft as never] });
    expect((await p.run(["approve", "DEMO-1"])).exitCode).toBe(0);
    for (const id of ["TC-01", "TC-02"])
      await writeFile(
        join(p.runDir, "specs", `${id}.spec.ts`),
        await readFile(new URL(`../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url)),
      );

    // qj watch serves the run's progress while it runs, and the computed statuses once it finished.
    const port = await freePort();
    const signals = new EventEmitter();
    const watching = p.run(["watch", "DEMO-1", "--port", String(port)], { signals });
    const progress = async () =>
      (await (await fetch(`http://127.0.0.1:${String(port)}/progress.json`)).json()) as {
        state: string;
        cases: { id: string; status?: string }[];
      };
    for (let i = 0; i < 50; i += 1) {
      if (
        await progress().then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await progress()).state).toBe("not started");
    const ran = await p.run(["run", "DEMO-1"]);
    expect(ran.exitCode).toBe(1);
    const after = await progress();
    expect(after.state).toBe("finished");
    expect(after.cases.map((c) => [c.id, c.status])).toEqual([
      ["TC-01", "FAILED"],
      ["TC-02", "PASSED"],
    ]);
    signals.emit("SIGINT");
    expect((await watching).exitCode).toBe(0);

    // Publish (file mode: the comment is written where Jira would get it) and export for a pipeline.
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.out).toContain("Published DEMO-1 comment");
    expect(await readdir(join(p.runDir, "report", "published"))).toContain("jira-comment.wiki.txt");
    const exported = await p.run(["export", "DEMO-1", "--out", "artifacts"]);
    expect(exported.exitCode).toBe(1);
    expect(exported.out).toContain(
      "Statuses: 1 FAILED, 1 PASSED; exit code 1 (a FAILED case fails the pipeline step)",
    );

    // Promote the PASSED case, merge it like a reviewer would, and run the regression suite without models.
    const promoted = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(promoted.exitCode).toBe(0);
    expect(promoted.out).toContain("Not promoted (not PASSED): TC-01: FAILED");
    const branch = /branch (qajitsu\/demo-1-[\w-]+)/.exec(promoted.out)?.[1] ?? "";
    await tests.g("merge", "-q", branch);
    random = Math.random;
    const regression = await p.run(["regression"]);
    expect(regression.err).toBe("");
    expect(regression.out).toContain("NO REGRESSIONS: 1 case(s) in 1 pack(s): 1 PASSED.");
    // Found in the pass: a run without models estimated "models ≈ 0k tokens (cost unknown ...)".
    expect(regression.out).toMatch(/Estimate: 1 api execution\(s\) ≈ \d+ s; no models;/);
    expect(regression.exitCode).toBe(0);
  }, 300_000);

  it("REQ-NFR-09/AC4: the CI helpers with a recorded GitHub event: detect, post the plan, and refuse a change of an unknown host", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await mkdtemp(join(tmpdir(), "qj-ci-event-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, "event.json"),
      JSON.stringify({
        pull_request: {
          number: 12,
          title: "Cart",
          html_url: "https://github.com/o/r/pull/12",
          labels: [{ name: "qa-agent" }],
          head: { ref: "feature/DEMO-1-cart", sha: "a".repeat(40) },
        },
      }),
    );
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_OUTPUT: join(dir, "out"),
    };
    const detected = await p.run(["ci", "detect"], undefined, { env });
    expect(detected.exitCode).toBe(0);
    expect(await readFile(join(dir, "out"), "utf8")).toContain("run=true\nticket=DEMO-1");
    await p.prepare();
    const posted = await p.run(["ci", "publish-plan", "DEMO-1"]);
    expect(posted.exitCode).toBe(0);
    expect(posted.out).toContain("the plan on DEMO-1");
    const refused = await p.run(["ci", "comment", "DEMO-1", "--change", "https://github.com/o/r/pull/12"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("CI_CHANGE_UNKNOWN");
  }, 300_000);
});
