// Adversarial suite: the traffic analysis of a web attempt finds a contract violation, a leaked token, a slow
// request and missing headers (REQ-EVD-09/AC3..AC7). None of it may change a status or a count (invariants 1 and 6):
// a PASSED stays PASSED, a FAILED stays FAILED, and the findings are only observations with their HAR entry.
import { checkUiContract, createContractValidator } from "@qajitsu/adapter-runner-api";
import { NETWORK_ANALYSIS_FILE, type NetworkAnalysis } from "@qajitsu/core";
import { collectObservations } from "@qajitsu/report";
import type { AttemptRecord } from "@qajitsu/steps";
import { computeStatus } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";

const contract = createContractValidator({
  openapi: "3.0.3",
  info: { title: "shop", version: "1" },
  paths: {
    "/api/cart": {
      get: {
        responses: {
          "200": {
            description: "cart",
            content: {
              "application/json": {
                schema: { type: "object", required: ["total"], properties: { total: { type: "number" } } },
              },
            },
          },
        },
      },
    },
  },
});

const analysis: NetworkAnalysis = {
  steps: [
    {
      stepId: "S1",
      requests: 40,
      bytes: 9_000_000,
      slowest: [{ stepId: "S1", method: "GET", url: "/api/cart", har: 3, durationMs: 9000 }],
      warnings: ["GET /api/cart took 9000 ms, the budget is 500 ms"],
    },
  ],
  security: [
    {
      stepId: "S1",
      method: "GET",
      url: "https://analytics.example/c",
      har: 5,
      kind: "secret-in-url",
      detail: 'query parameter "access_token" carries a token or secret',
    },
  ],
  contract: [],
  bodies: [{ stepId: "S1", method: "GET", url: "/api/cart", har: 3, status: 200, body: { total: "ten" } }],
  endpoints: [{ method: "GET", path: "/api/cart", status: 200 }],
};

const attempt = (outcome: AttemptRecord["outcome"]): AttemptRecord => ({
  caseId: "TC-01",
  attempt: 1,
  outcome,
  steps: [{ id: "S1", ok: outcome === "passed" }],
  assertions: [
    {
      stepId: "S1",
      field: "status",
      expected: 200,
      actual: outcome === "passed" ? 200 : 500,
      pass: outcome === "passed",
    },
  ],
  evidence: [{ stepId: "case", kind: "log", name: NETWORK_ANALYSIS_FILE, content: JSON.stringify(analysis) }],
});

const statusOf = (record: AttemptRecord) =>
  computeStatus({ caseId: "TC-01", attempts: [record] }, { evidenceComplete: true });

describe("the traffic analysis never decides a status (REQ-EVD-09/AC7, invariants 1 and 6)", () => {
  it("REQ-EVD-09/AC3+AC7: a contract violation in the page's traffic is an observation with its HAR entry, not a failure", () => {
    const passed = attempt("passed");
    const checked = checkUiContract(passed, contract);
    expect(checked.outcome).toBe("passed");
    expect(checked.assertions).toEqual(passed.assertions);
    expect(statusOf(checked)).toBe("PASSED");
    const written = JSON.parse(String(checked.evidence[0]?.content)) as NetworkAnalysis;
    expect(written.contract).toHaveLength(1);
    expect(written.contract[0]).toMatchObject({
      stepId: "S1",
      method: "GET",
      url: "/api/cart",
      har: 3,
      status: 200,
    });
  });

  it("REQ-EVD-09/AC7: a FAILED stays FAILED whatever the analysis says, and observations are no counts", () => {
    const failed = checkUiContract(attempt("failed"), contract);
    expect(statusOf(failed)).toBe("FAILED");
    const observations = collectObservations([
      {
        caseId: "TC-01",
        assertions: failed.assertions,
        networkFile: String(checkUiContract(attempt("passed"), contract).evidence[0]?.content),
      },
    ]);
    expect(observations.map((o) => o.kind)).toEqual(["ui-contract", "security", "performance"]);
    expect(observations.every((o) => o.text.includes("network.har #") || o.kind === "performance")).toBe(
      true,
    );
  });

  it("REQ-EVD-09/AC3: an analysis that is broken or forged is left as it is, never turned into a result", () => {
    const forged: AttemptRecord = {
      ...attempt("passed"),
      evidence: [
        { stepId: "case", kind: "log", name: NETWORK_ANALYSIS_FILE, content: '{"steps": "PASSED"}' },
      ],
    };
    expect(checkUiContract(forged, contract)).toEqual(forged);
    const broken: AttemptRecord = {
      ...attempt("passed"),
      evidence: [{ stepId: "case", kind: "log", name: NETWORK_ANALYSIS_FILE, content: "{" }],
    };
    expect(checkUiContract(broken, contract)).toEqual(broken);
    expect(checkUiContract(attempt("passed"), undefined)).toEqual(attempt("passed"));
    expect(collectObservations([{ caseId: "TC-01", assertions: [], networkFile: "{" }])).toEqual([]);
    const oddUrl: AttemptRecord = {
      ...attempt("passed"),
      evidence: [
        {
          stepId: "case",
          kind: "log",
          name: NETWORK_ANALYSIS_FILE,
          content: JSON.stringify({ ...analysis, bodies: [{ ...analysis.bodies[0], url: "http://[" }] }),
        },
      ],
    };
    expect(checkUiContract(oddUrl, contract)).toEqual(oddUrl);
    const clean = { ...attempt("passed"), evidence: [] };
    expect(checkUiContract(clean, contract)).toEqual(clean);
  });
});
