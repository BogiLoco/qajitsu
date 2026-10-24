import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-03";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/products");
    await ui.waitFor("testid:product-P-3");
    await ui.download("testid:export-csv");
    verify("S1", "download.name", undefined, plan.expect("TC-03.S1.download.name"));
    verify("S1", "download.type", undefined, plan.expect("TC-03.S1.download.type"));
    verify("S1", "download.rows", undefined, plan.expect("TC-03.S1.download.rows"));
    verify("S1", "download.texts.0", undefined, plan.expect("TC-03.S1.download.texts.0"));
  });
}
