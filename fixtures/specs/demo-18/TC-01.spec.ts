import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    const res = await user.graphql("query Read($id: ID!) { product(id: $id) { id name price } }", {
      id: "P-2",
    });
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify(
      "S1",
      "fields.data.product.name",
      res.json("data.product.name"),
      plan.expect("TC-01.S1.fields.data.product.name"),
    );
    verify(
      "S1",
      "fields.data.product.price",
      res.json("data.product.price"),
      plan.expect("TC-01.S1.fields.data.product.price"),
    );
  });
}
