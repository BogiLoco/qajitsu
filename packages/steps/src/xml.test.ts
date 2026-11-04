import { describe, expect, it } from "vitest";
import { parseXml, soapEnvelope, soapFault, xmlValue } from "./xml.js";

const ENVELOPE = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:p="urn:shop:prices">
  <soap:Body>
    <p:GetPriceResponse p:currency="EUR">
      <p:amount>24.99</p:amount>
      <p:sku>P-2</p:sku>
      <p:sku>P-3</p:sku>
    </p:GetPriceResponse>
  </soap:Body>
</soap:Envelope>`;

describe("XML values by XPath (REQ-EXEC-50/AC3)", () => {
  it("REQ-EXEC-50/AC3: XPath addresses local names; the first node's text, an attribute or a computed value", () => {
    expect(xmlValue(ENVELOPE, "//GetPriceResponse/amount")).toBe("24.99");
    expect(xmlValue(ENVELOPE, "//GetPriceResponse/@currency")).toBe("EUR");
    expect(xmlValue(ENVELOPE, "count(//sku)")).toBe(2);
    expect(xmlValue(ENVELOPE, "//sku[2]")).toBe("P-3");
    expect(xmlValue(ENVELOPE, "boolean(//amount)")).toBe(true);
    expect(xmlValue(ENVELOPE, "string(//amount)")).toBe("24.99");
    expect(xmlValue(ENVELOPE, "//missing")).toBeUndefined();
  });

  it("REQ-EXEC-50/AC3: a body that is not XML, or an expression that is not XPath, has no value", () => {
    expect(xmlValue('{"json": true}', "//a")).toBeUndefined();
    expect(xmlValue(ENVELOPE, "//[")).toBeUndefined();
    expect(xmlValue("", "//a")).toBeUndefined();
    // Malformed XML is not XML: the parser's fatal errors and its recoverable ones alike.
    expect(xmlValue("<a>", "//a")).toBeUndefined();
    expect(xmlValue("<a>x</a>trailing", "//a")).toBeUndefined();
    expect(xmlValue("<a>&nbsp;</a>", "//a")).toBeUndefined();
    expect(parseXml("<p:a/>")).toBeUndefined();
    expect(parseXml("<a/>")?.localName).toBe("a");
    // The document node has no text of its own.
    expect(xmlValue("<a/>", "/")).toBe("");
  });
});

describe("SOAP envelopes and faults (REQ-EXEC-50/AC1+AC2)", () => {
  it("REQ-EXEC-50/AC1: the body is wrapped in the envelope of SOAP 1.1 or 1.2", () => {
    expect(soapEnvelope("<GetPrice><sku>P-2</sku></GetPrice>", "1.1")).toBe(
      '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetPrice><sku>P-2</sku></GetPrice></soap:Body></soap:Envelope>',
    );
    expect(soapEnvelope("<x/>", "1.2")).toContain('xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
  });

  it("REQ-EXEC-50/AC2: a fault of either version is found with its text; a normal answer has none", () => {
    expect(soapFault(ENVELOPE)).toBeUndefined();
    expect(
      soapFault(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>Unknown SKU</faultstring></s:Fault></s:Body></s:Envelope>',
      ),
    ).toBe("s:Server: Unknown SKU");
    expect(
      soapFault(
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault><e:Code><e:Value>e:Receiver</e:Value></e:Code><e:Reason><e:Text xml:lang="en">Database down</e:Text></e:Reason></e:Fault></e:Body></e:Envelope>',
      ),
    ).toBe("e:Receiver: Database down");
    expect(soapFault("<Fault/>")).toBe("fault");
    expect(soapFault("not xml")).toBeUndefined();
  });
});
