import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildUiInventory, renderUiInventory, scanUiSource, selectorKnown } from "./ui-inventory.js";

const demo = (path: string) =>
  readFileSync(new URL(`../../../examples/demo-shop/${path}`, import.meta.url), "utf8");

describe("element and page inventory (REQ-PLAN-09/AC7)", () => {
  it("REQ-PLAN-09/AC7: finds the demo shop's element ids and pages, exact and built at run time", () => {
    const inventory = buildUiInventory(
      [
        { path: "api/web.mjs", text: demo("api/web.mjs") },
        {
          path: "android/src/dev/qajitsu/demoshop/CartActivity.java",
          text: demo("android/src/dev/qajitsu/demoshop/CartActivity.java"),
        },
      ],
      ["/checkout", "/products"],
    );
    const byId = Object.fromEntries(inventory.selectors.map((s) => [s.selector, s]));
    expect(byId["testid:place-order"]).toEqual({
      selector: "testid:place-order",
      prefix: false,
      files: ["api/web.mjs"],
    });
    expect(byId["testid:accept-terms"]?.prefix).toBe(false);
    expect(byId["testid:price-"]?.prefix).toBe(true);
    expect(byId["testid:product-"]?.prefix).toBe(true);
    expect(byId["testid:cart-count"]?.files).toEqual(["android/src/dev/qajitsu/demoshop/CartActivity.java"]);
    expect(inventory.pages).toEqual(["/app/cart", "/app/checkout", "/app/login", "/app/products"]);
    expect(selectorKnown(inventory, "testid:place-order")).toBe(true);
    expect(selectorKnown(inventory, "testid:price-P-2")).toBe(true);
    expect(selectorKnown(inventory, "testid:price-")).toBe(false);
    expect(selectorKnown(inventory, "testid:Price_Item1")).toBe(false);
    expect(selectorKnown(inventory, "testid:place")).toBe(false);
  });

  it.each([
    ['<button data-testid="pay">', "pay", false],
    ["<li data-testid={`row-${id}`}>", "row-", true],
    ['<View testID="login" />', "login", false],
    ['el.dataset.testid = "line-" + id;', "line-", true],
    ['el.dataset.testid = "line";', "line", false],
    ['Modifier.testTag("submit")', "submit", false],
    ['button.accessibilityIdentifier = "buy"', "buy", false],
    ['<Button android:contentDescription="ok"/>', "ok", false],
    ["view.setContentDescription('item-' + i)", "item-", true],
  ])("REQ-PLAN-09/AC7: %s defines %s (prefix %s)", (source, id, prefix) => {
    expect(scanUiSource(source).ids).toEqual([{ id, prefix }]);
  });

  it("REQ-PLAN-09/AC7: pages come from links, routers and page maps; an exact id wins over a prefix", () => {
    const found = scanUiSource(
      [
        '<a href="/orders">',
        "{ path: '/orders/:id', component: Order }",
        '<Route path="/settings" element={x} />',
        'const PAGES = { "/help": [1] };',
        '<a href="/">',
        '<b data-testid="x-">',
        "<b data-testid=\"x-'+n+'\">",
      ].join("\n"),
    );
    expect(found.pages).toEqual(["/orders", "/orders/:id", "/settings", "/help"]);
    expect(found.ids).toEqual([{ id: "x-", prefix: false }]);
    // An empty id defines nothing; an id defined as a prefix in one file and exactly in another is exact.
    expect(scanUiSource('<b data-testid="">').ids).toEqual([]);
    const merged = buildUiInventory([
      { path: "a.js", text: 'el.dataset.testid = "row-" + n;' },
      { path: "b.html", text: '<b data-testid="row-">' },
    ]);
    expect(merged.selectors).toEqual([{ selector: "testid:row-", prefix: false, files: ["a.js", "b.html"] }]);
  });

  it("REQ-PLAN-09/AC7: the prompt section lists pages and elements; nothing found is no section", () => {
    const text = renderUiInventory(
      buildUiInventory([{ path: "a.html", text: '<a href="/x"><i data-testid="p-" + n>' }]),
      1,
    );
    expect(text).toContain("Pages: /x");
    expect(text).toContain("This list is not a source: never cite it");
    expect(renderUiInventory({ selectors: [], pages: [] })).toBe("");
    const many = renderUiInventory(
      buildUiInventory([{ path: "a.html", text: '<i data-testid="a"><i data-testid="b">' }]),
      1,
    );
    expect(many).toContain("- testid:a in a.html");
    expect(many).toContain("(1 more not listed)");
  });
});
