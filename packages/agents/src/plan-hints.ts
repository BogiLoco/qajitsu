/**
 * Where a misplaced plan field belongs, added to a validation error so a model can repair its answer (dogfood pass
 * 2026-10-25: a local model put `geolocation` into `expect.elements` and failed three repairs on "Invalid key in
 * record").
 */
const PLACES: Readonly<Record<string, string>> = {
  geolocation:
    'belongs to the case: "browser": {"permissions": ["geolocation"], "geolocation": {"latitude": .., "longitude": ..}} next to "steps"',
  permissions: 'belongs to the case: "browser": {"permissions": [...]} next to "steps"',
  clock: 'belongs to the case: "browser": {"clock": "<ISO time>"} next to "steps"',
  service_workers: 'belongs to the case: "browser": {"service_workers": true} next to "steps"',
  websocket: 'goes directly into the step\'s expect ("websocket": {"received": [..]}), not into "elements"',
  manifest: 'goes directly into the step\'s expect ("manifest": {"short_name": ..}), not into "elements"',
  browser: 'belongs to the case, next to "steps", not to a step or its expect',
  dialog:
    'the answer belongs to the step ("dialog": {"action": "accept"}), the check to its expect ("dialog": {"type": .., "message": ..})',
  files: 'belongs to the case: "files": {"<key>": {...}} next to "steps"',
  download: 'goes directly into the step\'s expect ("download": {...}), not into "elements"',
  state: 'goes directly into the step\'s expect ("state": {"<path>": <value>}), not into "elements"',
  scroll_limit: 'belongs to the step, next to "action" and "expect"',
};

/**
 * A validation error with the place a known field belongs to, when the error is about such a field.
 *
 * @param path - Path of the issue, e.g. `["cases", 2, "steps", 0, "expect", "elements", "geolocation"]`.
 * @param message - The validator's message.
 */
export function withPlacementHint(path: readonly PropertyKey[], message: string): string {
  const key = path.at(-1);
  // A selector used as a state path (dogfood pass 2026-10-25: "state": {"testid:address-1": ...}).
  if (path.at(-2) === "state" && typeof key === "string" && key.includes(":"))
    return `${message} ("${key}" is an element: its check goes into "elements": {"${key}": {"visible": ..}}; "state" holds paths of the application's test hook)`;
  if (path.at(-1) === "evidence" && path.at(-3) === "cases")
    return `${message} (every case lists its evidence, e.g. "evidence": ["screenshot"] for web and mobile, ["request", "response"] for API)`;
  const named = [
    ...path.map(String),
    ...[...message.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? ""),
    ...[...message.matchAll(/key[s]?: ([a-z_, ]+)/gi)].flatMap((m) => (m[1] ?? "").split(/[, ]+/)),
  ];
  const field = named.reverse().find((k) => k in PLACES);
  if (field !== undefined) return `${message} ("${field}" ${PLACES[field] ?? ""})`;
  // An element key without its selector kind (`offer-status` for `testid:offer-status`).
  if (path.at(-2) === "elements" && typeof key === "string" && !key.includes(":"))
    return `${message} (an element key is a selector with its kind: "testid:${key}", "role:button:${key}" or "text:${key}")`;
  return message;
}

/** Evidence a case collects when its plan names none: what its runner records anyway. */
const DEFAULT_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  api: ["request", "response"],
  web: ["screenshot"],
  mobile: ["screenshot"],
};

/**
 * Fills the evidence of plan cases that name none (missing or empty), by case type; returns the cases it filled.
 * Evidence decides no status, so code completes it instead of failing the plan (dogfood pass 2026-10-28).
 *
 * @param raw - The planner's answer as parsed JSON, not yet validated.
 */
export function fillMissingEvidence(raw: unknown): {
  readonly value: unknown;
  readonly filled: readonly string[];
} {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as { cases?: unknown }).cases))
    return { value: raw, filled: [] };
  const filled: string[] = [];
  const cases = (raw as { cases: unknown[] }).cases.map((c) => {
    if (c === null || typeof c !== "object") return c;
    const kase = c as { id?: unknown; type?: unknown; evidence?: unknown };
    const defaults = typeof kase.type === "string" ? DEFAULT_EVIDENCE[kase.type] : undefined;
    if (defaults === undefined || (Array.isArray(kase.evidence) && kase.evidence.length > 0)) return c;
    filled.push(typeof kase.id === "string" ? kase.id : "?");
    return { ...kase, evidence: [...defaults] };
  });
  return { value: { ...raw, cases }, filled };
}
