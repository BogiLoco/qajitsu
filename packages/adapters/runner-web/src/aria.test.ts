import { describe, expect, it } from "vitest";
import { ariaElements } from "./aria.js";

describe("elements from Playwright's accessibility snapshot (REQ-EXEC-22/AC1)", () => {
  it("REQ-EXEC-22/AC1: reads roles, names, texts and states; skips structure without a name", () => {
    const yaml = [
      "- navigation:",
      '  - link "Products":',
      "    - /url: /app/products",
      '  - link "Cart (1)":',
      "    - /url: /app/cart",
      '- heading "Checkout" [level=1]',
      "- text: Total 24,99 zł",
      '- checkbox "I accept the terms" [checked]',
      '- button "Place order" [disabled]',
      '- textbox "Username"',
      '- textbox "Quote \\"x\\""',
      "- list:",
      "  - listitem: Mug",
      '- img "Logo"',
      "- paragraph: Free shipping",
      "- button [disabled]",
    ].join("\n");
    expect(ariaElements(yaml)).toEqual([
      { role: "link", name: "Products" },
      { role: "link", name: "Cart (1)" },
      { role: "heading", name: "Checkout" },
      { role: "text", text: "Total 24,99 zł" },
      { role: "checkbox", name: "I accept the terms", checked: true },
      { role: "button", name: "Place order", disabled: true },
      { role: "textbox", name: "Username" },
      { role: "textbox", name: 'Quote "x"' },
      { role: "listitem", text: "Mug" },
      { role: "img", name: "Logo" },
      { role: "paragraph", text: "Free shipping" },
      { role: "button", disabled: true },
    ]);
  });

  it("REQ-EXEC-22/AC2: an empty or broken snapshot gives no elements", () => {
    expect(ariaElements("")).toEqual([]);
    expect(ariaElements("not yaml at all\n  - /url: x")).toEqual([]);
  });
});
