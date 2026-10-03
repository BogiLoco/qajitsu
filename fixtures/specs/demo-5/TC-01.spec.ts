import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api, ui }: CaseContext): Promise<void> {
  const shopper = api.as("user:standard");
  await step("S1", async () => {
    const res = await shopper.post("/cart/lines", { product_id: "P-2", quantity: 1 });
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
  });
  await step("S2", async () => {
    await ui.as("user:standard");
    await ui.goto("/app/checkout");
    await ui.check("testid:accept-terms");
    await ui.click("testid:place-order");
    await ui.waitFor("testid:toast");
    verify("S2", "texts.0", undefined, plan.expect("TC-01.S2.texts.0"));
  });
  await step("S3", async () => {
    const res = await shopper.get("/cart");
    verify("S3", "status", res.status, plan.expect("TC-01.S3.status"));
    verify(
      "S3",
      "fields.lines.length",
      res.json("lines.length"),
      plan.expect("TC-01.S3.fields.lines.length"),
    );
  });
}
