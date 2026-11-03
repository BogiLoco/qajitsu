import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-03";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    const res = await user.graphql("query Read($id: ID!) { product(id: $id) { id } }", { id: "P-9" });
    verify("S1", "status", res.status, plan.expect("TC-03.S1.status"));
    verify(
      "S1",
      "fields.data.product",
      res.json("data.product"),
      plan.expect("TC-03.S1.fields.data.product"),
    );
  });
}
