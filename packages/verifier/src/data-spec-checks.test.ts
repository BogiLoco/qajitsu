import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkSpecSource } from "./spec-checks.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-17",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-17-draft.json", import.meta.url), "utf8")),
});
const spec = (id: string) =>
  readFileSync(new URL(`../../../fixtures/specs/demo-17/${id}.spec.ts`, import.meta.url), "utf8");
const messages = (source: string, id = "TC-01") =>
  checkSpecSource(source, id, plan).map((p) => `${p.check}: ${p.message}`);

describe("static checks of test data (REQ-EXEC-53)", () => {
  it("REQ-EXEC-53/AC1: the reference specs pass; data.get() names a record of the case's plan, as a literal", () => {
    expect(messages(spec("TC-01"))).toEqual([]);
    expect(messages(spec("TC-02"), "TC-02")).toEqual([]);
    expect(messages(spec("TC-01").replace('data.get("lamp")', 'data.get("shelf")'))).toContain(
      "coverage: data.get(): 'shelf' is not a test_data record of TC-01 in the plan",
    );
    expect(messages(spec("TC-01").replace('data.get("lamp")', "data.get(`lamp`)"))).toContain(
      "lint: data.get() takes the literal name of a test_data record",
    );
  });
});
