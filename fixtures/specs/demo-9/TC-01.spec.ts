import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/board");
    await ui.dragTo("testid:card-1", "testid:col-done");
    verify(
      "S1",
      "elements.css:[data-testid=col-done] [data-testid=card-1].visible",
      undefined,
      plan.expect("TC-01.S1.elements.css:[data-testid=col-done] [data-testid=card-1].visible"),
    );
    verify(
      "S1",
      "elements.testid:done-count.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:done-count.text"),
    );
  });
}
