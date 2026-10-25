import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/board");
    await ui.hover("testid:card-1");
    verify(
      "S1",
      "elements.testid:card-1-details.visible",
      undefined,
      plan.expect("TC-02.S1.elements.testid:card-1-details.visible"),
    );
  });
}
