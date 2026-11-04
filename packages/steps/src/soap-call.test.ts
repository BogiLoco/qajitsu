import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, type ApiRequest } from "./runtime.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-19",
  version: 1,
  summary: "Prices over SOAP.",
  cases: [
    {
      id: "TC-01",
      title: "A price is read",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "POST /soap/prices",
          soap: { operation: "GetPrice" },
          expect: {
            description: "Priced",
            status: 200,
            xml: {
              "//GetPriceResponse/amount": 24.99,
              "//GetPriceResponse/@currency": "EUR",
              "//GetPriceResponse/stock": true,
            },
          },
        },
      ],
      evidence: ["request", "response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const ANSWER = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<p:GetPriceResponse xmlns:p="urn:shop:prices" currency="EUR"><p:amount>24.99</p:amount><p:stock>true</p:stock></p:GetPriceResponse>
</soap:Body></soap:Envelope>`;

const setup = (text = ANSWER) => {
  const sent: ApiRequest[] = [];
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: (req) => {
      sent.push(req);
      return Promise.resolve({ status: 200, headers: { "content-type": "text/xml" }, text });
    },
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => 0,
  });
  return { runtime, sent };
};

const decode = (req: ApiRequest | undefined): string => {
  const payload = req?.payload;
  return payload?.kind === "bytes" ? new TextDecoder().decode(payload.data) : "";
};

describe("SOAP calls and XPath checks (REQ-EXEC-50)", () => {
  it("REQ-EXEC-50/AC1+AC3: a SOAP 1.1 call is enveloped with its SOAPAction; XPath values are checked as the plan's types", async () => {
    const { runtime, sent } = setup();
    const { api, verify, plan: p } = runtime.context;
    await runtime.context.step("S1", async () => {
      const res = await api.soap(
        "/soap/prices",
        '<GetPrice xmlns="urn:shop:prices"><sku>P-2</sku></GetPrice>',
        {
          action: "urn:shop:prices#GetPrice",
        },
      );
      for (const x of [
        "//GetPriceResponse/amount",
        "//GetPriceResponse/@currency",
        "//GetPriceResponse/stock",
      ])
        verify("S1", `xml.${x}`, await res.xml(x), p.expect(`TC-01.S1.xml.${x}`));
    });
    const record = await runtime.finish();
    expect(record.outcome).toBe("passed");
    expect(record.assertions.map((a) => [a.field, a.actual, a.pass])).toEqual([
      ["xml.//GetPriceResponse/amount", 24.99, true],
      ["xml.//GetPriceResponse/@currency", "EUR", true],
      ["xml.//GetPriceResponse/stock", true, true],
    ]);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:3000/soap/prices",
      headers: { "content-type": "text/xml; charset=utf-8", soapaction: '"urn:shop:prices#GetPrice"' },
    });
    expect(decode(sent[0])).toContain("<soap:Body><GetPrice");
    const call = JSON.parse(String(record.evidence.find((e) => e.name === "S1-01.json")?.content)) as {
      soap?: unknown;
      request: { body: { soap: { envelope: string } } };
    };
    expect(call.soap).toEqual({ version: "1.1", action: "urn:shop:prices#GetPrice" });
    expect(call.request.body.soap.envelope).toContain("<sku>P-2</sku>");
  });

  it("REQ-EXEC-50/AC1: SOAP 1.2 carries its action in the content type; a wrong value fails the check", async () => {
    const wrong = ANSWER.replace("24.99", "2499").replace("true", "maybe");
    const { runtime, sent } = setup(wrong);
    const { api, verify, plan: p } = runtime.context;
    await runtime.context.step("S1", async () => {
      const res = await api.soap("/soap/prices", "<GetPrice/>", { version: "1.2", action: "GetPrice" });
      verify(
        "S1",
        "xml.//GetPriceResponse/amount",
        await res.xml("//GetPriceResponse/amount"),
        p.expect("TC-01.S1.xml.//GetPriceResponse/amount"),
      );
      verify(
        "S1",
        "xml.//GetPriceResponse/stock",
        await res.xml("//GetPriceResponse/stock"),
        p.expect("TC-01.S1.xml.//GetPriceResponse/stock"),
      );
    });
    const record = await runtime.finish();
    expect(record.outcome).toBe("failed");
    expect(record.assertions.map((a) => a.actual)).toEqual([2499, "maybe"]);
    expect(sent[0]?.headers["content-type"]).toBe('application/soap+xml; charset=utf-8; action="GetPrice"');
    expect(sent[0]?.headers).not.toHaveProperty("soapaction");
    expect(decode(sent[0])).toContain('xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
  });

  it("REQ-EXEC-50/AC3: an XPath the plan does not hold is refused; a malformed SOAP descriptor is refused", async () => {
    const { runtime } = setup();
    expect(() => runtime.context.plan.expect("TC-01.S1.xml.//other")).toThrow(/no expected XPath/);
    await runtime.context.step("S1", async () => {
      await expect(runtime.context.api.soap("/soap/prices", 5 as unknown as string)).rejects.toThrow();
      await expect(
        runtime.context.api.soap("/soap/prices", "<a/>", { version: "2.0" as "1.2" }),
      ).rejects.toThrow();
      const res = await runtime.context.api.soap("/soap/prices", "<a/>", { version: "1.2" });
      expect(res.headers["content-type"]).toBe("text/xml");
    });
  });
});
