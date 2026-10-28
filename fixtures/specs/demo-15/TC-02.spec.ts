import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/gallery");
    await ui.doubleTap("testid:slides");
    verify(
      "S1",
      "elements.testid:gallery-status.text",
      undefined,
      plan.expect("TC-02.S1.elements.testid:gallery-status.text"),
    );
  });
  await step("S2", async () => {
    await ui.longPress("testid:slides", 1);
    verify(
      "S2",
      "elements.testid:gallery-status.text",
      undefined,
      plan.expect("TC-02.S2.elements.testid:gallery-status.text"),
    );
  });
}
