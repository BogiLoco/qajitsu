import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-03";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.as("user:standard");
    await ui.goto("/app/account");
    await ui.waitFor("testid:account-user >> has-text:Signed");
    verify(
      "S1",
      "elements.testid:account-user.text",
      undefined,
      plan.expect("TC-03.S1.elements.testid:account-user.text"),
    );
  });
}
