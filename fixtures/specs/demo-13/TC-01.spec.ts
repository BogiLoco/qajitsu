import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/signin");
    await ui.fillSecret("testid:signin-username", "user:standard", "username");
    await ui.fillSecret("testid:signin-password", "user:standard", "password");
    await ui.click("testid:signin-submit");
    await ui.waitFor("testid:signin-result >> has-text:Signed in");
    await ui.goto("/app/account");
    await ui.waitFor("testid:account-user >> has-text:Signed");
    verify(
      "S1",
      "elements.testid:account-user.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:account-user.text"),
    );
  });
}
