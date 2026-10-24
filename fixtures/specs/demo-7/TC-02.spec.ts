import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.as("user:standard");
    await ui.goto("/app/profile");
    await ui.upload("testid:avatar-drop", "big");
    await ui.waitFor("testid:toast");
    verify("S1", "texts.0", undefined, plan.expect("TC-02.S1.texts.0"));
  });
}
