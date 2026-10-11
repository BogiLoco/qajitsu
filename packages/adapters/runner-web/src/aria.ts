import type { UiElementFact } from "@qajitsu/core";

/** Roles that only group other elements; they become elements when they carry a name or text of their own. */
const STRUCTURE = new Set([
  "navigation",
  "list",
  "main",
  "banner",
  "contentinfo",
  "region",
  "group",
  "generic",
  "form",
  "table",
  "rowgroup",
  "row",
  "document",
]);

/** `- role "name" [attrs]: text`, the line format of Playwright's `ariaSnapshot()`. */
const LINE = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::\s*(.*))?$/;

/**
 * The elements of a page from Playwright's accessibility snapshot (REQ-EXEC-22/AC1). Roles and names are the ones
 * `role:<role>:<name>` selectors resolve, because Playwright computes both.
 *
 * @param yaml - The output of `locator("body").ariaSnapshot()`.
 */
export function ariaElements(yaml: string): UiElementFact[] {
  const elements: UiElementFact[] = [];
  for (const line of yaml.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, role = "", quoted, attrs = "", rest] = m;
    const name = quoted?.replace(/\\(.)/g, "$1");
    const text = rest?.trim() ? rest.trim() : undefined;
    if (STRUCTURE.has(role) && name === undefined && text === undefined) continue;
    elements.push({
      role,
      ...(name !== undefined ? { name } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(attrs.includes("[checked]") ? { checked: true } : {}),
      ...(attrs.includes("[disabled]") ? { disabled: true } : {}),
    });
  }
  return elements;
}
