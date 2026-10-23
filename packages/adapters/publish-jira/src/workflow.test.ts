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
    if (u.pathname.endsWith("/comment")) {
      const start = Number(u.searchParams.get("startAt") ?? "0");
      const all = [
        {
          id: "10",
          author: { accountId: "acc-anna", displayName: "Anna" },
          body:
            flavor === "cloud"
              ? {
                  type: "doc",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "Looks fine." }] },
                    { type: "paragraph", content: [{ type: "text", text: "/qj approve v1" }] },
                  ],
                }
              : "Looks fine.\n/qj approve v1",
          created: "2026-10-03T10:00:00.000+0000",
        },
        {
          id: "11",
          author: { name: "bob", displayName: "Bob" },
          body: "second page",
          created: "2026-10-03T11:00:00.000+0000",
        },
      ];
      return ok({ total: 2, comments: all.slice(start, start + 1) });
    }
    if (u.pathname.endsWith("/search/jql") || u.pathname.endsWith("/search"))
      return ok({ issues: [{ key: "DEMO-7" }, { key: "OTHER-1" }, { key: "not a key" }, { key: "DEMO-9" }] });
    if (u.pathname.endsWith("/user/groups")) return ok([{ name: "qa-leads" }]);
    if (u.pathname.endsWith("/user")) return ok({ groups: { items: [{ name: "developers" }] } });
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

  it("REQ-FLOW-03/AC2+AC3: comments as plain text with their authors, page by page; group membership on Cloud and Data Center", async () => {
    const cloud = jira("cloud");
    const comments = await cloud.wf.comments(KEY);
    expect(comments).toEqual([
      {
        id: "10",
        author: { account: "acc-anna", name: "Anna" },
        body: "Looks fine.\n/qj approve v1\n",
        created: "2026-10-03T10:00:00.000+0000",
      },
      {
        id: "11",
        author: { account: "bob", name: "Bob" },
        body: "second page",
        created: "2026-10-03T11:00:00.000+0000",
      },
    ]);
    expect(await cloud.wf.inGroup("acc-anna", "qa-leads")).toBe(true);
    expect(cloud.calls.at(-1)?.path).toBe("/rest/api/3/user/groups?accountId=acc-anna");
    expect(await cloud.wf.inGroup("", "qa-leads")).toBe(false);
    const dc = jira("datacenter");
    expect((await dc.wf.comments(KEY))[0]?.body).toBe("Looks fine.\n/qj approve v1");
    expect(await dc.wf.inGroup("bob", "qa-leads")).toBe(false);
    expect(dc.calls.at(-1)?.path).toBe("/rest/api/2/user?username=bob&expand=groups");
  });

  it("REQ-FLOW-01/AC2: tickets waiting in the start status, by the default query or the configured JQL; only valid keys of the project", async () => {
    const cloud = jira("cloud");
    expect(await cloud.wf.findInStatus({ projectKey: "DEMO", status: 'Ready "for" QA', limit: 500 })).toEqual(
      ["DEMO-7", "DEMO-9"],
    );
    expect(cloud.calls.at(-1)).toEqual({
      method: "POST",
      path: "/rest/api/3/search/jql",
      body: {
        jql: 'project = DEMO AND status = "Ready \\"for\\" QA" ORDER BY created ASC',
        fields: ["key"],
        maxResults: 100,
      },
    });
    const dc = jira("datacenter");
    await dc.wf.findInStatus({ projectKey: "DEMO", status: "Ready for QA", jql: "filter = 123", limit: 5 });
    expect(dc.calls.at(-1)?.path).toBe("/rest/api/2/search?jql=filter+%3D+123&fields=key&maxResults=5");
    await expect(cloud.wf.findInStatus({ projectKey: "x y", status: "S", limit: 1 })).rejects.toThrow(
      "Invalid Jira project key",
    );
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

  it("REQ-FLOW-01/AC2: ticket files in the start status, oldest key first, other projects and odd files skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-wf-"));
    dirs.push(dir);
    const ticket = (key: string, status: string) =>
      writeFile(join(dir, `${key}.json`), JSON.stringify({ key, status }));
    await ticket("DEMO-2", "ready for qa");
    await ticket("DEMO-1", "Ready for QA");
    await ticket("DEMO-3", "In QA");
    await ticket("SHOP-1", "Ready for QA");
    await writeFile(join(dir, "workflow.json"), "{}");
    await writeFile(join(dir, "notes.json"), "[]");
    const wf = createFileWorkflow(dir);
    expect(await wf.findInStatus({ projectKey: "DEMO", status: "Ready for QA", limit: 5 })).toEqual([
      "DEMO-1",
      "DEMO-2",
    ]);
    expect(await wf.findInStatus({ projectKey: "DEMO", status: "Ready for QA", limit: 1 })).toEqual([
      "DEMO-1",
    ]);
  });
});
