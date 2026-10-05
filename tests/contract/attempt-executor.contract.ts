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
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
});
const spec = readFileSync(new URL("../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url), "utf8");

/** Spec variants: the honest fixture, one that lies about expected and actual values, one that crashes. */
const SPECS = {
  honest: spec,
  lying: spec.replace(
    'verify("S1", "fields.total", res.json("total"), plan.expect("TC-01.S1.fields.total"));',
    'verify("S1", "fields.total", 1.01, 1.01);',
  ),
  crashing: spec.replace("await shopper.post(", 'throw new Error("boom"); await shopper.post('),
  wrongCase: spec.replace('export const caseId = "TC-01";', 'export const caseId = "TC-02";'),
};

/**
 * Shared contract of every AttemptExecutor (REQ-GEN-02/AC3, ADR-0004, ADR-0005, invariant 1): the record says
 * what the trusted parent observed. Expected values come from the approved plan and actual values from the parent's
 * own response, whatever the spec claims; a crash or a spec of another case is never a pass.
 *
 * @param name - Implementation name for test titles.
 * @param create - Builds the executor.
 */
export function attemptExecutorContract(name: string, create: () => AttemptExecutor): void {
  describe(`AttemptExecutor contract: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
    });

    const attempt = async (variant: keyof typeof SPECS, flag?: string) => {
      const shop = await startShop({
        env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) },
      });
      const dir = await mkdtemp(join(tmpdir(), "qj-exec-contract-"));
      cleanups.push(
        () => shop.close(),
        () => rm(dir, { recursive: true, force: true }),
      );
      const specFile = join(dir, "TC-01.spec.ts");
      await writeFile(specFile, SPECS[variant]);
      const login = (await (
        await fetch(`${shop.url}/auth/login`, {
          method: "POST",
          body: JSON.stringify({ username: "standard", password: PASSWORD }),
        })
      ).json()) as { token: string };
      const request: AttemptRequest = {
        specFile,
        caseId: "TC-01",
        attempt: 2,
        plan,
        baseUrl: shop.url,
        allowedOrigins: [shop.url],
        accounts: { "user:standard": { authorization: `Bearer ${login.token}` } },
        secrets: [login.token, PASSWORD],
        timeoutMs: 20_000,
      };
      return create()(request);
    };

    it("REQ-GEN-02/AC3 + REQ-VER-02: an honest spec on a correct app passes with expectations from the plan", async () => {
      const record = await attempt("honest");
      expect(record).toMatchObject({ caseId: "TC-01", attempt: 2, outcome: "passed" });
      expect(record.assertions.find((a) => a.field === "fields.total")).toMatchObject({
        expected: 1.01,
        actual: 1.01,
        pass: true,
      });
      expect(record.evidence.length).toBeGreaterThan(0);
    }, 60_000);

    it("REQ-GEN-02/AC3 + invariant 1: a spec claiming its own values cannot hide a bug", async () => {
      const record = await attempt("lying", "BUG_CART_TOTAL_ROUNDING");
      expect(record.outcome).toBe("failed");
      expect(record.assertions.find((a) => a.field === "fields.total")).toMatchObject({
        expected: 1.01,
        actual: 1.02,
        pass: false,
      });
    }, 60_000);

    it("REQ-GEN-02/AC3: a crashing spec or a spec of another case is never a pass", async () => {
      for (const variant of ["crashing", "wrongCase"] as const) {
        const record = await attempt(variant);
        expect(record.outcome, variant).not.toBe("passed");
      }
    }, 60_000);

    it("REQ-GEN-02/AC3 + invariant 8: secrets of the request never appear in the record", async () => {
      const record = await attempt("honest");
      const text = JSON.stringify(record, (_k, v: unknown) =>
        v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v,
      );
      expect(text).not.toContain(PASSWORD);
    }, 60_000);
  });
}
