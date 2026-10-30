import { createHash } from "node:crypto";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import {
  createCaseRuntime,
  type ApiRequest,
  type ApiTransport,
  type ApiTransportResponse,
} from "./runtime.js";

const TOKEN = "session-token-123456";
const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x81,
]);
const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  summary: "Documents API.",
  cases: [
    {
      id: "TC-01",
      title: "Upload an invoice and download its PDF",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      preconditions: [],
      data: { user: "user:standard" },
      files: {
        invoice: { name: "invoice.pdf", type: "application/pdf", bytes: 300 },
        notes: { name: "notes.txt", type: "text/plain", bytes: 40 },
      },
      steps: [
        { id: "S1", action: "POST /documents", expect: { description: "Created", status: 201 } },
        {
          id: "S2",
          action: "GET /documents/1/pdf",
          expect: {
            description: "The PDF",
            status: 200,
            download: { type: "pdf", sha256: PDF_SHA, min_bytes: 10 },
          },
        },
      ],
      evidence: ["request", "response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const setup = (respond: (req: ApiRequest) => ApiTransportResponse) => {
  const sent: ApiRequest[] = [];
  const transport: ApiTransport = (req) => {
    sent.push(req);
    return Promise.resolve(respond(req));
  };
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport,
    masker: createMasker({ secrets: [TOKEN] }),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: { "user:standard": { authorization: `Bearer ${TOKEN}` } },
    now: () => 0,
  });
  return { ...runtime, sent };
};

const created = (): ApiTransportResponse => ({
  status: 201,
  headers: { "content-type": "application/json" },
  text: '{"id":1}',
});

