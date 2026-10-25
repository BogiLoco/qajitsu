import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMatrixXlsx, zip } from "@qajitsu/report";
import { afterEach, describe, expect, it } from "vitest";
import { extractDownloadText, readFixture } from "./web-files.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A one-page PDF with a text layer, written by hand. */
function pdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("files of web cases in the CLI (REQ-EXEC-38)", () => {
  it("REQ-EXEC-38/AC1: fixtures are read from .qa/fixtures/ only, symbolic links included", async () => {
    const qa = await mkdtemp(join(tmpdir(), "qj-fx-"));
    dirs.push(qa);
    await mkdir(join(qa, "fixtures", "images"), { recursive: true });
    await writeFile(join(qa, "fixtures", "images", "a.png"), "png");
    await writeFile(join(qa, "outside.txt"), "secret");
    await symlink(join(qa, "outside.txt"), join(qa, "fixtures", "link.txt"));
    expect(new TextDecoder().decode(await readFixture(qa, "images/a.png"))).toBe("png");
    await expect(readFixture(qa, "../outside.txt")).rejects.toThrow("is outside .qa/fixtures/");
    await expect(readFixture(qa, "link.txt")).rejects.toThrow("is outside .qa/fixtures/");
    await expect(readFixture(qa, "missing.png")).rejects.toThrow("No fixture missing.png");
    await expect(readFixture(qa, "images")).rejects.toThrow("not a file of at most 50 MB");
  });

  it("REQ-EXEC-38/AC2: the text of XLSX (inline and shared strings) and PDF downloads; other types are not read", async () => {
    const own = await extractDownloadText(
      "matrix.xlsx",
      renderMatrixXlsx([
        {
          caseId: "TC-01",
          title: "Total, rounded",
          requirement: "AC1",
          type: "api",
          status: "PASSED",
          stepsPassed: 1,
          stepsTotal: 1,
          evidence: "2",
        },
      ]),
    );
    expect(own).toContain('TC-01,"Total, rounded"');
    const shared = zip([
      {
        name: "xl/sharedStrings.xml",
        data: new TextEncoder().encode(
          "<sst><si><t>Name</t></si><si><r><t>Mu</t></r><r><t>g &amp; co</t></r></si></sst>",
        ),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: new TextEncoder().encode(
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12.5</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"/></row></sheetData></worksheet>',
        ),
      },
    ]);
    expect(await extractDownloadText("prices.XLSX", shared)).toBe("Name,12.5\nMug & co,\n");
    expect(await extractDownloadText("broken.xlsx", new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(
      await extractDownloadText("nosheet.xlsx", zip([{ name: "x.txt", data: new Uint8Array() }])),
    ).toBeUndefined();
    expect(await extractDownloadText("invoice.pdf", pdf("Invoice total 42.00"))).toContain(
      "Invoice total 42.00",
    );
    expect(await extractDownloadText("broken.pdf", new TextEncoder().encode("not a pdf"))).toBeUndefined();
    expect(await extractDownloadText("photo.png", new Uint8Array([1]))).toBeUndefined();
  });
});
