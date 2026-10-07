import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapturedMessage, MessageCapture } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject, draft } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** An in-memory capture service: the "application" sends a confirmation as soon as an inbox exists (if `deliver`). */
const memoryCapture = (deliver: boolean) => {
  const created: string[] = [];
  const deleted: string[] = [];
  const boxes = new Map<string, CapturedMessage[]>();
  const capture: MessageCapture = {
    createInbox: (label) => {
      const id = `box-${String(created.length + 1)}`;
      created.push(label);
      boxes.set(
        id,
        deliver
          ? [
              {
                id: "m1",
                kind: "email",
                receivedAt: new Date(Date.now() + 1000).toISOString(),
                to: `${id}@email.webhook.site`,
                subject: "Discount SAVE20 applied",
                body: "Your cart now uses SAVE20. Details: https://shop.example/cart",
              },
            ]
          : [],
      );
      return Promise.resolve({ id, email: `${id}@email.webhook.site`, url: `https://webhook.site/${id}` });
    },
    messages: (id) => Promise.resolve(boxes.get(id) ?? []),
    deleteInbox: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
  };
  return { capture, created, deleted };
};

const MESSAGE_STEP = {
  id: "S3",
  action: "Check the discount confirmation e-mail",
  expect: {
    description: "A confirmation e-mail names SAVE20",
    message: { subject: "SAVE20 applied", within_s: 2 },
  },
};
const SPEC_S3 = `
  await step("S3", async () => {
    await inbox.address();
    const msg = await inbox.wait("S3");
    verify("S3", "message", msg, plan.expect("TC-02.S3.message"));
  });
}
`;

const setup = async (options: { deliver?: boolean; config?: string } = {}) => {
  const mem = memoryCapture(options.deliver ?? true);
  const p = await createBuildProject(
    `${apiService()}\n${options.config ?? "messages: { base_url: https://webhook.site, poll_ms: 200 }"}`,
    { ports: { messageCapture: () => mem.capture } },
  );
  cleanups.push(p.cleanup);
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace(
      "environments: { allowlist: ['http://localhost:3000'] }",
      "environments: { allowlist: ['http://localhost:3000', 'https://webhook.site'] }",
    ),
  );
  const plan = JSON.parse(draft) as { cases: { steps: unknown[] }[] };
  plan.cases[1]?.steps.push(MESSAGE_STEP);
  const dir = await p.prepare(JSON.stringify(plan));
  const spec = join(dir, "specs", "TC-02.spec.ts");
  await writeFile(
    spec,
    (await readFile(spec, "utf8"))
      .replace("{ step, verify, plan, api }", "{ step, verify, plan, api, inbox }")
      .replace(/\n}\s*$/, SPEC_S3),
  );
  const results = async () =>
    (
      JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        data: { results: Record<string, string>; inboxes?: string[] };
      }
    ).data;
  return { ...p, mem, dir, results, yaml };
};

describe("message capture in a run (REQ-ENV-08)", () => {
  it("REQ-ENV-08/AC1+AC2+AC3+AC5: a case gets its own inbox; the planned e-mail passes the step, is evidence, and the inbox is deleted", async () => {
    const p = await setup();
    const r = await p.run(["run", "DEMO-1", "--build"]);
    expect(r.err).toBe("");
    const data = await p.results();
    expect(data.results).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
    expect(p.mem.created).toEqual([`DEMO-1-${p.dir.split("/").at(-1) ?? ""}-TC-02`]);
    expect(p.mem.deleted).toEqual(["box-1"]);
    expect(data.inboxes).toEqual([]);
    const manifest = await readFile(join(p.dir, "evidence", "manifest.json"), "utf8");
    expect(manifest).toContain("TC-02/attempt-1/S3-message.json");
    const evidence = await readFile(join(p.dir, "evidence", "TC-02", "attempt-1", "S3-message.json"), "utf8");
    expect(evidence).toContain('"subject": "Discount SAVE20 applied"');
    expect(evidence).toContain('"links": [');
  }, 240_000);

  it("REQ-ENV-08/AC2+AC5: no matching message in time fails the case, never passes it; the inbox is still deleted", async () => {
    const p = await setup({ deliver: false });
    const r = await p.run(["run", "DEMO-1", "--build"]);
    expect(r.exitCode).toBe(1);
    const data = await p.results();
    expect(data.results).toEqual({ "TC-01": "PASSED", "TC-02": "FAILED" });
    expect(p.mem.deleted).toEqual(["box-1"]);
    const result = await readFile(join(p.dir, "results", "TC-02.json"), "utf8");
    expect(result).toContain("(no matching message in time)");
  }, 240_000);

  it("REQ-ENV-08/AC4: the capture host must be on the environment allowlist", async () => {
    const p = await setup({ config: "messages: { base_url: https://hooks.example.org }" });
    const r = await p.run(["run", "DEMO-1", "--build"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[MESSAGES_HOST_NOT_ALLOWED]");
    expect(p.mem.created).toEqual([]);
  }, 240_000);

  it("REQ-ENV-08/AC2: a message step without configured capture is BLOCKED, never PASSED", async () => {
    const p = await setup({ config: "" });
    await p.run(["run", "DEMO-1", "--build"]);
    expect((await p.results()).results["TC-02"]).toBe("BLOCKED");
  }, 240_000);
});
