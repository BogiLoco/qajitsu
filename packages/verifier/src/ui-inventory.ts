/** One element id found in the code, as the selector `testid:<id>` refers to it (REQ-PLAN-09/AC7). */
export interface UiSelectorEntry {
  /** `testid:<id>`; for a prefix the part before the generated rest, e.g. `testid:price-`. */
  readonly selector: string;
  /** The id is built at run time from this prefix (`"price-" + p.id`); `testid:price-P-2` matches it. */
  readonly prefix: boolean;
  /** Files that define it, relative to the repository. */
  readonly files: readonly string[];
}

/** Element ids and page paths of the code under test, computed by code from the run's worktree. */
export interface UiInventory {
  readonly selectors: readonly UiSelectorEntry[];
  /** Paths of UI pages, e.g. `/app/checkout`. */
  readonly pages: readonly string[];
}

const QUOTES = `"'\``;

/**
 * Patterns that define an element id the runners address with `testid:`: `data-testid` (web), `testID` (React
 * Native), `dataset.testid`, and accessibility ids on mobile (`setContentDescription`, `android:contentDescription`,
 * `testTag`, `accessibilityIdentifier`). Group 1 is the opening quote, group 2 the id, group 3 what follows it.
 */
const ID_PATTERNS: readonly RegExp[] = [
  /(?:data-testid|testID)\s*=\s*\{?\s*(["'`])([^"'`$\s{}]*)(.)/g,
  /dataset\.testid\s*=\s*(["'`])([^"'`$\s]*)(.)/g,
  /(?:setContentDescription|testTag)\(\s*(["'`])([^"'`$\s]*)(.)/g,
  /android:contentDescription\s*=\s*(")([^"@\s]*)(.)/g,
  /accessibilityIdentifier\s*=\s*(["'`])([^"'`$\s]*)(.)/g,
];

/** Where a UI page path appears: links, router configs and maps of pages keyed by path. */
const PAGE_PATTERNS: readonly RegExp[] = [
  /href\s*=\s*["'](\/[\w./-]*)["']/g,
  /\bpath\s*:\s*["'](\/[\w./:-]*)["']/g,
  /<Route\b[^>]*\bpath\s*=\s*["'](\/[\w./:-]*)["']/g,
  /["'](\/[\w./-]+)["']\s*:\s*[[{(]/g,
];

/**
 * The element ids and page paths one source file defines (REQ-PLAN-09/AC7). An id whose string ends where code
 * continues it (`"price-" + p.id`, `` `price-${id}` ``, `'price-'+id`) is a prefix.
 */
export function scanUiSource(text: string): {
  readonly ids: readonly { readonly id: string; readonly prefix: boolean }[];
  readonly pages: readonly string[];
} {
  const ids = new Map<string, boolean>();
  for (const pattern of ID_PATTERNS)
    for (const m of text.matchAll(pattern)) {
      // Every pattern has exactly these three groups, so each one is a string.
      const [, open, id, next] = m as unknown as [string, string, string, string];
      if (id === "") continue;
      const rest = text.slice(m.index + m[0].length);
      const closedHere = next === open && !/^\s*\+/.test(rest);
      const prefix = !closedHere && (QUOTES.includes(next) || next === "$" || next === "+");
      // An exact definition wins over a prefix of the same text.
      ids.set(id, (ids.get(id) ?? true) && prefix);
    }
  const pages = new Set<string>();
  for (const pattern of PAGE_PATTERNS)
    for (const m of text.matchAll(pattern)) if (m[1] && m[1] !== "/") pages.add(m[1]);
  return { ids: [...ids].map(([id, prefix]) => ({ id, prefix })), pages: [...pages] };
}

/**
 * The inventory of a set of source files (REQ-PLAN-09/AC7); paths in `exclude` (the API's own paths from its
 * OpenAPI document) are not pages.
 */
export function buildUiInventory(
  files: readonly { readonly path: string; readonly text: string }[],
  exclude: readonly string[] = [],
): UiInventory {
  const selectors = new Map<string, { prefix: boolean; files: Set<string> }>();
  const pages = new Set<string>();
  for (const file of files) {
    const found = scanUiSource(file.text);
    for (const { id, prefix } of found.ids) {
      const entry = selectors.get(id) ?? { prefix, files: new Set<string>() };
      entry.prefix = entry.prefix && prefix;
      entry.files.add(file.path);
      selectors.set(id, entry);
    }
    for (const page of found.pages) if (!exclude.includes(page)) pages.add(page);
  }
  return {
    selectors: [...selectors]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, e]) => ({ selector: `testid:${id}`, prefix: e.prefix, files: [...e.files].sort() })),
    pages: [...pages].sort(),
  };
}

/** Whether a `testid:` selector names an element of the inventory (exactly, or by a known prefix). */
export function selectorKnown(inventory: UiInventory, selector: string): boolean {
  return inventory.selectors.some((e) =>
    e.prefix
      ? selector.startsWith(e.selector) && selector.length > e.selector.length
      : selector === e.selector,
  );
}

/** The inventory as a prompt section for the planner and the author (REQ-PLAN-09/AC7). */
export function renderUiInventory(inventory: UiInventory, limit = 300): string {
  if (inventory.selectors.length === 0 && inventory.pages.length === 0) return "";
  const lines = inventory.selectors
    .slice(0, limit)
    .map(
      (e) =>
        `- ${e.selector}${e.prefix ? "<rest> (built at run time, e.g. " + e.selector + "1)" : ""} in ${e.files.join(", ")}`,
    );
  return [
    "## Elements and pages in the code (computed by QAJitsu from the code under test)",
    "Use these element ids and page paths in steps and expectations instead of inventing any. This list is not a source: never cite it or its pages as a source of a case, screen or risk.",
    ...(inventory.pages.length > 0 ? [`Pages: ${inventory.pages.join(", ")}`] : []),
    ...lines,
    ...(inventory.selectors.length > limit
      ? [`(${String(inventory.selectors.length - limit)} more not listed)`]
      : []),
  ].join("\n");
}
