// Adversarial suite from the stage-2 integrity and security reviews: each test failed before its fix.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadOnlyTools } from "@qajitsu/agents";
import { PlanSchema, TicketKeySchema, selectExecutableSpecs, type Ticket } from "@qajitsu/core";
import { DEFAULT_PROTECTED_PATHS, evaluateToolCall, type GuardPolicy } from "@qajitsu/guard";
import { checkSource } from "@qajitsu/verifier";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("invariant 8: read tools cannot be tricked into leaking files (REQ-CTX-05/AC1)", () => {
  it("a symlink committed in a PR cannot read files outside the run folder or under env/", async () => {
    const base = await mkdtemp(join(tmpdir(), "qj-adv-link-"));
    roots.push(base);
    const run = join(base, "run");
    await mkdir(join(run, "repos", "app"), { recursive: true });
    await mkdir(join(run, "env"), { recursive: true });
    await writeFile(join(base, "outside-secret.txt"), "TOP_SECRET=abc");
    await writeFile(join(run, "env", "app.env"), "DB_PASSWORD=x");
    await symlink(join(base, "outside-secret.txt"), join(run, "repos", "app", "README.md"));
    await symlink(join(run, "env", "app.env"), join(run, "repos", "app", "setup.md"));
    await symlink(join(run, "env"), join(run, "repos", "app", "docs"));
    const tools = Object.fromEntries(
      createReadOnlyTools({ root: run, mask: (t) => t }).map((t) => [t.name, t]),
    );
    await expect(tools["read_file"]!.execute({ path: "repos/app/README.md" })).rejects.toThrow();
    await expect(tools["read_file"]!.execute({ path: "repos/app/setup.md" })).rejects.toThrow();
    await expect(tools["read_file"]!.execute({ path: "repos/app/docs/app.env" })).rejects.toThrow();
    await expect(tools["list_files"]!.execute({ path: "repos/app/docs" })).rejects.toThrow();
  });

  it("case variants of env/ and .env are refused (case-insensitive file systems)", async () => {
    const run = await mkdtemp(join(tmpdir(), "qj-adv-case-"));
    roots.push(run);
    await mkdir(join(run, "env"));
    await writeFile(join(run, "env", "x.yaml"), "PW=hunter2");
    const tools = Object.fromEntries(
      createReadOnlyTools({ root: run, mask: (t) => t }).map((t) => [t.name, t]),
    );
    await expect(tools["read_file"]!.execute({ path: "ENV/x.yaml" })).rejects.toThrow();
    await expect(tools["read_file"]!.execute({ path: "repos/.ENV" })).rejects.toThrow();
    await expect(tools["read_file"]!.execute({ path: "repos/app/.git/config" })).rejects.toThrow();
  });
});

describe("invariants 2 and 3: protected paths hold regardless of case (REQ-VER-03)", () => {
  const policy: GuardPolicy = {
    workspaceRoot: "/runs/r",
    allowedTools: new Set(["write_file"]),
    writeTools: new Set(["write_file"]),
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    networkTools: new Set(),
    allowedOrigins: [],
  };
  it.each([
    "Results/TC-01.json",
    "EVIDENCE/manifest.json",
    "RUN.JSON",
    "Plan/plan.approved.yaml",
    "plan/plan.v99.yaml",
    "plan/plan.edit.yaml",
  ])("denies agent writes to %s", (path) => {
    expect(evaluateToolCall({ tool: "write_file", input: { path, content: "x" } }, policy)).toMatchObject({
      allowed: false,
      code: "PROTECTED_PATH",
    });
  });
});

describe("REQ-PLAN-03: trivial quotes do not ground a case", () => {
  const ticket: Ticket = {
    key: TicketKeySchema.parse("DEMO-1"),
    summary: "Cart total with discount codes",
    description: "The cart endpoint returns line totals.",
    issueType: "Story",
    status: "Ready",
    labels: [],
    components: [],
    acceptanceCriteria: ["Codes never stack."],
    comments: [],
    linkedKeys: [],
    attachments: [],
    developmentLinks: [],
  };
  it.each(["the", "cart", "Cart total", "discount codes The cart"])("rejects the quote %j", (text) => {
    expect(checkSource({ kind: "quote", text }, { ticket, diffs: {}, comments: {} })).toBeDefined();
  });
  it("still accepts a real quote from one field", () => {
    expect(
      checkSource(
        { kind: "quote", text: "The cart endpoint returns line totals" },
        { ticket, diffs: {}, comments: {} },
      ),
    ).toBeUndefined();
  });
});

describe("REQ-PLAN-06/AC4: only one spec per approved case, directly in specs/", () => {
  it("extra or nested spec files for an approved case are not executed", () => {
    const plan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-1",
      version: 1,
      cases: [
        {
          id: "TC-01",
          title: "x x",
          type: "api",
          priority: "high",
          source: [{ kind: "ac", id: "AC1" }],
          steps: [{ id: "S1", action: "a", expect: { description: "d" } }],
          evidence: ["response"],
        },
      ],
    });
    const { execute, rejected } = selectExecutableSpecs(
      plan,
      ["/r/specs/TC-01.spec.ts", "/r/specs/TC-01-extra.spec.ts", "/r/specs/sub/TC-01.spec.ts"],
      "/r/specs",
    );
    expect(execute).toEqual(["/r/specs/TC-01.spec.ts"]);
    expect(rejected).toEqual(["/r/specs/TC-01-extra.spec.ts", "/r/specs/sub/TC-01.spec.ts"]);
  });
});
