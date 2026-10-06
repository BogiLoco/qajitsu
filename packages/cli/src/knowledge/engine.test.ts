import { describe, expect, it } from "vitest";
import { makePdf } from "../../../../tests/support/pdf.js";
import { extractPdf, globMatch } from "./engine.js";

describe("PDF documents (REQ-KNOW-02/AC2)", () => {
  it("REQ-KNOW-02/AC2: a PDF with a text layer is read page by page", async () => {
    const out = await extractPdf(
      makePdf([
        ["Refund policy", "Refunds reach the card in five working days."],
        ["Cancel within 24 hours."],
      ]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sections.map((s) => s.section)).toEqual(["page 1", "page 2"]);
    expect(out.sections[0]?.text).toContain("Refunds reach the card in five working days.");
    expect(out.sections[1]?.text).toContain("Cancel within 24 hours.");
  });

  it("REQ-KNOW-02/AC2: PDFs without a text layer and broken files are skipped with the reason", async () => {
    expect(await extractPdf(makePdf([[]]))).toEqual({
      ok: false,
      reason: "PDF has no text layer (scanned image?)",
    });
    expect(await extractPdf(Buffer.from("%PDF-1.4 broken"))).toEqual({
      ok: false,
      reason: "not a readable PDF file",
    });
  });
});

describe("source filters (REQ-KNOW-02/AC1)", () => {
  it("REQ-KNOW-02/AC1: globs match paths, base names and nested folders", () => {
    expect(globMatch("*.md", "guide/intro.md")).toBe(true);
    expect(globMatch("**/*.md", "a/b/c.md")).toBe(true);
    expect(globMatch("api/*.yaml", "api/openapi.yaml")).toBe(true);
    expect(globMatch("api/*.yaml", "v2/api/openapi.yaml")).toBe(false);
    expect(globMatch("draft-?.md", "draft-1.md")).toBe(true);
    expect(globMatch("*.md", "notes.mdx")).toBe(false);
  });
});
