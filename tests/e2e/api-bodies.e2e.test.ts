// REQ-EXEC-45 in the production sandbox: the spec's body helpers run in the child, files and HTTP in the parent.
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxExecutor } from "@qajitsu/adapter-runner-api";
import { PlanSchema } from "@qajitsu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startShop } from "../../examples/demo-shop/api/server.mjs";

const childScript = fileURLToPath(
  new URL("../../packages/adapters/runner-api/dist/child.js", import.meta.url),
);
const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-16",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../fixtures/plans/demo-16-draft.json", import.meta.url), "utf8")),
});
const PASSWORD = "fictional-demo-password";

describe("API bodies in the sandboxed runner (REQ-EXEC-45)", () => {
  let shop: { url: string; close: () => Promise<void> };
  let run: string;
  beforeAll(async () => {
    shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD } });
    run = await mkdtemp(join(tmpdir(), "qj-sandbox-bodies-"));
    await mkdir(join(run, "specs"));
  });
  afterAll(async () => {
    await shop.close();
    await rm(run, { recursive: true, force: true });
  });

  it("REQ-EXEC-45/AC1+AC2 + REQ-EXEC-46/AC1: a multipart upload, a file response and a planned wait work from the sandboxed spec", async () => {
    const login = (await (
      await fetch(`${shop.url}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username: "standard", password: PASSWORD }),
      })
    ).json()) as { token: string };
    for (const id of ["TC-01", "TC-02", "TC-03"]) {
      const spec = join(run, "specs", `${id}.spec.ts`);
      await copyFile(
        fileURLToPath(new URL(`../../fixtures/specs/demo-16/${id}.spec.ts`, import.meta.url)),
        spec,
      );
      const record = await createSandboxExecutor({ childScript })({
        caseId: id,
        attempt: 1,
        plan,
        baseUrl: shop.url,
        allowedOrigins: [shop.url],
        accounts: { "user:standard": { authorization: `Bearer ${login.token}` } },
        secrets: [login.token],
        timeoutMs: 20_000,
        specFile: spec,
      });
      expect(record.error, id).toBeUndefined();
      expect(record.outcome, id).toBe("passed");
    }
  });
});
