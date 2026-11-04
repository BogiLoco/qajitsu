import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    const feed = await user.websocket("/ws/prices");
    await feed.send({ subscribe: "P-2" });
    // The check waits for each planned message itself; the actual value is read from the stream.
    verify("S1", "messages.0.type", undefined, plan.expect("TC-01.S1.messages.0.type"));
    verify("S1", "messages.0.price", undefined, plan.expect("TC-01.S1.messages.0.price"));
    verify("S1", "messages.1.type", undefined, plan.expect("TC-01.S1.messages.1.type"));
    verify("S1", "messages.1.available", undefined, plan.expect("TC-01.S1.messages.1.available"));
    verify("S1", "messages.count", undefined, plan.expect("TC-01.S1.messages.count"));
  });
}
