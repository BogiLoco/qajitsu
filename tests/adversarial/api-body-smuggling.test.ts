// Adversarial suite: a spec that tries to send files the plan does not name, pass a file check without a file, or
// leak a secret through a non-JSON body (REQ-EXEC-45, invariants 1, 4 and 8).
import { PlanSchema } from "@qajitsu/core";
import { createCaseRuntime, createMasker, type ApiRequest, type ApiTransportResponse } from "@qajitsu/steps";
import { describe, expect, it } from "vitest";

const TOKEN = "session-token-123456";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a, 0x00, 0xff]);

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-16",
  version: 1,
  summary: "Documents.",
  cases: [
    {
      id: "TC-01",
      title: "Upload and download",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      files: { invoice: { name: "invoice.pdf", type: "application/pdf", bytes: 64 } },
      steps: [
        { id: "S1", action: "GET /documents/D-1/file", expect: { description: "A file", status: 200 } },
        {
          id: "S2",
          action: "GET /documents/D-1/meta",
          expect: { description: "The PDF", status: 200, download: { type: "pdf", min_bytes: 1 } },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const runtime = (respond: (req: ApiRequest) => ApiTransportResponse) => {
  const sent: ApiRequest[] = [];
  const r = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: (req) => {
      sent.push(req);
      return Promise.resolve(respond(req));
    },
    masker: createMasker({ secrets: [TOKEN] }),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => 0,
  });
  return { ...r, sent };
};
const pdf = (): ApiTransportResponse => ({
  status: 200,
  headers: { "content-type": "application/pdf" },
  text: "",
  bytes: PDF,
});
const json = (body: unknown): ApiTransportResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  text: JSON.stringify(body),
});

describe("API bodies cannot smuggle files or secrets, and file checks need a file (REQ-EXEC-45)", () => {
  it("invariant 8 + REQ-EXEC-45/AC1: a path, a key outside the plan or a forged descriptor sends nothing", async () => {
    const { context, sent } = runtime(() => json({}));
    await context.step("S1", async () => {
      const api = context.api;
      for (const attempt of [
        api.binary("../../.qa/.env.local"),
        api.binary("__proto__"),
        api.multipart({ files: { file: "/etc/passwd" } }),
        { __qjBody: "binary", file: "constructor" },
        { __qjBody: "multipart", files: { file: { path: "/etc/passwd" } } },
        { __qjBody: "file", path: "/etc/passwd" },
      ])
        await expect(api.post("/upload", attempt)).rejects.toThrow(
          /not a file of TC-01|invalid request body/,
        );
    });
    expect(sent).toEqual([]);
  });

  it("invariant 1 + REQ-EXEC-45/AC2: a file from another step, or a JSON response, never passes a file check", async () => {
    const { context, finish } = runtime((req) =>
      new URL(req.url).pathname.endsWith("/file") ? pdf() : json({ ok: true }),
    );
    await context.step("S1", async () => {
      await context.api.get("/documents/D-1/file");
    });
    await context.step("S2", async () => {
      const res = await context.api.get("/documents/D-1/meta");
      context.verify("S2", "status", res.status, context.plan.expect("TC-01.S2.status"));
      // The PDF of S1 cannot stand in for the file this step was planned to get.
      context.verify("S2", "download.type", "pdf", context.plan.expect("TC-01.S2.download.type"));
      context.verify("S2", "download.size", 7, context.plan.expect("TC-01.S2.download.size"));
    });
    const record = await finish();
    expect(record.outcome).toBe("failed");
    expect(record.assertions.filter((a) => a.field.startsWith("download."))).toEqual([
      expect.objectContaining({ actual: "(no download in this step)", pass: false }),
      expect.objectContaining({ actual: "(no download in this step)", pass: false }),
    ]);
  });

  it("invariant 8 + REQ-EXEC-45/AC3: secrets in text bodies and text attachments are masked in every piece of evidence", async () => {
    const { context, finish } = runtime(() => ({
      status: 200,
      headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="export.csv"' },
      text: `id,token\n1,${TOKEN}\n`,
      bytes: new TextEncoder().encode(`id,token\n1,${TOKEN}\n`),
    }));
    await context.step("S1", async () => {
      await context.api.post("/notes", context.api.text(`note with ${TOKEN}`));
      await context.api.post("/login", context.api.form({ password: TOKEN }));
    });
    await context.step("S2", () => undefined);
    const record = await finish();
    for (const e of record.evidence) {
      const content = typeof e.content === "string" ? e.content : new TextDecoder().decode(e.content);
      expect(content, e.name).not.toContain(TOKEN);
    }
    expect(record.evidence.map((e) => e.name)).toContain("S1-download-export.csv");
  });
});
