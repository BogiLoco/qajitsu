import type { UiScreen } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { buildUiInventory } from "./ui-inventory.js";
import {
  closestSelectors,
  renderUiSnapshot,
  selectorsFor,
  snapshotSelectors,
  unknownSelectors,
} from "./ui-snapshot.js";
import { specSelectors } from "./spec-checks.js";

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

  it("REQ-EXEC-22/AC3: selectors of a spec: ui actions and element checks", () => {
    const spec = [
      'await ui.goto("/app/checkout");',
      'await ui.click("testid:place-order");',
      'await ui.fill("label:Username", "x");',
      'await ui.waitFor("role:heading:Checkout", "visible");',
      'verify("S1", "elements.text:Total 24,99 zł.text", undefined, plan.expect("TC-01.S1.elements.text:Total 24,99 zł.text"));',
      'verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));',
      "await other.click(x);",
    ].join("\n");
    expect(specSelectors(spec)).toEqual([
      "testid:place-order",
      "label:Username",
      "role:heading:Checkout",
      "text:Total 24,99 zł",
    ]);
  });

  it("REQ-EXEC-22/AC3: a selector is unknown when no recorded element and no element id in the code matches it", () => {
    const inventory = buildUiInventory([{ path: "web.html", text: '<b data-testid="toast">' }]);
    const screens = [checkout, app];
    const web = (selectors: string[]) => unknownSelectors(selectors, "web", { screens, inventory });
    expect(
      web([
        "testid:place-order",
        "testid:toast",
        "role:button:Place order",
        "role:heading",
        "text:Total 24,99 zł",
        "label:I accept the terms",
        "css:#x",
        "xpath://a",
        "testid:nav-checkout",
        "role:button:Pay",
        "text:Nope",
      ]),
    ).toEqual(["testid:nav-checkout", "role:button:Pay", "text:Nope"]);
    expect(
      unknownSelectors(["testid:cart-count", "label:cart-count", "testid:place-order"], "mobile", {
        screens,
      }),
    ).toEqual(["testid:place-order"]);
    // Nothing recorded for the platform: nothing can be judged.
    expect(unknownSelectors(["testid:x"], "mobile", { screens: [checkout] })).toEqual([]);
    expect(unknownSelectors(["testid:x"], "api", { screens })).toEqual([]);
  });
});
