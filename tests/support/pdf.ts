/**
 * Builds a minimal valid PDF for tests: one page per entry, each line drawn as text in Helvetica. An empty page
 * list entry gives a page without a text layer (like a scan).
 */
export function makePdf(pages: readonly (readonly string[])[]): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines
      .map((l, i) => `BT /F1 12 Tf 72 ${String(720 - i * 18)} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`)
      .join("\n");
    const content = add(`<< /Length ${String(Buffer.byteLength(ops))} >>\nstream\n${ops}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${String(pagesObj)} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(content)} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pagesObj)} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${String(k)} 0 R`).join(" ")}] /Count ${String(kids.length)} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
