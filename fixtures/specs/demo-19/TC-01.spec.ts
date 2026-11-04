import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    const res = await user.soap(
      "/soap/prices",
      '<GetPrice xmlns="urn:demo-shop:prices"><sku>P-2</sku></GetPrice>',
      {
        action: "urn:demo-shop:prices#GetPrice",
      },
    );
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify(
      "S1",
      "xml.//GetPriceResponse/name",
      await res.xml("//GetPriceResponse/name"),
      plan.expect("TC-01.S1.xml.//GetPriceResponse/name"),
    );
    verify(
      "S1",
      "xml.//GetPriceResponse/amount",
      await res.xml("//GetPriceResponse/amount"),
      plan.expect("TC-01.S1.xml.//GetPriceResponse/amount"),
    );
  });
}
