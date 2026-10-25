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
  const named = [
    ...path.map(String),
    ...[...message.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? ""),
    ...[...message.matchAll(/key[s]?: ([a-z_, ]+)/gi)].flatMap((m) => (m[1] ?? "").split(/[, ]+/)),
  ];
  const field = named.reverse().find((k) => k in PLACES);
  return field === undefined ? message : `${message} ("${field}" ${PLACES[field] ?? ""})`;
}
