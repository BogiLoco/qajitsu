// Adversarial suite: test data that tries to borrow another run's marker, or to turn a setup failure into a pass
// (REQ-EXEC-53, invariant 1).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import { runCases } from "@qajitsu/adapter-runner-api";
import { PlanSchema, createEventLog, parseProjectConfig, type TestDataProvider } from "@qajitsu/core";
import { computeStatus } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";
import { createTestDataProvider } from "../../packages/cli/src/test-data.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-17",
  version: 1,
  summary: "Low stock.",
  cases: [
    {
      id: "TC-01",
      title: "Three left",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      // The planner (a model) tries to reuse another run's marker, so its record would be removed by that run.
      test_data: [{ name: "lamp", kind: "product", with: { stock: 3, qa_marker: "qj-DEMO-1-other-run" } }],
      steps: [{ id: "S1", action: "GET /products/{id}", expect: { description: "Low", status: 200 } }],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

describe("test data stays with its own attempt (REQ-EXEC-53)", () => {
  it("REQ-EXEC-53/AC2: a record always carries its own attempt's marker, whatever the plan writes", async () => {
    const bodies: unknown[] = [];
    const provider = createTestDataProvider({
      config: parseProjectConfig({
        project: "demo",
        jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
        test_data: { kinds: { product: { create: { request: "POST /admin/products" } } } },
      }).test_data!,
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins: ["http://127.0.0.1:3000"],
      fetch: (_: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
        return Promise.resolve(new Response('{"id":"P-1"}', { status: 201 }));
      },
      headersFor: () => Promise.resolve({}),
      qaDir: "/project/.qa",
    });
    await provider.create({
      name: "lamp",
      kind: "product",
      with: plan.cases[0]!.test_data![0]!.with,
      marker: "qj-DEMO-17-r-TC-01-a1",
    });
    expect(bodies).toEqual([{ stock: 3, qa_marker: "qj-DEMO-17-r-TC-01-a1" }]);
  });

  it("invariant 1 + REQ-EXEC-53/AC3: data that cannot be created is BLOCKED, never PASSED, and no step runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-adv-data-"));
    try {
      let executed = 0;
      const provider: TestDataProvider = {
        create: () => Promise.reject(new Error("503 Service Unavailable")),
        remove: () => Promise.resolve(),
        cleanup: () => Promise.resolve(0),
      };
      const results = await runCases({
        plan,
        specs: new Map([["TC-01", join(dir, "TC-01.spec.ts")]]),
        // An executor that would claim a pass if it were ever called.
        executor: (input) => {
          executed += 1;
          return Promise.resolve({
            caseId: input.caseId,
            attempt: input.attempt,
            outcome: "passed",
            steps: [{ id: "S1", ok: true }],
            assertions: [{ stepId: "S1", field: "status", expected: 200, actual: 200, pass: true }],
            evidence: [],
          });
        },
        evidence: createLocalEvidenceStore(join(dir, "evidence")),
        resultsDir: join(dir, "results"),
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins: ["http://127.0.0.1:3000"],
        login: () => Promise.resolve({ accounts: {}, secrets: [] }),
        events: createEventLog({
          ticket: "DEMO-17",
          run: "r",
          write: () => undefined,
          now: () => new Date(0),
          mask: (v) => v,
        }),
        now: () => new Date(0),
        testData: provider,
      });
      expect(executed).toBe(0);
      const result = results.get("TC-01");
      expect(result && computeStatus(result, { evidenceComplete: true })).toBe("BLOCKED");
      // Without any provider a case with test data is BLOCKED too.
      const none = await runCases({
        plan,
        specs: new Map([["TC-01", join(dir, "TC-01.spec.ts")]]),
        executor: () => Promise.reject(new Error("never called")),
        evidence: createLocalEvidenceStore(join(dir, "evidence2")),
        resultsDir: join(dir, "results2"),
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins: ["http://127.0.0.1:3000"],
        login: () => Promise.resolve({ accounts: {}, secrets: [] }),
        events: createEventLog({
          ticket: "DEMO-17",
          run: "r",
          write: () => undefined,
          now: () => new Date(0),
          mask: (v) => v,
        }),
        now: () => new Date(0),
        retries: 0,
      });
      const blocked = none.get("TC-01");
      expect(blocked?.attempts[0]?.error).toContain("the project configures no test_data");
      expect(blocked && computeStatus(blocked, { evidenceComplete: true })).toBe("BLOCKED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
