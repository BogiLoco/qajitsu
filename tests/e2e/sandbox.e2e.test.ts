// The API runner's sandbox, as used in production: a separate Node process with the permission model.
import { mkdir, mkdtemp, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSandboxExecutor, type AttemptInput } from "@qajitsu/adapter-runner-api";
import { PlanSchema } from "@qajitsu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startShop } from "../../examples/demo-shop/api/server.mjs";
import { attemptExecutorContract } from "../contract/attempt-executor.contract.js";

const childScript = fileURLToPath(
  new URL("../../packages/adapters/runner-api/dist/child.js", import.meta.url),
);
const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
});
const PASSWORD = "fictional-demo-password";

attemptExecutorContract("sandbox (production)", () => createSandboxExecutor({ childScript }));

describe("sandboxed API runner (REQ-EXEC-04, invariant 2)", () => {
  let shop: { url: string; close: () => Promise<void> };
  let run: string;
  let input: Omit<AttemptInput, "specFile">;
  beforeAll(async () => {
    shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD } });
    run = await mkdtemp(join(tmpdir(), "qj-sandbox-"));
    await mkdir(join(run, "specs"));
    await mkdir(join(run, "results"));
    await mkdir(join(run, "env"));
    await writeFile(join(run, "env", "app.env"), "DB_PASSWORD=very-secret-db-pw");
    const login = (await (
      await fetch(`${shop.url}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username: "standard", password: PASSWORD }),
      })
    ).json()) as { token: string };
    input = {
      caseId: "TC-01",
      attempt: 1,
      plan,
      baseUrl: shop.url,
      allowedOrigins: [shop.url],
      accounts: { "user:standard": { authorization: `Bearer ${login.token}` } },
      secrets: [login.token],
      timeoutMs: 20_000,
    };
  });
  afterAll(async () => {
    await shop.close();
    await rm(run, { recursive: true, force: true });
  });

  it("runs a TypeScript spec in the sandbox and records assertions and evidence", async () => {
    const spec = join(run, "specs", "TC-01.spec.ts");
    await copyFile(
      fileURLToPath(new URL("../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url)),
      spec,
    );
    const record = await createSandboxExecutor({ childScript })({ ...input, specFile: spec });
    expect(record.error).toBeUndefined();
    expect(record.outcome).toBe("passed");
    expect(record.assertions.every((a) => a.pass)).toBe(true);
    expect(record.evidence).toHaveLength(2);
  });

  it("REQ-EXEC-16/AC3+AC4: the trusted parent pauses before a step, without counting the wait; stop errors the attempt", async () => {
    const spec = join(run, "specs", "TC-01.spec.ts");
    await copyFile(
      fileURLToPath(new URL("../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url)),
      spec,
    );
    const paused = await createSandboxExecutor({ childScript })({
      ...input,
      specFile: spec,
      timeoutMs: 4000,
      pause: async () => {
        await new Promise((r) => setTimeout(r, 4500));
        return "continue";
      },
    });
    expect(paused.outcome).toBe("passed");
    const stopped = await createSandboxExecutor({ childScript })({
      ...input,
      specFile: spec,
      pause: () => Promise.resolve("stop"),
    });
    expect(stopped.outcome).toBe("error");
    expect(stopped.error).toContain("stopped by the tester before S1");
  }, 30_000);

  it.each([
    [
      "writes a PASSED result file",
      `const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(join("RUN", "results", "TC-01.json"))}, '{"status":"PASSED"}');`,
    ],
    [
      "reads the generated env file",
      `const fs = await import("node:fs"); throw new Error(fs.readFileSync(${JSON.stringify(join("RUN", "env", "app.env"))}, "utf8"));`,
    ],
    [
      "spawns a shell",
      `const cp = await import("node:child_process"); cp.execSync("touch " + ${JSON.stringify(join("RUN", "results", "pwned"))});`,
    ],
    [
      "reads secrets from the environment",
      `if (process.env.DEMO_USER_PASSWORD) throw new Error("leak " + process.env.DEMO_USER_PASSWORD);`,
    ],
  ])("a malicious spec that %s cannot succeed", async (_, body) => {
    const spec = join(run, "specs", "TC-01.spec.ts");
    await writeFile(
      spec,
      `export const caseId = "TC-01";\nexport async function run(ctx) {\n${body.replaceAll("RUN", run)}\n await ctx.step("S1", async () => { await ctx.api.as("user:standard").get("/cart"); ctx.verify("S1", "status", 200, ctx.plan.expect("TC-01.S1.status")); });\n}\n`,
    );
    process.env["DEMO_USER_PASSWORD"] = PASSWORD;
    const record = await createSandboxExecutor({ childScript })({ ...input, specFile: spec });
    delete process.env["DEMO_USER_PASSWORD"];
    if (body.includes("process.env")) {
      expect(record.outcome).toBe("passed");
    } else {
      expect(record.outcome).toBe("error");
    }
    expect(JSON.stringify(record)).not.toContain("very-secret-db-pw");
    expect(JSON.stringify(record)).not.toContain(PASSWORD);
    expect(await readdir(join(run, "results"))).toEqual([]);
  });
});
