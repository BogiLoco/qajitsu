// Onboarding a project that is not the demo-shop needs only `.qa/` (REQ-GEN-01/AC2+AC3): a fictional notes app
// with a cookie session behind a form login (no JSON token, so the built-in login recipe cannot do it), a setup
// hook that resets its data, a knowledge file, and its own ticket and repository. The whole flow runs with the
// unchanged CLI.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../../packages/cli/src/program.js";
import { inProcessExecutor } from "../support/cli-pipeline.js";
import { gitExec } from "../support/cli-project.js";
import { scriptedModel, type Turn } from "../support/mock-model.js";

const PASSWORD = "fictional-notes-password";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** The fictional notes app: form login sets a cookie; GET /notes needs it; POST /reset seeds two notes. */
const startNotes = async (): Promise<{ url: string; resets: () => number }> => {
  let notes: string[] = [];
  let resets = 0;
  const sessions = new Set<string>();
  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url === "/health") {
        reply(200, { ok: true });
        return;
      }
      if (req.method === "POST" && req.url === "/reset") {
        resets += 1;
        notes = ["first", "second"];
        reply(200, { notes: notes.length });
        return;
      }
      if (req.method === "POST" && req.url === "/session") {
        const form = new URLSearchParams(body);
        if (form.get("user") !== "writer" || form.get("pass") !== PASSWORD) {
          reply(401, {});
          return;
        }
        const sid = `sid-${String(sessions.size + 1)}-${Math.random().toString(36).slice(2)}`;
        sessions.add(sid);
        reply(204, {}, { "set-cookie": `notes_sid=${sid}; HttpOnly` });
        return;
      }
      const sid = /notes_sid=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (req.url === "/notes") {
        if (sid && sessions.has(sid)) reply(200, { count: notes.length });
        else reply(401, {});
        return;
      }
      reply(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  cleanups.push(
    () =>
      new Promise((r) =>
        server.close(() => {
          r();
        }),
      ),
  );
  return { url: `http://127.0.0.1:${String(port)}`, resets: () => resets };
};

