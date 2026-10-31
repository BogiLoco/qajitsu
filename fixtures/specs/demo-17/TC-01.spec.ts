import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api, data }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  // The product was created for this attempt from the plan's test_data; its id comes from the application.
  const product = data.get("lamp");
  await step("S1", async () => {
    const res = await user.get(`/products/${String(product["id"])}`);
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify("S1", "fields.stock", res.json("stock"), plan.expect("TC-01.S1.fields.stock"));
    verify("S1", "fields.low_stock", res.json("low_stock"), plan.expect("TC-01.S1.fields.low_stock"));
  });
}
