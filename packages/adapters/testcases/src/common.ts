import { ImportedCaseSchema, type ImportedCase } from "@qajitsu/core";

/** Most cases read from one source for one ticket. */
export const MAX_CASES = 500;

const cut = (s: string | null | undefined, max: number): string | undefined => {
  const t = (s ?? "").trim();
  return t === "" ? undefined : t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Builds a valid imported case, shortening long texts to the schema limits.
 *
 * @returns The case, or undefined when its id is not a valid `<system>:<id>`.
 */
export function toCase(input: {
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
