import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-03";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/board");
    await ui.scrollUntil("testid:history-H-50");
    verify(
      "S1",
      "elements.testid:history-H-50.visible",
      undefined,
      plan.expect("TC-03.S1.elements.testid:history-H-50.visible"),
    );
    verify(
      "S1",
      "elements.testid:history-H-50.in_viewport",
      undefined,
      plan.expect("TC-03.S1.elements.testid:history-H-50.in_viewport"),
    );
  });
}
