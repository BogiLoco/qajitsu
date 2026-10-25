import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-04";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/reviews");
    await ui.click("testid:star-4");
    verify(
      "S1",
      "elements.testid:rating-value.text",
      undefined,
      plan.expect("TC-04.S1.elements.testid:rating-value.text"),
    );
    verify("S1", "state.bars.3.value", undefined, plan.expect("TC-04.S1.state.bars.3.value"));
  });
}
