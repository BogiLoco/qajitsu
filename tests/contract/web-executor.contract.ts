import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanSchema, type AttemptExecutor, type AttemptRequest } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../examples/demo-shop/api/server.mjs";

const PASSWORD = "fictional-demo-password";
const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-4",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../fixtures/plans/demo-4-draft.json", import.meta.url), "utf8")),
});
const spec = readFileSync(new URL("../../fixtures/specs/demo-4/TC-01.spec.ts", import.meta.url), "utf8");

/**
 * Contract of an executor that drives a browser (REQ-EXEC-05, REQ-GEN-11/AC11): the demo shop's checkout case passes on
 * a correct app and fails with its seeded bug (BUG-05), its verdict coming from the browser's elements.
 *
 * @param name - The executor under test.
 * @param create - Builds the executor with a browser factory for the demo shop's session storage.
 */
export function webExecutorContract(name: string, create: () => Promise<AttemptExecutor>): void {
  describe(`web executor contract: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
    }, 30_000);

    const attempt = async (flag?: string) => {
      const shop = await startShop({
        env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) },
      });
      const dir = await mkdtemp(join(tmpdir(), "qj-web-contract-"));
      cleanups.push(
        () => shop.close(),
        () => rm(dir, { recursive: true, force: true }),
      );
      const specFile = join(dir, "TC-01.spec.ts");
      await writeFile(specFile, spec);
      const login = (await (
        await fetch(`${shop.url}/auth/login`, {
          method: "POST",
          body: JSON.stringify({ username: "standard", password: PASSWORD }),
        })
      ).json()) as { token: string };
      const request: AttemptRequest = {
        specFile,
        caseId: "TC-01",
        attempt: 1,
        plan,
        baseUrl: shop.url,
        allowedOrigins: [shop.url],
        accounts: { "user:standard": { authorization: `Bearer ${login.token}` } },
        sessions: { "user:standard": login.token },
        secrets: [login.token, PASSWORD],
        timeoutMs: 60_000,
      };
      return (await create())(request);
    };

    it("REQ-EXEC-05/AC1: the checkout case passes on a correct app", async () => {
      const record = await attempt();
      expect(record.outcome, JSON.stringify(record.error ?? record.assertions)).toBe("passed");
    }, 120_000);

    it("REQ-EXEC-05/AC1: it fails with the seeded bug, the verdict from the browser's elements", async () => {
      const record = await attempt("BUG_CHECKOUT_BUTTON_DISABLED");
      expect(record.outcome).toBe("failed");
      expect(record.assertions.some((a) => !a.pass && a.field.startsWith("elements."))).toBe(true);
    }, 120_000);
  });
}
