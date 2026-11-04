import { readFile } from "node:fs/promises";
import { z } from "zod";

/** Systems manual test cases are imported from (REQ-CTX-08/AC1). */
export const IMPORTED_CASE_SYSTEMS = ["xray", "zephyr", "testrail", "file"] as const;

/** Id a plan cites for an imported case: `<system>:<id in that system>`, e.g. `testrail:C1234` or `zephyr:SHOP-T12`. */
export const ImportedCaseIdSchema = z
  .string()
  .regex(
    /^(xray|zephyr|testrail|file):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "Expected an id like testrail:C1234",
  );

/** A manual test case read from a test management tool or a file. Its text is untrusted data (REQ-CTX-08/AC3). */
export const ImportedCaseSchema = z.strictObject({
  id: ImportedCaseIdSchema,
  system: z.enum(IMPORTED_CASE_SYSTEMS),
  title: z.string().max(500),
  preconditions: z.string().max(5000).optional(),
  steps: z
    .array(
      z.strictObject({
        action: z.string().max(5000),
        data: z.string().max(5000).optional(),
        expected: z.string().max(5000).optional(),
      }),
    )
    .max(200)
    .default([]),
  /** Link to the case in its tool, shown in the plan. */
  url: z.string().max(2000).optional(),
});

/** An imported manual test case. */
export type ImportedCase = z.infer<typeof ImportedCaseSchema>;

/** What each configured source returned; a source that failed is reported and skipped (REQ-CTX-08/AC4). */
export const ImportedSourceReportSchema = z.strictObject({
  system: z.enum(IMPORTED_CASE_SYSTEMS),
  ok: z.boolean(),
  cases: z.number().int().nonnegative(),
  error: z.string().max(1000).optional(),
});

/** `<run>/imported/cases.json`, written by `qj fetch` (REQ-CTX-08). */
export const ImportedCasesFileSchema = z.strictObject({
  ticket: z.string(),
  fetchedAt: z.string(),
  sources: z.array(ImportedSourceReportSchema),
  cases: z.array(ImportedCaseSchema),
});

/** Parsed `imported/cases.json`. */
export type ImportedCasesFile = z.infer<typeof ImportedCasesFileSchema>;

/**
 * Reads the imported cases of a run; none when the file is missing or invalid, so planning never depends on it.
 *
 * @param file - Path of `imported/cases.json`.
 * @returns The imported cases.
 */
export async function readImportedCases(file: string): Promise<ImportedCase[]> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return [];
  try {
    const parsed = ImportedCasesFileSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data.cases : [];
  } catch {
    return [];
  }
}

/** Most cases read from one source for one ticket. */
export const MAX_IMPORTED_CASES = 500;

const cut = (s: string | null | undefined, max: number): string | undefined => {
  const t = (s ?? "").trim();
  return t === "" ? undefined : t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Builds a valid imported case, shortening long texts to the schema limits.
 *
 * @returns The case, or undefined when its id is not a valid `<system>:<id>`.
 */
export function toImportedCase(input: {
  system: ImportedCase["system"];
  id: string;
  title: string | null | undefined;
  preconditions?: string | null | undefined;
  steps: readonly {
    action?: string | null | undefined;
    data?: string | null | undefined;
    expected?: string | null | undefined;
  }[];
  url?: string | undefined;
}): ImportedCase | undefined {
  const parsed = ImportedCaseSchema.safeParse({
    id: `${input.system}:${input.id}`,
    system: input.system,
    title: cut(input.title, 500) ?? "",
    ...(cut(input.preconditions, 5000) ? { preconditions: cut(input.preconditions, 5000) } : {}),
    steps: input.steps
      .map((s) => ({
        action: cut(s.action, 5000) ?? "",
        ...(cut(s.data, 5000) ? { data: cut(s.data, 5000) } : {}),
        ...(cut(s.expected, 5000) ? { expected: cut(s.expected, 5000) } : {}),
      }))
      .filter((s) => s.action !== "" || s.expected !== undefined)
      .slice(0, 200),
    ...(input.url ? { url: input.url.slice(0, 2000) } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}
