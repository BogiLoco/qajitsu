import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-04";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    await user.subscribe("subscription Prices($id: ID!) { priceChanged(id: $id) { id price } }", {
      id: "P-2",
    });
    verify(
      "S1",
      "messages.0.data.priceChanged.price",
      undefined,
      plan.expect("TC-04.S1.messages.0.data.priceChanged.price"),
    );
    verify(
      "S1",
      "messages.1.data.priceChanged.price",
      undefined,
      plan.expect("TC-04.S1.messages.1.data.priceChanged.price"),
    );
    verify("S1", "messages.count", undefined, plan.expect("TC-04.S1.messages.count"));
  });
}
