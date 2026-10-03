import {
  AnalysisSchema,
  CaseResultFileSchema,
  EnvProfileSchema,
  PlanSchema,
  ProjectConfigSchema,
} from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// Published schemas are generated from Zod; update deliberately with `pnpm test -u` (schemas/README.md).
const publish = (schema: z.ZodType, id: string): string =>
  `${JSON.stringify({ $id: id, ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) }, null, 2)}\n`;

describe("published JSON Schemas", () => {
  it("REQ-GEN-01: qa.project.schema.json matches ProjectConfigSchema", async () => {
    await expect(
      publish(ProjectConfigSchema, "https://qajitsu.dev/schemas/qa.project.schema.json"),
    ).toMatchFileSnapshot("../../schemas/qa.project.schema.json");
  });

  it("REQ-PLAN-02: plan.schema.json matches PlanSchema", async () => {
    await expect(publish(PlanSchema, "https://qajitsu.dev/schemas/plan.schema.json")).toMatchFileSnapshot(
      "../../schemas/plan.schema.json",
    );
  });

  it("REQ-PLAN-01: analysis.schema.json matches AnalysisSchema", async () => {
    await expect(
      publish(AnalysisSchema, "https://qajitsu.dev/schemas/analysis.schema.json"),
    ).toMatchFileSnapshot("../../schemas/analysis.schema.json");
  });

  it("REQ-ENV-01: env-profile.schema.json matches EnvProfileSchema", async () => {
    await expect(
      publish(EnvProfileSchema, "https://qajitsu.dev/schemas/env-profile.schema.json"),
    ).toMatchFileSnapshot("../../schemas/env-profile.schema.json");
  });

  it("REQ-VER-02: results.schema.json matches CaseResultFileSchema", async () => {
    await expect(
      publish(CaseResultFileSchema, "https://qajitsu.dev/schemas/results.schema.json"),
    ).toMatchFileSnapshot("../../schemas/results.schema.json");
  });
});
