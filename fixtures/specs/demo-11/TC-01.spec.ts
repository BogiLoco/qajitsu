import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/notes");
    verify("S1", "manifest.short_name", undefined, plan.expect("TC-01.S1.manifest.short_name"));
    verify("S1", "manifest.display", undefined, plan.expect("TC-01.S1.manifest.display"));
    verify("S1", "manifest.icons", undefined, plan.expect("TC-01.S1.manifest.icons"));
    verify("S1", "manifest.controlled", undefined, plan.expect("TC-01.S1.manifest.controlled"));
  });
}
