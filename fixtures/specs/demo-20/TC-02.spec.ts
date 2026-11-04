import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    await user.events("/events/orders");
    // The check waits for each planned message itself; the actual value is read from the stream.
    verify("S1", "messages.0.event", undefined, plan.expect("TC-02.S1.messages.0.event"));
    verify("S1", "messages.1.event", undefined, plan.expect("TC-02.S1.messages.1.event"));
    verify("S1", "messages.2.event", undefined, plan.expect("TC-02.S1.messages.2.event"));
    verify("S1", "messages.2.data.status", undefined, plan.expect("TC-02.S1.messages.2.data.status"));
    verify("S1", "messages.count", undefined, plan.expect("TC-02.S1.messages.count"));
  });
}
