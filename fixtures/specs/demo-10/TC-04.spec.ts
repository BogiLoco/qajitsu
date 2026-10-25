import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-04";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/addresses");
    // Every address has a Delete button: the chain names the one in the Office row.
    await ui.click("role:listitem >> has-text:Office >> role:button:Delete");
    verify(
      "S1",
      "elements.testid:address-2.visible",
      undefined,
      plan.expect("TC-04.S1.elements.testid:address-2.visible"),
    );
    verify(
      "S1",
      "elements.testid:address-1.visible",
      undefined,
      plan.expect("TC-04.S1.elements.testid:address-1.visible"),
    );
    verify(
      "S1",
      "elements.testid:address-count.text",
      undefined,
      plan.expect("TC-04.S1.elements.testid:address-count.text"),
    );
  });
}
