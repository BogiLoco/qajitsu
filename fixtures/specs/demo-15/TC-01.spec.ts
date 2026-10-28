import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/gallery");
    await ui.swipe("testid:slides", "left", { distance: 0.6, speed: "fast" });
    verify("S1", "elements.testid:slide.text", undefined, plan.expect("TC-01.S1.elements.testid:slide.text"));
  });
  await step("S2", async () => {
    await ui.swipe("testid:slides", "right", { distance: 0.6, speed: "fast" });
    verify("S2", "elements.testid:slide.text", undefined, plan.expect("TC-01.S2.elements.testid:slide.text"));
  });
}
