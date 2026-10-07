import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  AdapterError,
  xlsxRows,
  type ImportedCase,
  type TestCaseSource,
  type TicketKey,
} from "@qajitsu/core";
import { MAX_CASES, toCase } from "./common.js";

/**
 * Parses CSV text (RFC 4180 quotes; comma or semicolon separated, as Excel writes it in many locales).
 *
 * @param text - CSV file content.
 * @returns Rows of cells.
 */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Header names accepted for each column, compared lower-case. */
const COLUMNS = {
  id: ["id", "case id", "test id", "key", "case"],
  ticket: ["ticket", "tickets", "refs", "references", "issue", "jira", "requirement"],
  title: ["title", "name", "summary"],
  preconditions: ["preconditions", "precondition"],
  action: ["step", "steps", "action"],
  data: ["data", "test data"],
  expected: ["expected", "expected result", "result"],
} as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Manual test cases from a CSV or Excel (.xlsx) file: one row per step, rows with the same id form one case, and the
 * ticket column (several keys separated by commas allowed) selects the cases of the ticket.
 *
 * @param path - Absolute path of the file.
 * @example
 * const file = createFileCaseSource("/repo/.qa/testcases.csv");
 */
export function createFileCaseSource(path: string): TestCaseSource {
  return {
    system: "file",
    async findCases(ticket: TicketKey): Promise<readonly ImportedCase[]> {
      const bytes = await readFile(path).catch(() => undefined);
      if (bytes === undefined)
        throw new AdapterError("TESTCASES_FILE_UNREADABLE", `Test case file ${path} cannot be read.`, {
          path,
        });
      const rows =
        extname(path).toLowerCase() === ".xlsx" ? xlsxRows(bytes) : parseCsv(bytes.toString("utf8"));
      if (rows === undefined || rows.length === 0)
        throw new AdapterError("TESTCASES_FILE_UNREADABLE", `${path} is not a readable CSV or XLSX file.`, {
          path,
        });
      const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
      const col = (names: readonly string[]): number => header.findIndex((h) => names.includes(h));
      const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, col(names)])) as Record<
        keyof typeof COLUMNS,
        number
      >;
      if (at.id < 0 || at.ticket < 0 || at.title < 0)
        throw new AdapterError(
          "TESTCASES_FILE_COLUMNS",
          `${path} needs the columns id, ticket and title (found: ${header.join(", ")}).`,
          { path },
        );
      const get = (r: readonly string[], i: number): string => (i < 0 ? "" : (r[i] ?? "").trim());
      const grouped = new Map<
        string,
        { title: string; preconditions: string; steps: { action: string; data: string; expected: string }[] }
      >();
      for (const r of rows.slice(1)) {
        const id = get(r, at.id);
        if (
          !ID.test(id) ||
          !get(r, at.ticket)
            .split(/[,;\s]+/)
            .includes(ticket)
        )
          continue;
        const entry = grouped.get(id) ?? { title: "", preconditions: "", steps: [] };
        if (entry.title === "") entry.title = get(r, at.title);
        if (entry.preconditions === "") entry.preconditions = get(r, at.preconditions);
        const step = { action: get(r, at.action), data: get(r, at.data), expected: get(r, at.expected) };
        if (step.action !== "" || step.expected !== "") entry.steps.push(step);
        grouped.set(id, entry);
      }
      const out: ImportedCase[] = [];
      for (const [id, c] of grouped) {
        const imported = toCase({
          system: "file",
          id,
          title: c.title,
          preconditions: c.preconditions,
          steps: c.steps,
        });
        if (imported) out.push(imported);
      }
      return out.slice(0, MAX_CASES);
    },
  };
}
