import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/products");
    await ui.waitFor("testid:price-P-2");
    verify("S1", "texts.0", undefined, plan.expect("TC-02.S1.texts.0"));
  });
}
