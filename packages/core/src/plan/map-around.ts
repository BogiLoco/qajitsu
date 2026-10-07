import { readFile } from "node:fs/promises";
import { z } from "zod";

/** Id of an application map node: `page:<route>` or `api:<METHOD> <path>` (REQ-OBS-07). */
export const MapNodeIdSchema = z
  .string()
  .regex(/^(page|api):\S.{0,300}$/, "Expected a map id like page:/cart");

/**
 * The part of the project's application map around a change (REQ-OBS-08), computed by code from past runs before
 * planning and stored in `<run>/map/around.json`. Plan cases may cite its ids.
 */
export const MapAroundSchema = z.strictObject({
  generatedAt: z.string(),
  /** Runs the map was built from. */
  runs: z.number().int().nonnegative(),
  /** Screens and endpoints the change touches, with whether any run tested them. */
  changed: z.array(
    z.strictObject({
      id: MapNodeIdSchema,
      tested: z.boolean(),
      tickets: z.array(z.string()),
      lastTested: z.string().optional(),
    }),
  ),
  /** Screens and endpoints next to the change that no run ever reached. */
  untested: z.array(z.strictObject({ id: MapNodeIdSchema, near: MapNodeIdSchema })),
  /** Transitions from or to a changed node, aggregated over past runs. */
  transitions: z.array(
    z.strictObject({
      from: z.string(),
      to: z.string(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      lastOutcome: z.string(),
    }),
  ),
});

/** Parsed `map/around.json`. */
export type MapAround = z.infer<typeof MapAroundSchema>;

/** Every map id a plan case may cite: changed and untested nodes and both ends of the listed transitions. */
export function mapAroundIds(around: MapAround | undefined): Set<string> {
  if (!around) return new Set();
  return new Set([
    ...around.changed.map((c) => c.id),
    ...around.untested.map((u) => u.id),
    ...around.transitions.flatMap((t) => [t.from, t.to]),
  ]);
}

/**
 * Reads `map/around.json`; undefined when it is missing or invalid, so planning never depends on it.
 *
 * @param file - Path of the file.
 */
export async function readMapAround(file: string): Promise<MapAround | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = MapAroundSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
