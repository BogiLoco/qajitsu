import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { earlierNetwork } from "./network-history.js";

let root: string;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const analysis = (status: number) => ({
  steps: [],
  security: [],
  contract: [],
  bodies: [],
  endpoints: [{ method: "GET", path: "/api/cart", status }],
});

/** A run folder with its approved plan and, optionally, the traffic analysis of TC-01's last attempt. */
const run = async (runId: string, plan: string, network?: unknown) => {
  const dir = join(root, "DEMO-1", runId);
  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "results"), { recursive: true });
  await writeFile(join(dir, "plan", "plan.approved.yaml"), plan);
  const path = "TC-01/attempt-1/network-analysis.json";
  await writeFile(
    join(dir, "results", "TC-01.json"),
    JSON.stringify({
      schema: 1,
      caseId: "TC-01",
      runner: "web",
      attempts: [
        { attempt: 1, outcome: "passed", assertions: [], steps: [], evidence: network ? [path] : [] },
      ],
    }),
  );
  await writeFile(join(dir, "results", "notes.txt"), "not a result");
  await writeFile(join(dir, "results", "TC-02.json"), "{ broken");
  if (network !== undefined) {
    await mkdir(join(dir, "evidence", "TC-01", "attempt-1"), { recursive: true });
    await writeFile(join(dir, "evidence", path), JSON.stringify(network));
  }
};

const index = (runIds: string[]) =>
  writeFile(
    join(root, "DEMO-1", "index.json"),
    JSON.stringify({
      ticket: "DEMO-1",
      runs: runIds.map((runId) => ({
        runId,
        createdAt: "2026-11-04T10:00:00Z",
        status: "completed",
        retention: "default",
      })),
    }),
  );

const ws = (runId: string) => ({
  root,
  ticket: "DEMO-1" as never,
  runId: runId as never,
  path: (...p: string[]) => join(root, "DEMO-1", runId, ...p),
});

describe("the last run of the same plan (REQ-EVD-09/AC4+AC5)", () => {
  it("REQ-EVD-09/AC5: the newest earlier run with the same approved plan gives each case's traffic", async () => {
    root = await mkdtemp(join(tmpdir(), "qj-network-"));
    await run("20261101-1000-aaaa", "plan: A", analysis(200));
    await run("20261102-1000-bbbb", "plan: B", analysis(500));
    await run("20261103-1000-cccc", "plan: A", analysis(201));
    await run("20261104-1000-dddd", "plan: A");
    await run("20261105-1000-eeee", "plan: A", analysis(404));
    await index([
      "20261101-1000-aaaa",
      "20261102-1000-bbbb",
      "20261103-1000-cccc",
      "20261104-1000-dddd",
      "20261105-1000-eeee",
    ]);
    const earlier = await earlierNetwork(ws("20261104-1000-dddd"));
    expect(earlier?.runId).toBe("20261103-1000-cccc");
    expect(earlier?.byCase.get("TC-01")?.endpoints[0]?.status).toBe(201);
    expect(earlier?.byCase.has("TC-02")).toBe(false);
  });

  it("REQ-EVD-09/AC5: no earlier run of the plan, no plan, or an analysis that cannot be read gives nothing to compare", async () => {
    root = await mkdtemp(join(tmpdir(), "qj-network-"));
    await run("20261101-1000-aaaa", "plan: B", analysis(200));
    await run("20261102-1000-bbbb", "plan: A", { steps: "forged" });
    await run("20261103-1000-cccc", "plan: A");
    await index(["20261101-1000-aaaa", "20261102-1000-bbbb", "20261103-1000-cccc"]);
    const forged = await earlierNetwork(ws("20261103-1000-cccc"));
    expect(forged?.byCase.size).toBe(0);
    expect(await earlierNetwork(ws("20261102-1000-bbbb"))).toBeUndefined();
    expect(await earlierNetwork(ws("20269999-1000-zzzz"))).toBeUndefined();
  });
});