describe("API request and response bodies beyond JSON (REQ-EXEC-45)", () => {
  it("REQ-EXEC-45/AC1+AC3: multipart sends fields and the plan's files; the evidence keeps masked fields and the files as files", async () => {
    const { context, finish, sent } = setup(created);
    await context.step("S1", async () => {
      const api = context.api.as("user:standard");
      const res = await api.post(
        "/documents",
        api.multipart({ fields: { title: "Invoice", note: TOKEN }, files: { document: "invoice" } }),
      );
      context.verify("S1", "status", res.status, context.plan.expect("TC-01.S1.status"));
    });
    await context.step("S2", () => undefined);
    const req = sent[0];
    expect(req?.payload?.kind).toBe("multipart");
    if (req?.payload?.kind !== "multipart") throw new Error("not multipart");
    // The application gets the real values; only the evidence is masked.
    expect(req.payload.fields).toEqual({ title: "Invoice", note: TOKEN });
    expect(req.payload.files["document"]).toMatchObject({ name: "invoice.pdf", type: "application/pdf" });
    expect(req.payload.files["document"]?.data.byteLength).toBe(300);
    // The transport sets the multipart boundary: no JSON content type is forced on it.
    expect(req.headers["content-type"]).toBeUndefined();
    const record = await finish();
    const call = JSON.parse(String(record.evidence.find((e) => e.name === "S1-01.json")?.content)) as {
      request: { body: unknown };
      curl: string;
    };
    expect(call.request.body).toEqual({
      multipart: {
        fields: { title: "Invoice", note: "***" },
        files: [
          {
            field: "document",
            name: "invoice.pdf",
            type: "application/pdf",
            bytes: 300,
            sha256: createHash("sha256")
              .update(req.payload.files["document"]?.data ?? new Uint8Array())
              .digest("hex"),
          },
        ],
      },
    });
    expect(call.curl).toContain("-F 'note=***'");
    expect(call.curl).toContain("-F 'document=@invoice.pdf;type=application/pdf'");
    expect(call.curl).not.toContain(TOKEN);
    const upload = record.evidence.find((e) => e.name === "S1-upload-invoice.pdf");
    expect(upload?.content).toBeInstanceOf(Uint8Array);
  });

  it("REQ-EXEC-45/AC1: urlencoded forms, raw binary from the plan's files and plain text", async () => {
    const { context, sent } = setup(created);
    await context.step("S1", async () => {
      const api = context.api;
      await api.post("/login", api.form({ user: "anna", password: TOKEN }));
      await api.put("/documents/1/raw", api.binary("invoice"));
      await api.post("/notes", api.text("first line\nsecond", "text/csv"));
      await api.post("/notes", api.text("plain"));
    });
    expect(sent.map((r) => r.payload?.kind)).toEqual(["form", "bytes", "bytes", "bytes"]);
    expect(sent[0]?.payload).toEqual({ kind: "form", fields: { user: "anna", password: TOKEN } });
    expect(sent[1]?.payload).toMatchObject({ kind: "bytes", type: "application/pdf" });
    expect(sent[1]?.headers["content-type"]).toBe("application/pdf");
    expect(sent[2]?.headers["content-type"]).toBe("text/csv");
    expect(
      new TextDecoder().decode(sent[2]?.payload?.kind === "bytes" ? sent[2].payload.data : undefined),
    ).toBe("first line\nsecond");
    expect(sent[3]?.headers["content-type"]).toBe("text/plain");
  });

  it("REQ-EXEC-45/AC2+AC3: a binary response is kept as a file with its hash and checked against the plan; never inlined", async () => {
    const { context, finish } = setup((req) =>
      new URL(req.url).pathname === "/documents/1/pdf"
        ? {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": 'attachment; filename="report.pdf"',
            },
            text: new TextDecoder().decode(PDF),
            bytes: PDF,
          }
        : created(),
    );
    await context.step("S1", async () => {
      const res = await context.api.post("/documents", { title: "x" });
      context.verify("S1", "status", res.status, context.plan.expect("TC-01.S1.status"));
    });
    await context.step("S2", async () => {
      const res = await context.api.get("/documents/1/pdf");
      context.verify("S2", "status", res.status, context.plan.expect("TC-01.S2.status"));
      context.verify("S2", "download.type", undefined, context.plan.expect("TC-01.S2.download.type"));
      context.verify("S2", "download.sha256", undefined, context.plan.expect("TC-01.S2.download.sha256"));
      context.verify("S2", "download.size", undefined, context.plan.expect("TC-01.S2.download.size"));
    });
    const record = await finish();
    expect(record.outcome).toBe("passed");
    const file = record.evidence.find((e) => e.name === "S2-download-report.pdf");
    expect(file?.content).toEqual(PDF);
    const call = JSON.parse(String(record.evidence.find((e) => e.name === "S2-01.json")?.content)) as {
      response: { body: unknown };
    };
    expect(call.response.body).toEqual({
      file: "S2-download-report.pdf",
      type: "application/pdf",
      bytes: PDF.byteLength,
      sha256: PDF_SHA,
    });
  });

  it("REQ-EXEC-45/AC2: a different file fails the step; a step without a file response fails, never passes", async () => {
    const other = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const { context, finish } = setup(() => ({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      text: "",
      bytes: other,
    }));
    await context.step("S1", () => undefined);
    await context.step("S2", async () => {
      await context.api.get("/documents/1/pdf");
      context.verify("S2", "download.sha256", undefined, context.plan.expect("TC-01.S2.download.sha256"));
    });
    expect((await finish()).outcome).toBe("failed");
    const json = setup(created);
    await json.context.step("S1", () => undefined);
    await json.context.step("S2", async () => {
      await json.context.api.get("/documents/1/pdf");
      json.context.verify(
        "S2",
        "download.sha256",
        undefined,
        json.context.plan.expect("TC-01.S2.download.sha256"),
      );
    });
    const record = await json.finish();
    expect(record.outcome).toBe("failed");
    expect(record.assertions[0]).toMatchObject({ actual: "(no download in this step)", pass: false });
  });

  it("REQ-EXEC-45/AC1 + REQ-EXEC-38/AC1: a body names files of the plan by key; a path, unknown key or forged body is refused", async () => {
    const { context, sent } = setup(created);
    await context.step("S1", async () => {
      const api = context.api;
      await expect(api.post("/x", api.binary("../../etc/passwd"))).rejects.toThrow(
        /not a file of TC-01 in the plan/,
      );
      await expect(api.post("/x", api.multipart({ files: { document: "missing" } }))).rejects.toThrow(
        /not a file of TC-01 in the plan/,
      );
      // A JSON body that imitates a body descriptor is checked the same way.
      await expect(api.post("/x", { __qjBody: "binary", file: "/etc/passwd" })).rejects.toThrow(
        /not a file of TC-01 in the plan/,
      );
      await expect(api.post("/x", { __qjBody: "multipart", files: { a: 7 } })).rejects.toThrow(
        /invalid request body/,
      );
    });
    // Refused before anything is sent; the API runner ends such an attempt as an error (sandbox).
    expect(sent).toEqual([]);
  });
});
