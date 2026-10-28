import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/signin");
    await ui.fillSecret("testid:signin-username", "user:standard", "username");
    await ui.fill("testid:signin-password", "not-the-password");
    await ui.click("testid:signin-submit");
    // Either answer ends the wait; the check below decides.
    await ui.waitFor("testid:signin-result >> has-text:i");
    verify(
      "S1",
      "elements.testid:signin-result.text",
      undefined,
      plan.expect("TC-02.S1.elements.testid:signin-result.text"),
    );
  });
}
