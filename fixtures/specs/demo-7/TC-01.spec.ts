import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.as("user:standard");
    await ui.goto("/app/profile");
    await ui.upload("testid:avatar-input", "avatar");
    await ui.waitFor("testid:toast");
    verify(
      "S1",
      "elements.testid:avatar-name.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:avatar-name.text"),
    );
    verify(
      "S1",
      "elements.testid:avatar-size.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:avatar-size.text"),
    );
  });
}
