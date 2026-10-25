// INV-4, REQ-EXEC-09: a healer that "fixes" a failing spec may change selectors and waits only. Each attempt below
// changes what the test does instead, so a defect would stop being observed; the assertion lock must refuse every one.
import { readFileSync } from "node:fs";
import { assertionLockDiff } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";

const spec = (ticket: string, id: string) =>
  readFileSync(
    new URL(`../../fixtures/specs/${ticket.toLowerCase()}/${id}.spec.ts`, import.meta.url),
    "utf8",
  );

describe("a lying healer (INV-4, REQ-EXEC-09)", () => {
  const api = spec("DEMO-1", "TC-01");
  const web = spec("DEMO-8", "TC-01");
  const upload = spec("DEMO-7", "TC-01");

  it.each([
    ["changes the request body of an API call", api, api.replace("quantity: 3", "quantity: 1")],
    ["calls another endpoint", api, api.replace('shopper.get("/cart")', 'shopper.get("/cart?fixed=1")')],
    ["types another card number", web, web.replace('"4111111111111111"', '"4000000000000002"')],
    ["uploads another file of the plan", upload, upload.replace('"avatar"', '"other"')],
    ["drops an action", web, web.replace('    await ui.click("testid:confirm-3ds");\n', "")],
    [
      "skips a step's action behind a condition",
      web,
      web.replace(
        'await ui.click("testid:confirm-3ds");',
        'if (Math.PI > 4) await ui.click("testid:confirm-3ds");',
      ),
    ],
    ["returns early", web, web.replace('  await step("S2"', '  return;\n  await step("S2"')],
  ])("refuses a healer that %s", (_, before, after) => {
    expect(after).not.toBe(before);
    expect(assertionLockDiff(before, after).map((p) => p.check)).toContain("assertion-lock");
  });

  it("REQ-EXEC-39/AC4: accepts a healer that only changes selectors (frames included) and adds waits or scrolling into view", () => {
    const healed = web
      .replace('"frame:title:Payment >> testid:pay"', '"frame:title:Payment >> role:button:Pay"')
      .replace(
        'await ui.click("testid:confirm-3ds");',
        'await ui.waitFor("role:button:Confirm");\n    await ui.scrollTo("role:button:Confirm");\n    await ui.click("role:button:Confirm");',
      );
    expect(assertionLockDiff(web, healed)).toEqual([]);
  });
});
