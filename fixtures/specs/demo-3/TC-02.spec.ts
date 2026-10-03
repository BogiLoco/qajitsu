import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  await step("S1", async () => {
    const res = await api.as("user:expired").get("/me");
    verify("S1", "status", res.status, plan.expect("TC-02.S1.status"));
    verify("S1", "fields.error", res.json("error"), plan.expect("TC-02.S1.fields.error"));
  });
}
