import { GENESIS_HASH, createEventLog, createTranscript, sha256 } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { buildAuditTrail, trailCategory, type AuditTrailInput } from "./audit-trail.js";

const now = (): Date => new Date(0);

/** A complete run: one model call with its stored exchange, one case run with its spec and evidence. */
const complete = (): AuditTrailInput => {
  const lines: string[] = [];
  const stored: string[] = [];
  const events = createEventLog({
    ticket: "DEMO-1",
    run: "r",
    write: (l) => lines.push(l),
    now,
    mask: (v) => v,
    previousHash: GENESIS_HASH,
  });
  const record = createTranscript({ write: (l) => stored.push(l), mask: (v) => v, now });
  const { sha256: exchangeSha256 } = record({
    stage: "plan",
    role: "planner",
    model: "local/m",
    request: { prompt: "p" },
    response: { text: "{}" },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  events.emit("plan", { kind: "agent", name: "planner" }, "model.usage", { role: "planner", exchangeSha256 });
  const approved = sha256("plan: approved");
  return {
    files: new Map([
      ["ticket/ticket.json", sha256("t")],
      ["repos/shop.diff", sha256("d")],
      ["plan/plan.v1.yaml", sha256("v1")],
      ["plan/plan.approved.yaml", approved],
      ["specs/TC-01.spec.ts", sha256("spec")],
      ["results/TC-01.json", sha256("r")],
      ["evidence/manifest.json", sha256("m")],
      ["evidence/TC-01/attempt-1/S1-01.json", sha256("e")],
      ["checks/triage.json", sha256("c")],
      ["report/matrix.md", sha256("x")],
      ["report/report.html", sha256("h")],
      ["journal/events.jsonl", sha256(lines.join(""))],
      ["journal/agents.jsonl", sha256(stored.join(""))],
      ["run.json", sha256("{}")],
    ]),
    repos: { shop: { sha: "a".repeat(40), change: "branch:feature/DEMO-1" } },
    data: {
      approval: { version: 1, sha256: approved, approver: "qa.lead", at: "2026-10-22T10:00:00Z" },
      versions: { qajitsu: "0.0.0", docker: "24.0.6" },
      build: {
        services: { api: { kind: "compose" } },
        images: [{ container: "qj-api-1", image: "node:22-alpine", id: `sha256:${"b".repeat(64)}` }],
      },
      environment: { name: "build (local)", versionCheck: "built-from-worktree" },
      checks: { "triage.json": sha256("c") },
    },
    events: lines.join(""),
    transcript: stored.join(""),
    manifest: [{ path: "TC-01/attempt-1/S1-01.json", sha256: sha256("e") }],
    results: [{ caseId: "TC-01", spec: "/runs/r/specs/TC-01.spec.ts" }, { caseId: "TC-02" }],
  };
};

describe("audit trail (REQ-VER-16)", () => {
  it("REQ-VER-16/AC1: a complete run lists every file with its hash, grouped by what it is, and has no gaps", () => {
    const trail = buildAuditTrail(complete());
    expect(trail.gaps).toEqual([]);
    expect(trail.items.map((i) => [i.path, i.category])).toEqual([
      ["checks/triage.json", "checks"],
      ["evidence/TC-01/attempt-1/S1-01.json", "evidence"],
      ["evidence/manifest.json", "evidence"],
      ["journal/agents.jsonl", "agents"],
      ["journal/events.jsonl", "journal"],
      ["plan/plan.approved.yaml", "plan"],
      ["plan/plan.v1.yaml", "plan"],
      ["report/matrix.md", "report"],
      ["report/report.html", "report"],
      ["repos/shop.diff", "change"],
      ["results/TC-01.json", "runner"],
      ["run.json", "run"],
      ["specs/TC-01.spec.ts", "tests"],
      ["ticket/ticket.json", "ticket"],
    ]);
    expect(trail.items.every((i) => /^[0-9a-f]{64}$/.test(i.sha256))).toBe(true);
    expect(
      [
        "analysis.json",
        "map/around.json",
        "logs/api.log",
        "explore/S01/a.json",
        "certificate/c.json",
        "x.txt",
      ].map(trailCategory),
    ).toEqual(["context", "context", "runner", "explore", "certificate", "other"]);
  });

  it("REQ-VER-16/AC4: every missing part of the trail is a gap with its reason", () => {
    const base = complete();
    const files = new Map(base.files);
    for (const p of [
      "ticket/ticket.json",
      "plan/plan.v1.yaml",
      "specs/TC-01.spec.ts",
      "report/report.html",
      "evidence/TC-01/attempt-1/S1-01.json",
    ])
      files.delete(p);
    const trail = buildAuditTrail({
      ...base,
      files,
      repos: { shop: {} },
      data: { build: { services: { api: { kind: "compose" } } } },
      transcript: undefined,
    });
    expect(trail.gaps).toEqual([
      "ticket snapshot ticket/ticket.json is missing",
      "repository shop: no commit SHA recorded",
      "repository shop: no change reference recorded",
      "no plan version in plan/",
      "plan/plan.approved.yaml does not have the SHA-256 recorded at approval",
      "the approval (who, when, which version) is not recorded",
      "TC-01: generated test specs/TC-01.spec.ts is missing",
      "runner and tool versions are not recorded",
      "container image digests are not recorded",
      "the tested environment and its version are not recorded",
      "evidence TC-01/attempt-1/S1-01.json is missing",
      "report/report.html is missing",
      "journal/agents.jsonl is missing (1 model calls)",
    ]);
  });

  it("REQ-VER-16/AC4: changed files and records are gaps: evidence, checks, approved plan, an unlisted evidence file, a broken journal", () => {
    const base = complete();
    const files = new Map(base.files);
    files.set("evidence/TC-01/attempt-1/S1-01.json", sha256("edited"));
    files.set("evidence/TC-01/attempt-1/extra.png", sha256("planted"));
    files.set("checks/triage.json", sha256("edited"));
    files.set("plan/plan.approved.yaml", sha256("edited"));
    const trail = buildAuditTrail({
      ...base,
      files,
      events: (base.events ?? "").replace('"stage":"plan"', '"stage":"edit"'),
    });
    expect(trail.gaps).toEqual([
      "plan/plan.approved.yaml does not have the SHA-256 recorded at approval",
      "evidence TC-01/attempt-1/S1-01.json does not match its SHA-256 in the manifest",
      "evidence/TC-01/attempt-1/extra.png is not in the evidence manifest",
      "checks/triage.json does not match its recorded SHA-256",
    ]);
    // A journal line edited after the fact breaks the chain only when a later line follows it, so check that too.
    const twoLines = `${base.events ?? ""}${base.events ?? ""}`;
    expect(buildAuditTrail({ ...base, events: twoLines }).gaps[0]).toMatch(
      /^journal\/events.jsonl line 2: does not match the previous line$/,
    );
  });

  it("REQ-VER-16/AC1+AC4: approval steps that do not match the journal are a gap", () => {
    const base = complete();
    const approval = base.data["approval"] as { sha256: string };
    const gaps = buildAuditTrail({
      ...base,
      data: {
        ...base.data,
        approvals: [
          {
            kind: "person",
            identity: "qa.lead",
            decision: "approve",
            reasons: [],
            version: 1,
            planSha256: approval.sha256,
            at: "2026-10-22T10:00:00Z",
          },
        ],
      },
    }).gaps;
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.startsWith("approval: "))).toBe(true);
  });

  it("REQ-VER-16/AC4: a run that never ran, was never approved, or has no journal and no manifest is incomplete", () => {
    const base = complete();
    const files = new Map(base.files);
    files.delete("plan/plan.approved.yaml");
    const trail = buildAuditTrail({
      ...base,
      files,
      repos: {},
      results: [],
      manifest: undefined,
      events: undefined,
    });
    expect(trail.gaps).toEqual([
      "no commit SHA recorded for the change",
      "plan/plan.approved.yaml is missing: the plan was never approved",
      "no case results: the run was not executed",
      "evidence/manifest.json is missing or invalid",
      "journal/events.jsonl is missing",
    ]);
    const legacy = '{"event":"stage.start"}\n';
    expect(buildAuditTrail({ ...base, events: legacy }).gaps).toEqual([
      "journal/events.jsonl has no hash chain",
    ]);
  });
});
