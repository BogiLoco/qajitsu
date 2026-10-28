import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.session("buyer");
    await ui.goto("/app/messages");
    await ui.fill("testid:message-to", "admin");
    await ui.fill("testid:message-text", "Is the mug in stock?");
    await ui.click("testid:message-send");
    await ui.waitFor("testid:message-status >> has-text:Sent");
    verify(
      "S1",
      "elements.testid:message-status.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:message-status.text"),
    );
    verify(
      "S1",
      "elements.testid:inbox-count.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:inbox-count.text"),
    );
  });
  await step("S2", async () => {
    await ui.session("seller");
    await ui.goto("/app/messages");
    verify(
      "S2",
      "elements.testid:inbox-count.text",
      undefined,
      plan.expect("TC-01.S2.elements.testid:inbox-count.text"),
    );
    verify("S2", "texts.0", undefined, plan.expect("TC-01.S2.texts.0"));
  });
}
