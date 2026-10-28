import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.goto("/app/chat");
    await ui.waitFor("testid:chat-status >> has-text:Online");
    verify(
      "S1",
      "elements.testid:chat-status.text",
      undefined,
      plan.expect("TC-01.S1.elements.testid:chat-status.text"),
    );
  });
  await step("S2", async () => {
    await ui.fill("testid:chat-input", "Where is my order?");
    await ui.click("testid:chat-send");
    verify("S2", "websocket.sent.0", undefined, plan.expect("TC-01.S2.websocket.sent.0"));
    verify("S2", "websocket.received.0", undefined, plan.expect("TC-01.S2.websocket.received.0"));
  });
}
