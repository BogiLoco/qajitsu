import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.as("user:standard");
    await ui.goto("/app/checkout");
    verify(
      "S1",
      "elements.testid:place-order.enabled",
      undefined,
      plan.expect("TC-01.S1.elements.testid:place-order.enabled"),
    );
  });
  await step("S2", async () => {
    await ui.check("testid:accept-terms");
    verify(
      "S2",
      "elements.testid:place-order.enabled",
      undefined,
      plan.expect("TC-01.S2.elements.testid:place-order.enabled"),
    );
  });
}
