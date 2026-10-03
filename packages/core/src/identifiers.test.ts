import { describe, expect, it } from "vitest";
import { RunIdSchema, TicketKeySchema, createRunId, mentionsTicketKey } from "./identifiers.js";

describe("TicketKeySchema (REQ-CTX-01)", () => {
  it.each(["SHOP-482", "AB-1", "QA_TEAM-99999"])("accepts %s", (key) => {
    expect(TicketKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(["shop-482", "SHOP-0", "SHOP-", "../SHOP-1", "SHOP-1;rm", "A-1"])("rejects %s", (key) => {
    expect(TicketKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("createRunId (REQ-WS-01)", () => {
  it("formats UTC date, time and a 4-character suffix", () => {
    const values = [0, 0.5, 0.99, 0.1];
    let i = 0;
    const id = createRunId(new Date(Date.UTC(2026, 9, 3, 8, 46)), () => values[i++] ?? 0);
    expect(id).toBe("20261003-0846-as9d");
  });

  it("stays valid when random returns the upper edge", () => {
    expect(RunIdSchema.safeParse(createRunId(new Date(0), () => 0.999999)).success).toBe(true);
  });
});

describe("mentionsTicketKey (REQ-CTX-03/AC2)", () => {
  const key = TicketKeySchema.parse("SHOP-482");
  it.each([
    ["SHOP-482 discount codes", true],
    ["feature/shop-482-cart", true],
    ["[SHOP-482] fix", true],
    ["SHOP-4820 other", false],
    ["XSHOP-482", false],
    ["nothing", false],
  ])("%s → %s", (text, expected) => {
    expect(mentionsTicketKey(text, key)).toBe(expected);
  });
});
