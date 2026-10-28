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
      platforms: ["web"],
      files: ["api/web.mjs"],
    });
    expect(byId["testid:accept-terms"]?.prefix).toBe(false);
    expect(byId["testid:price-"]?.prefix).toBe(true);
    expect(byId["testid:product-"]?.prefix).toBe(true);
    expect(byId["testid:cart-count"]?.files).toEqual(["android/src/dev/qajitsu/demoshop/CartActivity.java"]);
    expect(byId["testid:cart-count"]?.platforms).toEqual(["android"]);
    // The demo shop's pages, the web gaps' pages included (REQ-EXEC-38..40, REQ-EXEC-56).
    expect(inventory.pages).toEqual([
      "/app/account",
      "/app/addresses",
      "/app/board",
      "/app/cart",
      "/app/chat",
      "/app/checkout",
      "/app/login",
      "/app/messages",
      "/app/notes",
      "/app/offer",
      "/app/pay",
      "/app/products",
      "/app/profile",
      "/app/reviews",
      "/app/signin",
    ]);
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
    expect(scanUiSource(source).ids.map((e) => ({ id: e.id, prefix: e.prefix }))).toEqual([{ id, prefix }]);
  });

  it.each([
    ['<button data-testid="pay">', ["web"]],
    ['el.dataset.testid = "line";', ["web"]],
    ['<View testID="login" />', ["android", "ios"]],
    ['Modifier.testTag("submit")', ["android"]],
    ['<Button android:contentDescription="ok"/>', ["android"]],
    ['view.setContentDescription("item")', ["android"]],
    ['button.accessibilityIdentifier = "buy"', ["ios"]],
    ['Button("Buy").accessibilityIdentifier("buy-now")', ["ios"]],
    ['<Button android:id="@+id/add_item" />', ["android"]],
    ["Semantics(identifier: 'cart-total', child: x)", ["android", "ios"]],
    ["ElevatedButton(key: Key('pay'), onPressed: f)", ["android", "ios"]],
    ['ListTile(key: const ValueKey("row-" + id))', ["android", "ios"]],
  ])("REQ-PLAN-09/AC8 + REQ-EXEC-21/AC4: %s is an id of %j", (source, platforms) => {
    expect(scanUiSource(source).ids[0]?.platforms).toEqual(platforms);
  });

  it("REQ-PLAN-09/AC8: an id is known only on the platforms that define it", () => {
    const inventory = buildUiInventory([
      { path: "web.html", text: '<a data-testid="nav-checkout"><b data-testid="cart">' },
      {
        path: "Cart.java",
        text: 'v.setContentDescription("open-checkout"); w.setContentDescription("cart");',
      },
    ]);
    expect(inventory.selectors.find((s) => s.selector === "testid:cart")?.platforms).toEqual([
      "android",
      "web",
    ]);
    expect(selectorKnown(inventory, "testid:nav-checkout", ["web"])).toBe(true);
    expect(selectorKnown(inventory, "testid:nav-checkout", ["android", "ios"])).toBe(false);
    expect(selectorKnown(inventory, "testid:open-checkout", ["android", "ios"])).toBe(true);
    expect(selectorKnown(inventory, "testid:open-checkout", ["web"])).toBe(false);
    expect(selectorKnown(inventory, "testid:cart", ["ios"])).toBe(false);
    expect(renderUiInventory(inventory)).toContain("- testid:nav-checkout (web) in web.html");
    expect(renderUiInventory(inventory)).toContain("- testid:cart (android, web) in Cart.java, web.html");
  });

  it("REQ-PLAN-09/AC7: pages come from links, routers and page maps, assets excluded; an exact id wins over a prefix", () => {
    const found = scanUiSource(
      [
        '<a href="/orders">',
        "{ path: '/orders/:id', component: Order }",
        '<Route path="/settings" element={x} />',
        'const PAGES = { "/help": [1] };',
        '<a href="/">',
        '<link rel="manifest" href="/manifest.webmanifest">',
        'const ASSETS = { "/sw.js": [1] };',
        '<b data-testid="x-">',
        "<b data-testid=\"x-'+n+'\">",
      ].join("\n"),
    );
    expect(found.pages).toEqual(["/orders", "/orders/:id", "/settings", "/help"]);
    expect(found.ids).toEqual([{ id: "x-", prefix: false, platforms: ["web"] }]);
    // An empty id defines nothing; an id defined as a prefix in one file and exactly in another is exact.
    expect(scanUiSource('<b data-testid="">').ids).toEqual([]);
    const merged = buildUiInventory([
      { path: "a.js", text: 'el.dataset.testid = "row-" + n;' },
      { path: "b.html", text: '<b data-testid="row-">' },
    ]);
    expect(merged.selectors).toEqual([
      { selector: "testid:row-", prefix: false, platforms: ["web"], files: ["a.js", "b.html"] },
    ]);
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
    expect(many).toContain("- testid:a (web) in a.html");
    expect(many).toContain("(1 more not listed)");
  });

  it("REQ-EXEC-21/AC1+AC4: the project's test id attribute is found instead of data-testid", () => {
    const html = '<button data-qa="pay">Pay</button><i data-testid="old"></i><b data-qa={`row-${n}`}></b>';
    expect(scanUiSource(html, "data-qa").ids).toEqual([
      { id: "pay", prefix: false, platforms: ["web"] },
      { id: "row-", prefix: true, platforms: ["web"] },
    ]);
    expect(
      buildUiInventory([{ path: "a.html", text: html }], [], { testIdAttribute: "data-qa" }).selectors.map(
        (s) => s.selector,
      ),
    ).toEqual(["testid:pay", "testid:row-"]);
  });
});
