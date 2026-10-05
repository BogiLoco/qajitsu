// The repository's own CI (REQ-NFR-05/AC4): new dependencies are reviewed on every pull request and known
// vulnerabilities in the installed tree fail the build.
import { readFile } from "node:fs/promises";
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
