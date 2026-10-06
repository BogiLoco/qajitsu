import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  chunkSections,
  docxToText,
  extractDocument,
  htmlToText,
  isNeverIndexed,
  markdownSections,
  maskCredentials,
} from "./extract.js";
import { checkDocQuote, chunkId, fuseRankings, isOutdated, retrievalMode } from "./sources.js";
import type { KnowledgeChunk } from "../interfaces/knowledge-store.js";

/** A minimal ZIP with deflated entries, as Word writes them. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const chunk = (over: Partial<KnowledgeChunk> = {}): KnowledgeChunk => ({
  id: "a-0",
  source: "docs",
  path: "docs/orders.md",
  section: "Orders",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  fileHash: "f",
  hash: "h",
  tags: [],
  text: "A paid order can be **cancelled** within 24 hours.\nAfter that, a refund is needed.",
  ...over,
});

describe("knowledge extraction (REQ-KNOW-02)", () => {
  it("REQ-KNOW-02/AC2+AC5: Markdown is split by headings and keeps the heading path; fences are not headings", () => {
    expect(
      markdownSections("intro\n# Orders\ntext\n```\n# not a heading\n```\n## Cancel\nrules\n# Payments\np"),
    ).toEqual([
      { section: "", text: "intro" },
      { section: "Orders", text: "text\n```\n# not a heading\n```" },
      { section: "Orders > Cancel", text: "rules" },
      { section: "Payments", text: "p" },
    ]);
  });

  it("REQ-KNOW-02/AC2: HTML loses scripts and tags, keeps headings and decodes entities", () => {
    expect(
      htmlToText("<script>x()</script><h2>Refunds &amp; returns</h2><p>Within <b>14</b> days&nbsp;only.</p>"),
    ).toBe("## Refunds & returns\nWithin 14 days only.");
  });

  it("REQ-KNOW-02/AC2: DOCX paragraphs and heading styles become Markdown", () => {
    const doc = zip({
      "word/document.xml":
        '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Orders</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Cancel </w:t></w:r><w:r><w:t>within a day &amp; get money back.</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(docxToText(doc)).toBe("# Orders\n\nCancel within a day & get money back.");
    expect(extractDocument("spec.docx", doc)).toEqual({
      ok: true,
      format: "docx",
      sections: [{ section: "Orders", text: "Cancel within a day & get money back." }],
    });
    expect(extractDocument("broken.docx", Buffer.from("nope"))).toMatchObject({ ok: false });
  });

  it("REQ-KNOW-02/AC2: OpenAPI is split per operation; other YAML, PDF and unknown formats are skipped with a reason", () => {
    const spec =
      "openapi: 3.0.0\ninfo: { title: Shop }\npaths:\n  /orders:\n    get: { summary: list }\n    post: { summary: create }\n";
    const out = extractDocument("api/openapi.yaml", Buffer.from(spec));
    expect(out.ok && out.sections.map((s) => s.section)).toEqual(["info", "GET /orders", "POST /orders"]);
    expect(extractDocument("ci.yml", Buffer.from("jobs: {}"))).toEqual({
      ok: false,
      reason: "only OpenAPI documents are read from YAML and JSON",
    });
    expect(extractDocument("a.pdf", Buffer.from("%PDF"))).toMatchObject({ ok: false });
    expect(extractDocument("logo.png", Buffer.from(""))).toEqual({
      ok: false,
      reason: "unsupported format .png",
    });
  });

  it("REQ-KNOW-02/AC5: long sections are chunked at paragraph boundaries and keep their section", () => {
    const text = Array.from({ length: 6 }, (_, i) => `${String(i)} ${"x".repeat(500)}`).join("\n\n");
    const chunks = chunkSections([{ section: "Big", text }], 1_100);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.section === "Big" && c.text.length <= 1_100)).toBe(true);
    expect(
      chunkSections([{ section: "", text: "y".repeat(2_500) }], 1_000).map((c) => c.text.length),
    ).toEqual([1_000, 1_000, 500]);
  });
});

describe("knowledge security (REQ-KNOW-09)", () => {
  it("REQ-KNOW-09/AC1: env files, keys, certificates and credential stores are never indexed", () => {
    for (const p of [
      ".env",
      "conf/.env.local",
      "tls/server.key",
      "ca.pem",
      "id_ed25519",
      ".npmrc",
      "aws/credentials",
    ])
      expect(isNeverIndexed(p), p).toBe(true);
    for (const p of ["docs/env.md", "keys.md", "README.md", "environment.html"])
      expect(isNeverIndexed(p), p).toBe(false);
  });

  it("REQ-KNOW-09/AC1: credential-shaped values are masked before chunking", () => {
    const text = [
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      'password = "hunter2hunter2"',
      "key AKIAABCDEFGHIJKLMNOP here",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      "The password policy needs 12 characters.",
    ].join("\n");
    const masked = maskCredentials(text);
    for (const leaked of ["ghp_abc", "abcdefghijklmnopqrstuvwxyz", "hunter2", "AKIAABCD", "MIIE"])
      expect(masked).not.toContain(leaked);
    expect(masked).toContain("Authorization: Bearer ***");
    expect(masked).toContain('password = "***"');
    expect(masked).toContain("The password policy needs 12 characters.");
  });
});

describe("knowledge retrieval (REQ-KNOW-06, REQ-KNOW-07, REQ-KNOW-10)", () => {
  it("REQ-KNOW-07/AC1+AC2: documentation within the budget is used in full, above it hybrid", () => {
    expect(retrievalMode(80_000, 20_000)).toBe("full");
    expect(retrievalMode(80_001, 20_000)).toBe("hybrid");
    expect(retrievalMode(1, 0)).toBe("hybrid");
  });

  it("REQ-KNOW-07/AC2: reciprocal rank fusion ranks chunks found by both searches first", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => chunk({ id }));
    if (!a || !b || !c) throw new Error("fixture");
    expect(
      fuseRankings(
        [
          [a, b],
          [c, b],
        ],
        2,
      ).map((h) => h.chunk.id),
    ).toEqual(["b", "a"]);
  });

  it("REQ-KNOW-06/AC3: a documentation quote must appear verbatim in the stored chunk", () => {
    expect(checkDocQuote("A paid order can be cancelled within 24 hours.", chunk())).toBeUndefined();
    expect(checkDocQuote("a paid order can be  cancelled\nwithin 24 hours", chunk())).toBeUndefined();
    expect(checkDocQuote("A paid order can be cancelled within 48 hours.", chunk())).toBe(
      "the quote is not in docs/orders.md",
    );
    expect(checkDocQuote("cancelled", chunk())).toBe("the quote is too short to be checked");
    expect(checkDocQuote("A paid order can be cancelled", undefined)).toMatch(/no such documentation chunk/);
  });

  it("REQ-KNOW-10/AC1: chunks of files older than max_age_days are outdated", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    expect(isOutdated(chunk(), 365, now)).toBe(false);
    expect(isOutdated(chunk(), 100, now)).toBe(true);
    expect(isOutdated(chunk(), undefined, now)).toBe(false);
  });

  it("chunk ids are stable per file and ordinal", () => {
    expect(chunkId("docs/a.md", 0)).toBe(chunkId("docs/a.md", 0));
    expect(chunkId("docs/a.md", 0)).not.toBe(chunkId("docs/b.md", 0));
    expect(chunkId("docs/a.md", 3)).toMatch(/^[0-9a-f]{16}-3$/);
  });
});
