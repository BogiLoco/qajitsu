import { NetworkAnalysisSchema, PassiveObservationsSchema, type RunObservation } from "@qajitsu/core";

/** The last attempt of a case as far as observations are concerned. */
export interface ObservedAttempt {
  readonly caseId: string;
  /** Contract violations are recorded as failed `openapi` assertions (REQ-EXEC-04/AC2). */
  readonly assertions: readonly {
    readonly stepId: string;
    readonly field: string;
    readonly actual: unknown;
    readonly pass: boolean;
  }[];
  /** Content of the attempt's `observations.json`, when there is one. */
  readonly observationsFile?: string | undefined;
  /** Content of the attempt's `network-analysis.json`, when there is one (REQ-EVD-09). */
  readonly networkFile?: string | undefined;
}

/** Where a finding comes from: its HAR entry (REQ-EVD-09/AC7). */
const harRef = (har: number | undefined): string =>
  har === undefined ? "" : ` (network.har #${String(har)})`;

/**
 * Collects the passive observations of a run (REQ-EVD-07) from the last attempt of every case: OpenAPI contract
 * mismatches, console errors, 4xx/5xx responses and accessibility violations. Entries containing one of the
 * `ignore` strings are dropped, duplicates are merged. Pure function; the result is listed for people and never
 * feeds a status or a count (invariant 1).
 *
 * @param attempts - Last attempts with their observation files.
 * @param ignore - Strings from `observations.ignore` in the project config.
 */
export function collectObservations(
  attempts: readonly ObservedAttempt[],
  ignore: readonly string[] = [],
): RunObservation[] {
  const out: RunObservation[] = [];
  const seen = new Set<string>();
  const add = (o: RunObservation): void => {
    const key = `${o.caseId}|${o.kind}|${o.text}`;
    if (seen.has(key) || ignore.some((i) => o.text.includes(i))) return;
    seen.add(key);
    out.push(o);
  };
  for (const a of attempts) {
    // REQ-EVD-09/AC3+AC4+AC6: what code found in the page's traffic.
    if (a.networkFile !== undefined) {
      let network;
      try {
        network = NetworkAnalysisSchema.safeParse(JSON.parse(a.networkFile));
      } catch {
        network = undefined;
      }
      if (network?.success) {
        for (const c of network.data.contract)
          add({
            caseId: a.caseId,
            kind: "ui-contract",
            text: `${c.stepId} ${c.method} ${c.url} → ${String(c.status)}: ${c.problem}${harRef(c.har)}`,
          });
        for (const f of network.data.security)
          add({
            caseId: a.caseId,
            kind: "security",
            text: `${f.stepId} ${f.method} ${f.url}: ${f.detail}${harRef(f.har)}`,
          });
        for (const s of network.data.steps)
          for (const w of s.warnings)
            add({ caseId: a.caseId, kind: "performance", text: `${s.stepId}: ${w}` });
      }
    }
    for (const x of a.assertions)
      if (x.field === "openapi" && !x.pass)
        add({ caseId: a.caseId, kind: "openapi", text: `${x.stepId}: ${String(x.actual)}` });
    if (a.observationsFile === undefined) continue;
    let parsed;
    try {
      parsed = PassiveObservationsSchema.safeParse(JSON.parse(a.observationsFile));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    for (const c of parsed.data.console)
      add({ caseId: a.caseId, kind: "console", text: `${c.url}: ${c.text}` });
    for (const h of parsed.data.http)
      add({ caseId: a.caseId, kind: "http", text: `${h.method} ${h.url} → ${String(h.status)}` });
    for (const v of parsed.data.accessibility)
      add({
        caseId: a.caseId,
        kind: "accessibility",
        text: `${v.url}: ${v.rule}${v.impact ? ` (${v.impact})` : ""} ${v.help}${v.targets.length > 0 ? ` [${v.targets.join(", ")}]` : ""}`,
      });
  }
  return out;
}
