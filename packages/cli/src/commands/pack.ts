import { TestCaseSchema, sha256 } from "@qajitsu/core";
import { z } from "zod";

/** Canonical JSON (keys sorted at every level, undefined members left out), so a hash does not depend on key order or YAML formatting. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * SHA-256 of a pack's cases (their expected values) as recorded in `expectations.yaml` (REQ-EXEC-17/AC2).
 *
 * @param cases - The cases of the pack.
 */
export function packCasesSha256(cases: readonly unknown[]): string {
  return sha256(canonicalJson(cases));
}

/** `expectations.yaml` of a regression pack written by `qj promote` (REQ-PUB-08, REQ-EXEC-17). */
export const RegressionPackSchema = z.object({
  schema: z.literal(1),
  kind: z.literal("qajitsu-regression-pack"),
  ticket: z.string(),
  run: z.string(),
  plan: z.object({
    version: z.number().int().positive(),
    sha256: z.string(),
    approved_by: z.string(),
    approved_at: z.string(),
  }),
  promoted_by: z.string(),
  promoted_at: z.string(),
  /** SHA-256 of each spec file by case id. */
  specs: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  /** SHA-256 of `cases`, see {@link packCasesSha256}. */
  cases_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  cases: z.array(TestCaseSchema).min(1),
});

/** A parsed regression pack. */
export type RegressionPack = z.infer<typeof RegressionPackSchema>;

/** `data.regression` of a run made by `qj regression` (REQ-EXEC-17). */
export const RegressionRunSchema = z.object({
  /** Folder of the pack, relative to the tests repository. */
  pack: z.string(),
  /** The run the pack was promoted from. */
  promotedFrom: z.string(),
  /** Cases whose spec or expectations failed the hash check, with the reason; they are BLOCKED. */
  blocked: z.record(z.string(), z.string()).default({}),
});
