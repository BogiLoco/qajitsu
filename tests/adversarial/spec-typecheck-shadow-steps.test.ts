// Adversarial suite: a spec that calls what the steps API does not have must be BLOCKED by the type check
// (REQ-EXEC-03/AC1, invariant 4), also when the steps types cannot be found and a planted `@qajitsu/steps` with `any`
// types sits on the fallback lookup path (a writable /tmp/node_modules, a project's node_modules).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockingProblems, stepsTypesEntry, typecheckSpecs } from "@qajitsu/verifier";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const SPEC = `import type { CaseContext } from "@qajitsu/steps";
export const caseId = "TC-01";
export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  await step("S1", async () => {
    const res = await api.fetchEverything("/cart");
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
  });
}
`;

/** A spec folder with a planted @qajitsu/steps whose types let anything through. */
const planted = async () => {
  const dir = await mkdtemp(join(tmpdir(), "qj-shadow-"));
  dirs.push(dir);
  const shadow = join(dir, "node_modules", "@qajitsu", "steps");
  await mkdir(shadow, { recursive: true });
  await writeFile(
    join(shadow, "package.json"),
    JSON.stringify({ name: "@qajitsu/steps", types: "index.d.ts" }),
  );
  await writeFile(join(shadow, "index.d.ts"), "export type CaseContext = any;\n");
  const spec = join(dir, "TC-01.spec.ts");
  await writeFile(spec, SPEC);
  return spec;
};

describe("the spec type check cannot be routed around (REQ-EXEC-03/AC1, invariant 4)", () => {
  it("REQ-EXEC-03/AC1: with the real steps types, a planted package next to the spec changes nothing", async () => {
    const spec = await planted();
    const problems = blockingProblems(typecheckSpecs([spec]).get(spec) ?? []);
    expect(problems.map((p) => p.message).join("\n")).toMatch(/fetchEverything/);
  });

  it("REQ-EXEC-03/AC1: steps types that are not there block every spec instead of falling back to a planted package", async () => {
    const spec = await planted();
    const problems = blockingProblems(
      typecheckSpecs([spec], "/no/such/steps/dist/index.d.ts").get(spec) ?? [],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toBe(
      "the @qajitsu/steps types are not found at /no/such/steps/dist/index.d.ts: the spec cannot be checked",
    );
  });

  it("REQ-EXEC-03/AC1: a spec that imports the steps by a subpath, to reach a planted package, is blocked", async () => {
    const spec = await planted();
    // The subpath escapes the mapping to the verifier's types and resolves to the planted package.
    await writeFile(spec, SPEC.replace('from "@qajitsu/steps"', 'from "@qajitsu/steps/dist/index.js"'));
    const problems = blockingProblems(typecheckSpecs([spec]).get(spec) ?? []);
    expect(problems.map((p) => p.message)).toContainEqual(
      expect.stringMatching(
        /^@qajitsu\/steps\/dist\/index\.js resolves to .+, not to the steps types the verifier checks against/,
      ),
    );
    expect(stepsTypesEntry()).toMatch(/steps\/(src\/index\.ts|dist\/index\.d\.ts)$/);
  });
});
