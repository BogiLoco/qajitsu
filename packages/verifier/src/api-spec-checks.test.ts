import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkSpecSource } from "./spec-checks.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-16",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-16-draft.json", import.meta.url), "utf8")),
});
const spec = (id: string) =>
  readFileSync(new URL(`../../../fixtures/specs/demo-16/${id}.spec.ts`, import.meta.url), "utf8");
const messages = (source: string, id = "TC-01") =>
  checkSpecSource(source, id, plan).map((p) => `${p.check}: ${p.message}`);

describe("static checks of API bodies (REQ-EXEC-45)", () => {
  it("REQ-EXEC-45/AC1: the reference specs of multipart upload and file download pass every check", () => {
    expect(messages(spec("TC-01")).filter((m) => !m.startsWith("review"))).toEqual([]);
    expect(messages(spec("TC-02"), "TC-02").filter((m) => !m.startsWith("review"))).toEqual([]);
  });

  it("REQ-EXEC-45/AC1 + REQ-EXEC-38/AC1: bodies name files of the plan, as literals", () => {
    const tc01 = spec("TC-01");
    expect(messages(tc01.replace('files: { file: "invoice" }', 'files: { file: "secret-file" }'))).toContain(
      "coverage: api.multipart(): 'secret-file' is not a file of TC-01 in the plan (files)",
    );
    expect(messages(tc01.replace('files: { file: "invoice" }', "files: { file: `invoice` }"))).toContain(
      "lint: api.multipart() takes literal file keys of the plan",
    );
    expect(messages(tc01.replace('files: { file: "invoice" }', "files: keys"))).toContain(
      "lint: api.multipart() takes its files as an object literal of plan file keys",
    );
    expect(messages(tc01.replace('files: { file: "invoice" }', "files: { invoice }"))).toContain(
      "lint: api.multipart() takes literal file keys of the plan",
    );
    expect(messages(tc01.replace("user.multipart({", "user.binary(key, {"))).toContain(
      "lint: api.binary() takes literal file keys of the plan",
    );
    const binary = tc01.replace(
      'user.multipart({ fields: { title: "Invoice 7" }, files: { file: "invoice" } })',
      'user.binary("/etc/passwd")',
    );
    expect(messages(binary)).toContain(
      "coverage: api.binary(): '/etc/passwd' is not a file of TC-01 in the plan (files)",
    );
    // `toString` is a key of every object: only the plan's own files count.
    expect(messages(binary.replace('"/etc/passwd"', '"toString"'))).toContain(
      "coverage: api.binary(): 'toString' is not a file of TC-01 in the plan (files)",
    );
  });

  it("REQ-EXEC-45/AC1: a binary body without a key, a case without files and a multipart without files", () => {
    const tc01 = spec("TC-01");
    const multipart = 'user.multipart({ fields: { title: "Invoice 7" }, files: { file: "invoice" } })';
    expect(messages(tc01.replace(multipart, "user.binary()"))).toContain(
      "lint: api.binary() takes literal file keys of the plan",
    );
    const noFiles = { ...plan, cases: plan.cases.map((c) => ({ ...c, files: undefined })) };
    expect(checkSpecSource(tc01, "TC-01", noFiles).map((p) => `${p.check}: ${p.message}`)).toContain(
      "coverage: api.multipart(): 'invoice' is not a file of TC-01 in the plan (files)",
    );
    expect(
      messages(tc01.replace(multipart, 'user.multipart({ fields: { title: "Invoice 7" } })')).filter((m) =>
        m.includes("multipart"),
      ),
    ).toEqual([]);
  });
});
