import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.click("testid:add-item");
    verify(
      "S1",
      "elements.testid:cart-count.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:cart-count.text"),
    );
  });
  await step("S2", async () => {
    await ui.click("testid:open-checkout");
    await ui.waitFor("testid:checkout-title");
    verify(
      "S2",
      "elements.testid:checkout-title.visible",
      undefined,
      plan.expect("TC-01.S2.elements.testid:checkout-title.visible"),
    );
  });
  await step("S3", async () => {
    await ui.back();
    await ui.waitFor("testid:cart-count");
    verify(
      "S3",
      "elements.testid:cart-count.text",
      undefined,
      plan.expect("TC-01.S3.elements.testid:cart-count.text"),
    );
  });
}
