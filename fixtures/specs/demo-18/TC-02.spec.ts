import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    const res = await user.graphql("{ products { id name price } }");
    verify("S1", "status", res.status, plan.expect("TC-02.S1.status"));
    verify(
      "S1",
      "fields.data.products.2.id",
      res.json("data.products.2.id"),
      plan.expect("TC-02.S1.fields.data.products.2.id"),
    );
  });
}
