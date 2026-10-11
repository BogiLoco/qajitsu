import { readFileSync } from "node:fs";
import { buildUiInventory } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";
import { AUDITOR_SYSTEM } from "./auditor.js";
import { AUTHOR_SYSTEM } from "./author.js";
import { BLOCKED_SYSTEM } from "./blocked.js";
import { EXPLORER_SYSTEM } from "./explorer.js";
import { HEALER_SYSTEM } from "./healer.js";
import { ANALYST_SYSTEM, PLANNER_SYSTEM } from "./prompts.js";
import { TRIAGE_SYSTEM } from "./triage.js";

const demo = (path: string) =>
  readFileSync(new URL(`../../../examples/demo-shop/${path}`, import.meta.url), "utf8");

describe("prompts work for any application (REQ-EXEC-21/AC5)", () => {
  const inventory = buildUiInventory([
    { path: "web.mjs", text: demo("api/web.mjs") },
    { path: "Cart.java", text: demo("android/src/dev/qajitsu/demoshop/CartActivity.java") },
    { path: "Checkout.java", text: demo("android/src/dev/qajitsu/demoshop/CheckoutActivity.java") },
  ]);
  const prompts = {
    ANALYST_SYSTEM,
    PLANNER_SYSTEM,
    AUTHOR_SYSTEM,
    HEALER_SYSTEM,
    EXPLORER_SYSTEM,
    AUDITOR_SYSTEM,
    TRIAGE_SYSTEM,
    BLOCKED_SYSTEM,
  };

  it.each(Object.entries(prompts))(
    "REQ-EXEC-21/AC5: %s names no element id or page of the demo application",
    (_, text) => {
      expect(inventory.selectors.length).toBeGreaterThan(10);
      for (const s of inventory.selectors) expect(text).not.toContain(s.selector);
      for (const page of inventory.pages) expect(text).not.toContain(page);
    },
  );

  it("REQ-EXEC-21/AC5: author and planner list the selector kinds, the most stable first", () => {
    for (const text of [AUTHOR_SYSTEM, PLANNER_SYSTEM]) {
      const order = ["testid:", "role:", "label:", "placeholder:", "alt:", "title:", "text:", "id:"].map(
        (k) => text.search(new RegExp(`(?<![a-z])${k}<`)),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
    expect(AUTHOR_SYSTEM).toContain("xpath:<path> (native app) only as the last");
  });

  it("REQ-VER-13/AC1: the BLOCKED hints know the approved plan is frozen", () => {
    expect(BLOCKED_SYSTEM).toContain("The approved plan of this run\nis frozen");
  });
});
