import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createContractValidator, loadContractValidator } from "./openapi.js";
import { applyContract } from "./run-cases.js";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../../../../examples/demo-shop/api/openapi.yaml", import.meta.url));
const doc = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const base = "http://127.0.0.1:3000";

describe("OpenAPI contract (REQ-EXEC-04/AC2)", () => {
  const contract = createContractValidator(doc);
  it("accepts responses that match their schema, with $refs", () => {
    expect(
      contract.check("GET", `${base}/cart`, 200, { lines: [], discounts: [], subtotal: 0, total: 0 }),
    ).toEqual([]);
    expect(contract.check("POST", `${base}/orders`, 422, { error: "INVALID_QUANTITY" })).toEqual([]);
  });
  it("reports schema violations and undeclared statuses", () => {
    expect(
      contract
        .check("POST", `${base}/orders`, 201, { id: "O-1", product_id: "P-2", quantity: -1, total: -24.99 })
        ?.join("\n"),
    ).toContain("body/quantity must be >= 1");
    expect(
      contract
        .check("POST", `${base}/cart/discount`, 200, {
          lines: [],
          discounts: ["SAVE10", "SAVE20"],
          subtotal: 1,
          total: 1,
        })
        ?.join(),
    ).toContain("must NOT have more than 1 items");
    expect(contract.check("GET", `${base}/me`, 500, {})).toEqual([
      "GET /me returned 500, which the OpenAPI document does not declare",
    ]);
  });
  it("skips operations the document does not describe", () => {
    expect(contract.check("GET", `${base}/unknown`, 200, {})).toBeUndefined();
    expect(contract.check("DELETE", `${base}/cart`, 200, {})).toBeUndefined();
    expect(
      createContractValidator({
        paths: { "/items/{id}": { get: { responses: { "2XX": { description: "x" } } } } },
      }).check("GET", `${base}/items/7`, 204, null),
    ).toEqual([]);
  });
  it("loads YAML and JSON documents", async () => {
    expect((await loadContractValidator(file)).check("GET", `${base}/health`, 200, { status: "ok" })).toEqual(
      [],
    );
  });

  it("REQ-EXEC-04/AC2 + REQ-EVD-07/AC1: every recorded call is validated, also one without verify(); violations fail the attempt; passing checks never count as verify()", () => {
    const evidence = (body: unknown) => [
      {
        stepId: "S1",
        kind: "response" as const,
        name: "S1-01.json",
        content: JSON.stringify({ method: "POST", url: `${base}/orders`, response: { status: 201, body } }),
      },
    ];
    const record = {
      caseId: "TC-01",
      attempt: 1,
      outcome: "passed" as const,
      steps: [{ id: "S1", ok: true }],
      assertions: [],
      evidence: evidence({ id: "O-1", product_id: "P-2", quantity: 2, total: 49.98 }),
    };
    expect(applyContract(record, contract)).toBe(record);
    const bad = applyContract(
      { ...record, evidence: evidence({ id: "O-1", product_id: "P-2", quantity: -1, total: -1 }) },
      contract,
    );
    expect(bad.outcome).toBe("failed");
    expect(bad.assertions[0]).toMatchObject({ stepId: "S1", field: "openapi", pass: false });
    expect(applyContract(record, undefined)).toBe(record);
    const unparsable = { ...record, evidence: [{ ...record.evidence[0]!, content: "not json" }] };
    expect(applyContract(unparsable, contract)).toBe(unparsable);
  });
});
