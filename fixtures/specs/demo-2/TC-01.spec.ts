import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  await step("S1", async () => {
    const res = await api.as("user:standard").post("/orders", { product_id: "P-2", quantity: -1 });
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify("S1", "fields.error", res.json("error"), plan.expect("TC-01.S1.fields.error"));
  });
}
