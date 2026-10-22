import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveTicket, type AdapterDeps, type TicketKey } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFileWorkflow, createJiraWorkflow } from "./workflow.js";

const KEY = "DEMO-1" as TicketKey;
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A Jira double: the issue starts in "Ready for QA"; "In QA" and "Blocked" are offered from there. */
const jira = (flavor: "cloud" | "datacenter", permitted = true) => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let status = "Ready for QA";
  const fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(url instanceof Request ? url.url : url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: `${u.pathname}${u.search}`, ...(body === undefined ? {} : { body }) });
    const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
    if (u.pathname.endsWith("/transitions") && method === "GET")
      return ok({
        transitions: [
          { id: "31", name: "Start QA", to: { name: "In QA" } },
          { id: "41", name: "Block", to: { name: "Blocked" } },
        ],
      });
    if (u.pathname.endsWith("/transitions") && method === "POST") {
      status = (body as { transition: { id: string } }).transition.id === "31" ? "In QA" : "Blocked";
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (u.pathname.endsWith("/statuses"))
      return ok([
        { statuses: [{ name: "Ready for QA" }, { name: "In QA" }] },
        { statuses: [{ name: "In QA" }, { name: "Done" }] },
      ]);
    if (u.pathname.endsWith("/mypermissions"))
      return ok({ permissions: { TRANSITION_ISSUES: { havePermission: permitted } } });
    if (method === "PUT") return Promise.resolve(new Response(null, { status: 204 }));
    return ok({ fields: { status: { name: status } } });
  };
  const deps = {
    fetch,
    resolveSecret: () => Promise.resolve("secret-token"),
    registerSecret: () => undefined,
  } as unknown as AdapterDeps;
  const wf = createJiraWorkflow(
    { flavor, baseUrl: "https://jira.example.com", token: "secret://env/T", email: "secret://env/E" },
    deps,
  );
  return { wf, calls };
};

describe("ticket workflow (REQ-FLOW-02)", () => {
  it("REQ-FLOW-02/AC3: a ticket moves through an offered transition; one with no transition stays where it is, with the reason", async () => {
    const { wf, calls } = jira("cloud");
    expect(await moveTicket(wf, KEY, "in qa")).toEqual({ moved: true, from: "Ready for QA", to: "in qa" });
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/rest/api/3/issue/DEMO-1/transitions",
      body: { transition: { id: "31" } },
    });
    expect(await moveTicket(wf, KEY, "In QA")).toMatchObject({ moved: true, from: "In QA" });
    const stuck = await moveTicket(wf, KEY, "Done");
    expect(stuck).toEqual({
      moved: false,
      from: "In QA",
      to: "Done",
      reason: 'no transition from "In QA" to "Done" (offered: "In QA", "Blocked")',
    });
  });

  it("REQ-FLOW-02/AC2: the project's statuses and the account's transition permission, on Cloud and Data Center", async () => {
    const cloud = jira("cloud");
    expect(await cloud.wf.projectStatuses("DEMO")).toEqual(["Ready for QA", "In QA", "Done"]);
    expect(await cloud.wf.canTransition("DEMO")).toBe(true);
    expect(cloud.calls.at(-1)?.path).toBe(
      "/rest/api/3/mypermissions?projectKey=DEMO&permissions=TRANSITION_ISSUES",
    );
    const dc = jira("datacenter", false);
    expect(await dc.wf.canTransition("DEMO")).toBe(false);
    await dc.wf.assign(KEY, "qa.lead");
    await dc.wf.addLabel(KEY, "qa-needs-attention");
    expect(dc.calls.slice(-2)).toEqual([
      { method: "PUT", path: "/rest/api/2/issue/DEMO-1/assignee", body: { name: "qa.lead" } },
      {
        method: "PUT",
        path: "/rest/api/2/issue/DEMO-1",
        body: { update: { labels: [{ add: "qa-needs-attention" }] } },
      },
    ]);
    await expect(cloud.wf.projectStatuses("bad key")).rejects.toThrow("Invalid Jira project key");
  });

  it("REQ-FLOW-02/AC3: ticket files follow workflow.json when there is one, any mapped status otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-wf-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "DEMO-1.json"),
      JSON.stringify({ key: "DEMO-1", status: "Ready for QA", labels: [] }),
    );
    const open = createFileWorkflow(dir, ["Ready for QA", "In QA", "Passed"]);
    expect(await moveTicket(open, KEY, "In QA")).toMatchObject({ moved: true });
    await open.addLabel(KEY, "x");
    await open.addLabel(KEY, "x");
    await open.assign(KEY, "qa");
    expect(JSON.parse(await readFile(join(dir, "DEMO-1.json"), "utf8"))).toMatchObject({
      status: "In QA",
      labels: ["x"],
      assignee: "qa",
    });
    expect(await open.projectStatuses("DEMO")).toEqual(["Ready for QA", "In QA", "Passed"]);
    expect(await open.canTransition("DEMO")).toBe(true);
    await writeFile(join(dir, "workflow.json"), JSON.stringify({ transitions: { "In QA": ["Passed"] } }));
    const strict = createFileWorkflow(dir);
    expect(await moveTicket(strict, KEY, "Done")).toMatchObject({ moved: false });
    expect(await moveTicket(strict, KEY, "Passed")).toMatchObject({ moved: true });
    await expect(strict.transition(KEY, "to:Done")).rejects.toThrow('No transition from "Passed" to "Done".');
    expect(await strict.projectStatuses("DEMO")).toEqual(["In QA", "Passed"]);
  });
});
