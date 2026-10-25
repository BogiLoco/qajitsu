import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/offer");
    verify(
      "S1",
      "elements.testid:offer-status.text",
      undefined,
      plan.expect("TC-02.S1.elements.testid:offer-status.text"),
    );
  });
  await step("S2", async () => {
    await ui.advanceTime(180);
    verify(
      "S2",
      "elements.testid:offer-status.text",
      undefined,
      plan.expect("TC-02.S2.elements.testid:offer-status.text"),
    );
  });
}
