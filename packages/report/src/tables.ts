import type { MatrixRow } from "./matrix.js";
import { summaryLine } from "./matrix.js";
import { zip } from "./zip.js";

const HEADER = [
  "TC",
  "Title",
  "Requirement",
  "Type",
  "Status",
  "Steps OK",
  "Steps total",
  "Evidence",
] as const;

const values = (r: MatrixRow, hints = false, manual = false): (string | number)[] => [
  r.caseId,
  r.title,
  r.requirement,
  r.type.toUpperCase(),
  r.status,
  r.stepsPassed,
  r.stepsTotal,
  r.evidence,
  ...(manual ? [r.manual ?? ""] : []),
  ...(hints ? [r.hint ?? ""] : []),
];

/**
 * Columns of the matrix: manual steps (REQ-EXEC-11/AC6) and hints (REQ-VER-12/AC3) appear only when a row has them.
 */
const flagsOf = (rows: readonly MatrixRow[]): { manual: boolean; hints: boolean } => ({
  manual: rows.some((r) => r.manual !== undefined),
  hints: rows.some((r) => r.hint !== undefined),
});
const headerOf = (rows: readonly MatrixRow[]): readonly string[] => {
  const f = flagsOf(rows);
  return [...HEADER, ...(f.manual ? ["Manual steps"] : []), ...(f.hints ? ["Hint (suggestion)"] : [])];
};

/** Neutralises spreadsheet formulas in text cells (CSV/formula injection). */
const safeText = (value: string): string => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

/**
 * Renders the matrix as CSV (RFC 4180, CRLF), one row per approved case (REQ-EVD-05/AC2).
 *
 * @param rows - Matrix rows.
 */
export function renderMatrixCsv(rows: readonly MatrixRow[]): string {
  const cell = (v: string | number): string => {
    if (typeof v === "number") return String(v);
    const s = safeText(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = headerOf(rows);
  const f = flagsOf(rows);
  return `${[header, ...rows.map((r) => values(r, f.hints, f.manual))].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

const xml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these characters; they are stripped on purpose.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const column = (i: number): string => String.fromCharCode(65 + i);

/**
 * Renders the matrix as an `.xlsx` workbook with a summary sheet line (REQ-EVD-05/AC2).
 *
 * @param rows - Matrix rows.
 */
export function renderMatrixXlsx(rows: readonly MatrixRow[]): Uint8Array {
  const header = headerOf(rows);
  const hints = header.length > HEADER.length;
  const all: (string | number)[][] = [
    [summaryLine(rows)],
    [],
    [...header],
    ...rows.map((r) => values(r, hints)),
  ];
  const sheetRows = all
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${column(ci)}${String(ri + 1)}`;
          return typeof v === "number"
            ? `<c r="${ref}"><v>${String(v)}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(safeText(v))}</t></is></c>`;
        })
        .join("");
      return `<row r="${String(ri + 1)}">${cells}</row>`;
    })
    .join("");
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  return zip([
    {
      name: "[Content_Types].xml",
      data: enc(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: enc(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Matrix" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
      ),
    },
  ]);
}