const analysis = JSON.stringify({
  summary: "Notes list.",
  change_type: ["api"],
  endpoints: [{ method: "GET", path: "/notes", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});
const draft = JSON.stringify({
  summary: "Notes list for NOTES-7.",
  cases: [
    {
      id: "TC-01",
      title: "A writer sees the seeded notes",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      data: { user: "user:writer" },
      steps: [
        {
          id: "S1",
          action: "GET /notes",
          expect: { description: "Two notes", status: 200, fields: { count: 2 } },
        },
      ],
      evidence: ["request", "response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});
const spec = `import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const writer = api.as("user:writer");
  await step("S1", async () => {
    const res = await writer.get("/notes");
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify("S1", "fields.count", res.json("count"), plan.expect("TC-01.S1.fields.count"));
  });
}
`;

/** Writes the notes project: repository with the change, ticket, and nothing but `.qa/` files for QAJitsu. */
const notesProject = async (appUrl: string) => {
  const home = await mkdtemp(join(tmpdir(), "qj-notes-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, "git", "notes-org", "notes");
  const g = (...args: string[]) =>
    gitExec(["-C", repo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
  await gitExec(["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "notes.ts"), "export const list = () => [];\n");
  await g("add", ".");
  await g("commit", "-qm", "init");
  await g("checkout", "-qb", "feature/NOTES-7-list");
  await writeFile(join(repo, "notes.ts"), "export const list = (all: string[]) => all;\n");
  await g("commit", "-qam", "NOTES-7 list notes");
  await g("checkout", "-q", "main");

  const project = join(home, "notes-app");
  const qa = join(project, ".qa");
  for (const dir of ["envs", "auth", "hooks", "knowledge", "tickets"])
    await mkdir(join(qa, dir), { recursive: true });
  await writeFile(
    join(qa, "qa.project.yaml"),
    [
      "project: notes",
      "jira: { type: file, tickets_dir: tickets, project_key: NOTES }",
      "workspace: { root: ~/runs, git_cache: ~/cache }",
      "code_hosts: { local: { type: local, root: ~/git } }",
      "repos: { notes: { host: local, path: notes-org/notes } }",
      `environments: { default: staging, allowlist: ['${appUrl}'] }`,
      "models: { roles: { default: mock/scripted } }",
      "verification: { auditor: off }",
      "hooks: { setup: hooks/reset.mjs }",
    ].join("\n"),
  );
  await writeFile(
    join(qa, "envs", "staging.yaml"),
    `base_url: ${appUrl}\naccounts:\n  user:writer: { username: writer, password: secret://env/NOTES_PASSWORD }\nlogin: { script: auth/form-login.mjs }\n`,
  );
  await writeFile(
    join(qa, "auth", "form-login.mjs"),
    `const res = await fetch(process.env.BASE_URL + "/session", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ user: process.env.QAJITSU_USERNAME, pass: process.env.QAJITSU_PASSWORD }),
});
if (res.status !== 204) process.exit(1);
const cookie = res.headers.get("set-cookie").split(";")[0];
process.stdout.write(JSON.stringify({ headers: { cookie } }));
`,
  );
  await writeFile(
    join(qa, "hooks", "reset.mjs"),
    `const res = await fetch(process.env.BASE_URL + "/reset", { method: "POST" });
console.log("reset", res.status, process.env.QAJITSU_RUN);
`,
  );
  await writeFile(
    join(qa, "knowledge", "glossary.md"),
    "# Glossary\n\nA writer is a user who can create notes.\n",
  );
  await writeFile(
    join(qa, "tickets", "NOTES-7.json"),
    JSON.stringify({
      key: "NOTES-7",
      summary: "List my notes",
      description: "A writer sees every note.",
      acceptanceCriteria: ["GET /notes returns the number of notes as count."],
    }),
  );
  let model = scriptedModel([]);
  const run = async (args: string[], script: Turn[] = [{ text: "{}" }], ask?: string[]) => {
    let out = "";
    let err = "";
    let exitCode = 0;
    model = scriptedModel(script);
    const answers = [...(ask ?? [])];
    await createProgram("1.0.0", {
      write: (t) => (out += t),
      writeError: (t) => (err += t),
      cwd: project,
      nodeVersion: "v22.22.0",
      setExitCode: (c) => (exitCode = c),
      user: "qa-lead",
      ...(ask ? { ask: () => Promise.resolve(answers.shift() ?? "") } : {}),
      ports: {
        env: { NOTES_PASSWORD: PASSWORD },
        home,
        now: () => new Date("2026-10-04T12:00:00Z"),
        random: () => 0,
        fetch: globalThis.fetch,
        gitExec,
        extraModels: { mock: () => model.mock },
        // The sandboxed child needs the built packages; it has its own e2e tests.
        executor: inProcessExecutor,
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };
  return { home, run };
};

describe("onboarding a new project through .qa/ only (REQ-GEN-01)", () => {
  it("REQ-GEN-01/AC2+AC3: a cookie-login app with a setup hook runs the whole flow without any QAJitsu code change", async () => {
    const app = await startNotes();
    const { home, run } = await notesProject(app.url);
    expect((await run(["doctor"])).exitCode).toBe(0);
    const result = await run(
      ["test", "NOTES-7", "--dry-run"],
      [{ text: analysis }, { text: draft }, { text: "```ts\n" + spec + "```" }],
      ["a"],
    );
    expect(result.err, result.out).toBe("");
    expect(result.exitCode, result.out).toBe(0);
    expect(result.out).toContain("| TC-01 | A writer sees the seeded notes | AC1 | API | PASSED |");
    expect(app.resets()).toBe(1);
    const runDir = join(home, "runs", "NOTES-7", "20261004-1200-aaaa");
    // The session cookie from the login script never reaches evidence, results or logs unmasked.
    const manifest = JSON.parse(await readFile(join(runDir, "evidence", "manifest.json"), "utf8")) as {
      path: string;
    }[];
    expect(manifest.map((m) => m.path)).toContain("TC-01/attempt-1/S1-01.json");
    const files = [
      ...manifest.map((m) => join(runDir, "evidence", m.path)),
      join(runDir, "results", "TC-01.json"),
      join(runDir, "journal", "events.jsonl"),
    ];
    for (const file of files) expect(await readFile(file, "utf8"), file).not.toMatch(/notes_sid=sid-/);
    expect(await readFile(join(runDir, "evidence", "TC-01/attempt-1/S1-01.json"), "utf8")).toContain(
      "cookie",
    );
    expect(await readFile(join(runDir, "logs", "setup.log"), "utf8")).toContain(
      "reset 200 20261004-1200-aaaa",
    );
  });
});
