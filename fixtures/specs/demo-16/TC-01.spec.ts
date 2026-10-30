import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  let id = "";
  await step("S1", async () => {
    const res = await user.post(
      "/documents",
      user.multipart({ fields: { title: "Invoice 7" }, files: { file: "invoice" } }),
    );
    id = String(res.json("id"));
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify("S1", "fields.title", res.json("title"), plan.expect("TC-01.S1.fields.title"));
    verify("S1", "fields.name", res.json("name"), plan.expect("TC-01.S1.fields.name"));
    verify("S1", "fields.bytes", res.json("bytes"), plan.expect("TC-01.S1.fields.bytes"));
  });
  await step("S2", async () => {
    const res = await user.get(`/documents/${id}/file`);
    verify("S2", "status", res.status, plan.expect("TC-01.S2.status"));
    verify("S2", "download.name", undefined, plan.expect("TC-01.S2.download.name"));
    verify("S2", "download.type", undefined, plan.expect("TC-01.S2.download.type"));
    verify("S2", "download.size", undefined, plan.expect("TC-01.S2.download.size"));
  });
}
