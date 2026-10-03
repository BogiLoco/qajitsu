import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const shopper = api.as("user:standard");
  await step("S1", async () => {
    await shopper.post("/cart/lines", { product_id: "P-1", quantity: 3 });
    const res = await shopper.get("/cart");
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify("S1", "fields.total", res.json("total"), plan.expect("TC-01.S1.fields.total"));
  });
}
