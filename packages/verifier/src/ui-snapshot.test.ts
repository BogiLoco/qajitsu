import type { UiScreen } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { closestSelectors, renderUiSnapshot, selectorsFor, snapshotSelectors } from "./ui-snapshot.js";

const checkout: UiScreen = {
  where: "/app/checkout",
  platform: "web",
  account: "user:standard",
  elements: [
    { testid: "place-order", role: "button", text: "Place order", disabled: true },
    { role: "button", name: "Place order", disabled: true },
    { role: "checkbox", name: "I accept the terms" },
    { role: "heading", name: "Checkout" },
    { role: "text", text: "Total 24,99 zł" },
    { role: "navigation" },
    { role: "button", disabled: true },
  ],
};
const app: UiScreen = {
  where: "app:start",
  platform: "android",
  elements: [
    { role: "TextView", testid: "cart-count", text: "Cart: 0 items" },
    { role: "Button", resourceId: "pay", text: "Pay" },
    { role: "View" },
  ],
};

describe("snapshot of the running application (REQ-EXEC-22)", () => {
  it("REQ-EXEC-22/AC1: each element gets the selectors the runner resolves, most stable first", () => {
    expect(checkout.elements.map((e) => selectorsFor(e, "web"))).toEqual([
      ["testid:place-order", "text:Place order"],
      ["role:button:Place order"],
      ["role:checkbox:I accept the terms"],
      ["role:heading:Checkout"],
      ["text:Total 24,99 zł"],
      [],
      [],
    ]);
    expect(app.elements.map((e) => selectorsFor(e, "android"))).toEqual([
      ["testid:cart-count", "text:Cart: 0 items"],
      ["text:Pay"],
      [],
    ]);
  });

  it("REQ-EXEC-22/AC1+AC2: the prompt section lists each screen and its elements, limited in size", () => {
    const text = renderUiSnapshot([checkout, app]);
    expect(text).toContain("## What the application shows");
    expect(text).toContain("### web /app/checkout (as user:standard)");
    expect(text).toContain('- testid:place-order: button "Place order" [disabled]; also text:Place order');
    expect(text).toContain("- role:checkbox:I accept the terms");
    expect(text).toContain("### android app:start");
    expect(text).toContain('- testid:cart-count: TextView "Cart: 0 items"');
    expect(text).not.toContain("navigation");
    const small = renderUiSnapshot([checkout], 2);
    expect(small).toContain("(3 more elements not listed)");
    expect(renderUiSnapshot([])).toBe("");
    expect(renderUiSnapshot([{ where: "/x", platform: "web", elements: [] }])).toContain(
      "### web /x\n(no elements found)",
    );
  });

  it("REQ-EXEC-22/AC3: selectors known per platform and the closest ones to a selector that is not", () => {
    const web = snapshotSelectors([checkout, app], ["web"]);
    expect(web.has("testid:place-order")).toBe(true);
    expect(web.has("testid:cart-count")).toBe(false);
    expect(snapshotSelectors([checkout, app], ["android", "ios"]).has("text:Pay")).toBe(true);
    expect(closestSelectors("testid:place_order", web, 2)).toEqual([
      "testid:place-order",
      "text:Place order",
    ]);
    expect(closestSelectors("x", new Set(), 3)).toEqual([]);
  });
});
