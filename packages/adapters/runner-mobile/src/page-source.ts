import type { UiElementFact } from "@qajitsu/core";

const decode = (v: string): string =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The attributes of one XML start tag. */
const attributes = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/\s([\w:-]+)="([^"]*)"/g))
    if (m[1] !== undefined) out[m[1]] = decode(m[2] ?? "");
  return out;
};

/** An attribute value, or undefined when it is missing or empty. */
const value = (v: string | undefined): string | undefined => (v === undefined || v === "" ? undefined : v);

/**
 * The elements of a native screen from its Appium page source (REQ-EXEC-22/AC1): every visible element with an
 * accessibility id, a resource id or a text. The accessibility id is what `testid:` finds (`~id` in Appium).
 *
 * @param xml - `getPageSource()` of UiAutomator2 (Android) or XCUITest (iOS).
 * @param platform - Which driver produced it.
 */
export function pageSourceElements(xml: string, platform: "android" | "ios"): UiElementFact[] {
  const elements: UiElementFact[] = [];
  for (const m of xml.matchAll(/<([A-Za-z][\w.]*)(\s[^>]*?)?\/?>/g)) {
    const a = attributes(m[2] ?? "");
    if (platform === "android") {
      const kind = a["class"] ?? m[1] ?? "";
      if (kind === "hierarchy" || a["displayed"] === "false") continue;
      const testid = value(a["content-desc"]);
      const resourceId = value(a["resource-id"])?.replace(/^.*:id\//, "");
      const text = value(a["text"]);
      if (!testid && !resourceId && !text) continue;
      elements.push({
        role: kind.split(".").at(-1),
        ...(testid ? { testid } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(text ? { text } : {}),
        ...(a["enabled"] === "false" ? { disabled: true } : {}),
        ...(a["checked"] === "true" ? { checked: true } : {}),
      });
    } else {
      if (a["type"] === undefined || a["visible"] === "false") continue;
      const testid = value(a["name"]);
      const text = value(a["label"]) ?? value(a["value"]);
      if (!testid && !text) continue;
      elements.push({
        role: a["type"].replace(/^XCUIElementType/, ""),
        ...(testid ? { testid } : {}),
        ...(text ? { text } : {}),
        ...(a["enabled"] === "false" ? { disabled: true } : {}),
        ...(a["value"] === "1" && /Switch|CheckBox/.test(a["type"]) ? { checked: true } : {}),
      });
    }
  }
  return elements;
}
