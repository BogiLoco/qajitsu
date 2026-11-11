// The repository's own CI (REQ-NFR-05/AC4): new dependencies are reviewed on every pull request and known
// vulnerabilities in the installed tree fail the build.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}
interface Workflow {
  readonly jobs: Record<string, { readonly if?: string; readonly steps: readonly Step[] }>;
}

const workflow = async (): Promise<Workflow> =>
  parse(await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as Workflow;

describe("CI dependency review (REQ-NFR-05/AC4)", () => {
  it("REQ-NFR-05/AC4: pull requests fail on new dependencies with high vulnerabilities or copyleft licences", async () => {
    const job = (await workflow()).jobs["dependency-review"];
    expect(job?.if).toBe("github.event_name == 'pull_request'");
    const review = job?.steps.find((s) => s.uses?.startsWith("actions/dependency-review-action@"));
    expect(review?.with).toMatchObject({ "fail-on-severity": "high" });
    expect(String(review?.with?.["deny-licenses"])).toMatch(/AGPL-3\.0.*GPL-3\.0/);
  });

  it("REQ-NFR-05/AC4: every build audits the installed dependencies for high vulnerabilities", async () => {
    const steps = (await workflow()).jobs["verify"]?.steps ?? [];
    expect(steps.some((s) => s.run === "pnpm audit --audit-level high")).toBe(true);
    const workspace = await readFile(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8");
    // Every ignored advisory carries its reason: a comment between `ignoreGhsas:` and the id.
    const ignored =
      (parse(workspace) as { auditConfig?: { ignoreGhsas?: string[] } }).auditConfig?.ignoreGhsas ?? [];
    const list = workspace.slice(workspace.indexOf("ignoreGhsas:"));
    for (const id of ignored) {
      const before = list.slice(0, list.indexOf(id));
      expect(before, id).toMatch(/^\s+# \S.{20,}$/m);
    }
  });
});

describe("contributor experience (REQ-NFR-06/AC2)", () => {
  it("REQ-NFR-06/AC2: CI runs the CONTRIBUTING commands on a fresh runner without caches within five minutes", async () => {
    const job = (await workflow()).jobs["contributor-setup"];
    const step = job?.steps.find((s) => s.run === "pnpm install && pnpm verify") as
      (Step & { readonly "timeout-minutes"?: number }) | undefined;
    expect(step?.["timeout-minutes"]).toBe(5);
    expect(
      job?.steps.some((s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["cache"] !== undefined),
    ).toBe(false);
    const contributing = await readFile(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8");
    expect(contributing).toContain("`pnpm install && pnpm verify`");
  });
});

describe("fast and full verification (REQ-NFR-06/AC2, REQ-NFR-02)", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = (...args: string[]) => {
    const r = spawnSync(
      process.execPath,
      [`${root}node_modules/vitest/vitest.mjs`, "list", "--filesOnly", ...args],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    return r.stdout
      .split("\n")
      .map((l) => l.replace(/^\[[^\]]+\]\s*|^\|[^|]+\|\s*/, "").trim())
      .filter((l) => l !== "");
  };

  it("REQ-NFR-06/AC2: every test runs in exactly one of the unit and integration projects; none is lost", () => {
    const unit = files("--project", "unit");
    const integration = files("--project", "integration");
    const all = files();
    expect(unit.length).toBeGreaterThan(100);
    expect(integration.length).toBeGreaterThan(10);
    expect(unit.filter((f) => integration.includes(f))).toEqual([]);
    expect([...unit, ...integration].sort()).toEqual([...all].sort());
    // The trust core's own tests are unit tests: a fast verify runs every one of them.
    for (const core of ["packages/guard/", "packages/verifier/", "packages/steps/", "tests/adversarial/"])
      expect(
        integration.filter((f) => f.includes(core)),
        core,
      ).toEqual([]);
  }, 60_000);

  it("REQ-NFR-02 + REQ-NFR-06/AC2: verify runs the unit tests; CI and the release run everything with coverage", async () => {
    const scripts = (
      JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const parts = (name: string) => (scripts[name] ?? "").split("&&").map((p) => p.trim());
    expect(parts("verify")).toContain("pnpm test:unit");
    expect(parts("verify")).not.toContain("pnpm test:coverage");
    expect(parts("verify:full")).toContain("pnpm test:coverage");
    // Both run the same checks around the tests.
    const around = (name: string) =>
      parts(name).filter((p) => !p.startsWith("pnpm test:unit") && !p.startsWith("pnpm test:coverage"));
    expect(around("verify")).toEqual(around("verify:full"));
    expect(scripts["test:coverage"]).toBe("vitest run --coverage");
    const ci = await workflow();
    expect(ci.jobs["verify"]?.steps.some((s) => s.run === "pnpm verify:full")).toBe(true);
    const release = parse(
      await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
    ) as Workflow;
    expect(release.jobs["test"]?.steps.some((s) => s.run === "pnpm verify:full")).toBe(true);
  });
});
