import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-03";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  let id = "";
  await step("S1", async () => {
    const res = await user.post(
      "/documents",
      user.multipart({ fields: { title: "Invoice 8" }, files: { file: "invoice" } }),
    );
    id = String(res.json("id"));
    verify("S1", "status", res.status, plan.expect("TC-03.S1.status"));
    verify("S1", "fields.status", res.json("status"), plan.expect("TC-03.S1.fields.status"));
  });
  // The plan's wait repeats this step until the document is ready or 10 seconds have passed.
  await step("S2", async () => {
    const res = await user.get(`/documents/${id}`);
    verify("S2", "status", res.status, plan.expect("TC-03.S2.status"));
    verify("S2", "fields.status", res.json("status"), plan.expect("TC-03.S2.fields.status"));
  });
}
