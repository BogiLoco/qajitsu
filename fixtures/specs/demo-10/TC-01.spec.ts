import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/addresses");
    await ui.click("testid:delete-1");
    verify("S1", "dialog.type", undefined, plan.expect("TC-01.S1.dialog.type"));
    verify("S1", "dialog.message", undefined, plan.expect("TC-01.S1.dialog.message"));
    verify(
      "S1",
      "elements.testid:address-count.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:address-count.text"),
    );
  });
  await step("S2", async () => {
    await ui.click("testid:delete-1");
    verify(
      "S2",
      "elements.testid:address-count.text",
      undefined,
      plan.expect("TC-01.S2.elements.testid:address-count.text"),
    );
  });
}
