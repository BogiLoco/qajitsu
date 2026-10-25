import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/pay");
    await ui.fill("frame:title:Payment >> testid:card-number", "4111111111111111");
    await ui.click("frame:title:Payment >> testid:pay");
    await ui.switchToNewPage();
    verify(
      "S1",
      "elements.testid:confirm-3ds.visible",
      undefined,
      plan.expect("TC-01.S1.elements.testid:confirm-3ds.visible"),
    );
  });
  await step("S2", async () => {
    await ui.click("testid:confirm-3ds");
    await ui.closePage();
    await ui.waitFor("frame:title:Payment >> text:Confirmed");
    verify(
      "S2",
      "elements.testid:payment-status.text",
      undefined,
      plan.expect("TC-01.S2.elements.testid:payment-status.text"),
    );
    verify(
      "S2",
      "elements.frame:title:Payment >> testid:widget-status.text",
      undefined,
      plan.expect("TC-01.S2.elements.frame:title:Payment >> testid:widget-status.text"),
    );
  });
}
