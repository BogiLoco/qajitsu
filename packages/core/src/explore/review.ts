import { z } from "zod";
import { ConfigError } from "../errors.js";
import type { CliExploreSession } from "./cli-session.js";
import type { ExploreSession } from "./session.js";

/** Ids of what a person reviews in a session: observations `O1`, findings `F1`, not-done checklist items `C3`. */
export const ReviewItemIdSchema = z.string().regex(/^[OFC][1-9]\d{0,2}$/);

/** One thing of an exploratory session a person accepts or rejects before planning (REQ-PLAN-11/AC1). */
export interface ReviewItem {
  readonly id: string;
  readonly kind: "observation" | "finding" | "not-done";
  readonly title: string;
  /** What was seen, or why it was not done. */
  readonly detail: string;
  /** Actions of the session that show it. */
  readonly actions: readonly string[];
}

/** One decision of a person about one item. */
export const ReviewDecisionSchema = z.strictObject({
  item: ReviewItemIdSchema,
  decision: z.enum(["accepted", "rejected"]),
  by: z.string().min(1).max(200),
  at: z.string(),
  note: z.string().max(1000).optional(),
});

/**
 * `explore/<session>/review.json`: the decisions of people about the items of one session (REQ-PLAN-11/AC1+AC2).
 * Written by the command a person runs, never by an agent; the decisions count only while the session file still has
 * the SHA-256 they were made on.
 */
export const ReviewRecordSchema = z.strictObject({
  schema: z.literal(1),
  session: z.string().regex(/^S\d{2,3}$/),
  sessionSha256: z.string().regex(/^[0-9a-f]{64}$/),
  decisions: z.array(ReviewDecisionSchema),
});

/** Parsed `review.json`. */
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

/**
 * The items of a session to review (REQ-PLAN-11/AC1): every observation, every finding, and every checklist item the
 * explorer did not do. Checklist items keep their position (`C2` is the second item).
 *
 * @param session - A browser or command-line session.
 */
export function reviewItems(session: ExploreSession | CliExploreSession): ReviewItem[] {
  const observations = session.observations.map((o): ReviewItem => ({
    id: o.id,
    kind: "observation",
    title: o.title,
    detail: `${o.kind}, ${o.severity}: ${o.description}${o.expected || o.actual ? ` (expected: ${o.expected || "-"}; actual: ${o.actual || "-"})` : ""}`,
    actions: o.steps,
  }));
  const findings = session.findings.map((f, i): ReviewItem => ({
    id: `F${String(i + 1)}`,
    kind: "finding",
    title: f.text,
    detail: "",
    actions: f.actions,
  }));
  const notDone = session.checklist.flatMap((c, i): ReviewItem[] =>
    c.actions.length > 0
      ? []
      : [
          {
            id: `C${String(i + 1)}`,
            kind: "not-done",
            title: c.item,
            detail: `not done: ${c.notDone ?? "not reported"}`,
            actions: [],
          },
        ],
  );
  return [...observations, ...findings, ...notDone];
}

/**
 * Adds a person's decisions to a session's review (REQ-PLAN-11/AC1+AC2). Decisions made on another version of the
 * session file are dropped: they no longer count.
 *
 * @param previous - The review so far, if any.
 * @param input - Session, its current SHA-256, its items, the decisions, who and when.
 * @returns The new review record.
 * @throws {ConfigError} `EXPLORE_ITEM_UNKNOWN` for an item the session does not have.
 */
export function recordDecisions(
  previous: ReviewRecord | undefined,
  input: {
    readonly session: string;
    readonly sessionSha256: string;
    readonly items: readonly ReviewItem[];
    readonly decisions: readonly {
      readonly item: string;
      readonly decision: "accepted" | "rejected";
      readonly note?: string | undefined;
    }[];
    readonly by: string;
    readonly at: string;
  },
): ReviewRecord {
  const known = input.items.map((i) => i.id);
  for (const d of input.decisions)
    if (!known.includes(d.item))
      throw new ConfigError(
        "EXPLORE_ITEM_UNKNOWN",
        `${d.item} is not an item of session ${input.session} (items: ${known.join(", ") || "none"})`,
        { session: input.session, item: d.item },
      );
  const kept = previous?.sessionSha256 === input.sessionSha256 ? previous.decisions : [];
  return ReviewRecordSchema.parse({
    schema: 1,
    session: input.session,
    sessionSha256: input.sessionSha256,
    decisions: [
      ...kept,
      ...input.decisions.map((d) => ({
        item: d.item,
        decision: d.decision,
        by: input.by,
        at: input.at,
        ...(d.note ? { note: d.note } : {}),
      })),
    ],
  });
}

/**
 * Items whose latest decision is "accepted" (REQ-PLAN-11/AC2+AC3), in the order they were last decided. Nothing
 * counts when the session file changed after the decisions.
 *
 * @param review - The session's review, if any.
 * @param sessionSha256 - SHA-256 of the session file now.
 */
export function acceptedItems(review: ReviewRecord | undefined, sessionSha256: string): string[] {
  if (review?.sessionSha256 !== sessionSha256) return [];
  const latest = new Map<string, string>();
  for (const d of review.decisions) {
    latest.delete(d.item);
    latest.set(d.item, d.decision);
  }
  return [...latest].filter(([, d]) => d === "accepted").map(([item]) => item);
}
