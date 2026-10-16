/** Where an element id can be addressed: web pages, or the native app on Android or iOS. */
export type UiPlatform = "web" | "android" | "ios";

/** Every platform, in the order the inventory lists them. */
const PLATFORMS: readonly UiPlatform[] = ["android", "ios", "web"];

/** One element id found in the code, as the selector `testid:<id>` refers to it (REQ-PLAN-09/AC7). */
export interface UiSelectorEntry {
  /** `testid:<id>`; for a prefix the part before the generated rest, e.g. `testid:price-`. */
  readonly selector: string;
  /** The id is built at run time from this prefix (`"price-" + p.id`); `testid:price-P-2` matches it. */
  readonly prefix: boolean;
  /** Platforms whose code defines it (REQ-PLAN-09/AC8): a web id cannot be tapped in the native app. */
  readonly platforms: readonly UiPlatform[];
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

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Patterns that define an element id the runners address with `testid:`, with the platforms where it applies:
 * the project's test id attribute and its `dataset` property (web; `data-testid` by default, REQ-EXEC-21/AC1),
 * `testID` (React Native), Android accessibility ids (`setContentDescription`, `android:contentDescription`, Compose
 * `testTag`) and resource ids (`android:id="@+id/..."`, which `testid:` also finds), iOS identifiers
 * (`accessibilityIdentifier`, SwiftUI `.accessibilityIdentifier(...)`) and Flutter `Semantics(identifier:)`, `Key` and
 * `ValueKey` (REQ-EXEC-21/AC4). Group 1 is the opening quote, group 2 the id, group 3 what follows it.
 */
const idPatterns = (
  testIdAttribute: string,
): readonly { readonly pattern: RegExp; readonly platforms: readonly UiPlatform[] }[] => {
  const dataset = testIdAttribute.startsWith("data-")
    ? testIdAttribute.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    : undefined;
  return [
    {
      pattern: new RegExp(`${escapeRegex(testIdAttribute)}\\s*=\\s*\\{?\\s*(["'\`])([^"'\`$\\s{}]*)(.)`, "g"),
      platforms: ["web"],
    },
    ...(dataset
      ? [
          {
            pattern: new RegExp(`dataset\\.${escapeRegex(dataset)}\\s*=\\s*(["'\`])([^"'\`$\\s]*)(.)`, "g"),
            platforms: ["web"] as const,
          },
        ]
      : []),
    { pattern: /\btestID\s*=\s*\{?\s*(["'`])([^"'`$\s{}]*)(.)/g, platforms: ["android", "ios"] },
    { pattern: /(?:setContentDescription|testTag)\(\s*(["'`])([^"'`$\s]*)(.)/g, platforms: ["android"] },
    { pattern: /android:contentDescription\s*=\s*(")([^"@\s]*)(.)/g, platforms: ["android"] },
    { pattern: /android:id\s*=\s*(")@\+id\/([\w.]+)(.)/g, platforms: ["android"] },
    { pattern: /accessibilityIdentifier\s*=\s*(["'`])([^"'`$\s]*)(.)/g, platforms: ["ios"] },
    { pattern: /\.accessibilityIdentifier\(\s*(")([^"\\\s]*)(.)/g, platforms: ["ios"] },
    { pattern: /Semantics\([^)]*?\bidentifier:\s*(["'])([^"'$\s]*)(.)/g, platforms: ["android", "ios"] },
    { pattern: /\b(?:Value)?Key\(\s*(["'])([^"'$\s]*)(.)/g, platforms: ["android", "ios"] },
  ];
};

const union = (a: readonly UiPlatform[], b: readonly UiPlatform[]): UiPlatform[] =>
  PLATFORMS.filter((p) => a.includes(p) || b.includes(p));

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
 *
 * @param text - Source text of one file.
 * @param testIdAttribute - Attribute of web test ids (REQ-EXEC-21/AC1).
 */
export function scanUiSource(
  text: string,
  testIdAttribute = "data-testid",
): {
  readonly ids: readonly {
    readonly id: string;
    readonly prefix: boolean;
    readonly platforms: readonly UiPlatform[];
  }[];
  readonly pages: readonly string[];
} {
  const ids = new Map<string, { prefix: boolean; platforms: UiPlatform[] }>();
  for (const { pattern, platforms } of idPatterns(testIdAttribute))
    for (const m of text.matchAll(pattern)) {
      // Every pattern has exactly these three groups, so each one is a string.
      const [, open, id, next] = m as unknown as [string, string, string, string];
      if (id === "") continue;
      const rest = text.slice(m.index + m[0].length);
      const closedHere = next === open && !/^\s*\+/.test(rest);
      const prefix = !closedHere && (QUOTES.includes(next) || next === "$" || next === "+");
      // An exact definition wins over a prefix of the same text.
      const known = ids.get(id);
      ids.set(id, {
        prefix: (known?.prefix ?? true) && prefix,
        platforms: union(known?.platforms ?? [], platforms),
      });
    }
  const pages = new Set<string>();
  for (const pattern of PAGE_PATTERNS)
    for (const m of text.matchAll(pattern)) if (m[1] && m[1] !== "/") pages.add(m[1]);
  return { ids: [...ids].map(([id, e]) => ({ id, ...e })), pages: [...pages] };
}

/**
 * The inventory of a set of source files (REQ-PLAN-09/AC7); paths in `exclude` (the API's own paths from its
 * OpenAPI document) are not pages.
 */
export function buildUiInventory(
  files: readonly { readonly path: string; readonly text: string }[],
  exclude: readonly string[] = [],
  options: { readonly testIdAttribute?: string | undefined } = {},
): UiInventory {
  const selectors = new Map<string, { prefix: boolean; platforms: UiPlatform[]; files: Set<string> }>();
  const pages = new Set<string>();
  for (const file of files) {
    const found = scanUiSource(file.text, options.testIdAttribute);
    for (const { id, prefix, platforms } of found.ids) {
      const entry = selectors.get(id) ?? { prefix, platforms: [], files: new Set<string>() };
      entry.prefix = entry.prefix && prefix;
      entry.platforms = union(entry.platforms, platforms);
      entry.files.add(file.path);
      selectors.set(id, entry);
    }
    for (const page of found.pages) if (!exclude.includes(page)) pages.add(page);
  }
  return {
    selectors: [...selectors]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, e]) => ({
        selector: `testid:${id}`,
        prefix: e.prefix,
        platforms: e.platforms,
        files: [...e.files].sort(),
      })),
    pages: [...pages].sort(),
  };
}

/**
 * Whether a `testid:` selector names an element of the inventory (exactly, or by a known prefix).
 *
 * @param platforms - Only ids defined for one of these platforms count; every platform when omitted.
 */
export function selectorKnown(
  inventory: UiInventory,
  selector: string,
  platforms: readonly UiPlatform[] = PLATFORMS,
): boolean {
  return inventory.selectors.some((e) =>
    !e.platforms.some((p) => platforms.includes(p))
      ? false
      : e.prefix
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
        `- ${e.selector}${e.prefix ? "<rest> (built at run time, e.g. " + e.selector + "1)" : ""} (${e.platforms.join(", ")}) in ${e.files.join(", ")}`,
    );
  return [
    "## Elements and pages in the code (computed by QAJitsu from the code under test)",
    "Use these element ids and page paths in steps and expectations instead of inventing any; a case uses only ids of its own platform (web pages for web cases, android or ios for mobile cases). This list is not a source: never cite it or its pages as a source of a case, screen or risk.",
    ...(inventory.pages.length > 0 ? [`Pages: ${inventory.pages.join(", ")}`] : []),
    ...lines,
    ...(inventory.selectors.length > limit
      ? [`(${String(inventory.selectors.length - limit)} more not listed)`]
      : []),
  ].join("\n");
}
