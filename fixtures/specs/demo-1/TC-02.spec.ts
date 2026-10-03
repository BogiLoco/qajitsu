import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const shopper = api.as("user:standard");
  await step("S1", async () => {
    await shopper.post("/cart/lines", { product_id: "P-2", quantity: 1 });
    const res = await shopper.post("/cart/discount", { code: "SAVE10" });
    verify("S1", "status", res.status, plan.expect("TC-02.S1.status"));
  });
  await step("S2", async () => {
    const res = await shopper.post("/cart/discount", { code: "SAVE20" });
    verify("S2", "status", res.status, plan.expect("TC-02.S2.status"));
    verify(
      "S2",
      "fields.discounts.length",
      res.json("discounts.length"),
      plan.expect("TC-02.S2.fields.discounts.length"),
    );
  });
}
