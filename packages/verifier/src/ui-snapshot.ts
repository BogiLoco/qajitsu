import type { UiElementFact, UiScreen } from "@qajitsu/core";
import { selectorKnown, type UiInventory, type UiPlatform } from "./ui-inventory.js";

/** Web roles a `role:<role>:<name>` selector is worth for: elements a test acts on or checks. */
const WEB_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "spinbutton",
  "combobox",
  "listbox",
  "option",
  "slider",
  "tab",
  "menuitem",
  "heading",
  "img",
  "dialog",
  "alert",
  "status",
  "cell",
]);

/**
 * The selectors the runners resolve for an element, the most stable first (REQ-EXEC-22/AC1): the test id, then the
 * accessible role and name (web), then the visible text. An element with none of them gets none.
 *
 * @param element - One recorded element.
 * @param platform - Where it was recorded.
 */
export function selectorsFor(element: UiElementFact, platform: UiPlatform): string[] {
  const out: string[] = [];
  if (element.testid) out.push(`testid:${element.testid}`);
  if (platform === "web" && element.role && element.name && WEB_ROLES.has(element.role))
    out.push(`role:${element.role}:${element.name}`);
  const text = element.text ?? (platform === "web" ? undefined : element.name);
  if (text && text.length <= 80) out.push(`text:${text}`);
  return out;
}

const describe = (e: UiElementFact): string =>
  [
    e.role ?? "element",
    e.name !== undefined ? JSON.stringify(e.name) : e.text !== undefined ? JSON.stringify(e.text) : "",
    e.disabled ? "[disabled]" : "",
    e.checked ? "[checked]" : "",
  ]
    .filter((p) => p !== "")
    .join(" ");

/**
 * The snapshot as a prompt section for the planner, the author and the healer (REQ-EXEC-22/AC1+AC2): per page or
 * screen, each element with its best selector, what it is, and other selectors for it. The caller masks the screens
 * and wraps the section as untrusted data.
 *
 * @param screens - Recorded pages and screens.
 * @param limit - Elements listed per screen.
 */
export function renderUiSnapshot(screens: readonly UiScreen[], limit = 80): string {
  if (screens.length === 0) return "";
  const parts = [
    "## What the application shows (recorded by QAJitsu on the run's environment)",
    "Selectors below are the ones that find each element now; prefer the first one of a line. Elements that appear only after an action are not listed.",
  ];
  for (const screen of screens) {
    parts.push(`### ${screen.platform} ${screen.where}${screen.account ? ` (as ${screen.account})` : ""}`);
    const lines = [
      ...new Set(
        screen.elements.flatMap((e) => {
          const [first, ...more] = selectorsFor(e, screen.platform);
          if (first === undefined) return [];
          return [`- ${first}: ${describe(e)}${more.length > 0 ? `; also ${more.join(", ")}` : ""}`];
        }),
      ),
    ];
    if (lines.length === 0) parts.push("(no elements found)");
    parts.push(...lines.slice(0, limit));
    if (lines.length > limit) parts.push(`(${String(lines.length - limit)} more elements not listed)`);
  }
  return parts.join("\n");
}

/** Every selector of the screens of these platforms (REQ-EXEC-22/AC3). */
export function snapshotSelectors(
  screens: readonly UiScreen[],
  platforms: readonly UiPlatform[],
): Set<string> {
  return new Set(
    screens
      .filter((s) => platforms.includes(s.platform))
      .flatMap((s) => s.elements.flatMap((e) => selectorsFor(e, s.platform))),
  );
}

/** Edit distance of two strings. */
const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1)
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length] ?? 0;
};

/**
 * The known selectors closest to one that matched nothing (REQ-EXEC-22/AC3), for the message back to the author.
 *
 * @param selector - The selector the author wrote.
 * @param known - Selectors of the snapshot.
 * @param n - How many to return.
 */
export function closestSelectors(selector: string, known: ReadonlySet<string>, n = 3): string[] {
  return [...known]
    .map((k) => ({ k, d: distance(selector.toLowerCase(), k.toLowerCase()) }))
    .sort((x, y) => x.d - y.d || x.k.localeCompare(y.k))
    .slice(0, n)
    .map((x) => x.k);
}

/** Platforms of a plan case type; API cases have no screen. */
const PLATFORMS_OF: Readonly<Record<string, readonly UiPlatform[]>> = {
  web: ["web"],
  mobile: ["android", "ios"],
};

/**
 * Selectors of a spec that match no recorded element of the case's platform and no element id of the code
 * (REQ-EXEC-22/AC3). `css:` and `xpath:` selectors cannot be judged; nothing is judged without a recorded screen of the
 * platform. Elements that appear only after an action may be unknown, so the caller asks the author once, it does not
 * reject the spec.
 *
 * @param selectors - Selectors of the spec ({@link specSelectors}).
 * @param caseType - The plan case type.
 * @param known - Recorded screens and, when the code is available, its element inventory.
 */
export function unknownSelectors(
  selectors: readonly string[],
  caseType: string,
  known: { readonly screens: readonly UiScreen[]; readonly inventory?: UiInventory | undefined },
): string[] {
  const platforms = PLATFORMS_OF[caseType];
  if (platforms === undefined) return [];
  const screens = known.screens.filter((s) => platforms.includes(s.platform));
  if (screens.length === 0) return [];
  const elements = screens.flatMap((s) => s.elements);
  const recorded = snapshotSelectors(screens, platforms);
  const seen = (selector: string): boolean => {
    const colon = selector.indexOf(":");
    const kind = selector.slice(0, colon);
    const rest = selector.slice(colon + 1);
    switch (kind) {
      case "testid":
        return (
          recorded.has(selector) ||
          (known.inventory !== undefined && selectorKnown(known.inventory, selector, platforms))
        );
      case "role": {
        const [role, ...name] = rest.split(":");
        return elements.some((e) => e.role === role && (name.length === 0 || e.name === name.join(":")));
      }
      case "text":
      case "label":
        return elements.some(
          (e) => e.text === rest || e.name === rest || (platforms[0] !== "web" && e.testid === rest),
        );
      default:
        return true;
    }
  };
  return [...new Set(selectors)].filter((s) => !seen(s));
}
