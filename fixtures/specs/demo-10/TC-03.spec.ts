import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-03";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/offer");
    await ui.click("testid:nearest-store");
    await ui.waitFor("testid:store");
    verify("S1", "elements.testid:store.text", undefined, plan.expect("TC-03.S1.elements.testid:store.text"));
  });
}
