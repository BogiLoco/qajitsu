import { describe, expect, it } from "vitest";
import { buildTransitionGraph, normalizeRoute, renderGraphSvg } from "./graph.js";

describe("transition graph (REQ-OBS-06)", () => {
  it("REQ-OBS-06/AC3: normalises URLs with rules from .qa/ or by recognising ids", () => {
    expect(normalizeRoute("/product/42")).toBe("/product/:id");
    expect(normalizeRoute("/orders/O-7?x=1")).toBe("/orders/:id");
    expect(normalizeRoute("/cart/0b5e2c4a-1111-2222-3333-444455556666")).toBe("/cart/:id");
    expect(normalizeRoute("/shop/blue-mug", ["/shop/:slug"])).toBe("/shop/:slug");
    expect(normalizeRoute("/items/7", ["/items/{itemId}"])).toBe("/items/:itemId");
  });

  it("REQ-OBS-06/AC1+AC2: pages and endpoints are nodes; steps are edges coloured by outcome", () => {
    const graph = buildTransitionGraph([
      {
        caseId: "TC-01",
        steps: [
          { id: "S1", ok: true },
          { id: "S2", ok: true, url: "http://127.0.0.1:3000/app/checkout" },
          { id: "S3", ok: true },
        ],
        calls: [
          { stepId: "S1", method: "POST", url: "http://127.0.0.1:3000/cart/lines" },
          { stepId: "S3", method: "GET", url: "http://127.0.0.1:3000/cart" },
        ],
        failedSteps: ["S3"],
      },
      {
        caseId: "TC-02",
        steps: [
          { id: "S1", ok: false, url: "not a url" },
          { id: "S2", ok: true },
        ],
        calls: [],
        failedSteps: [],
      },
    ]);
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "page:start",
      "api:POST /cart/lines",
      "page:/app/checkout",
      "api:GET /cart",
    ]);
    expect(graph.edges).toEqual([
      { from: "page:start", to: "api:POST /cart/lines", label: "TC-01.S1", outcome: "passed" },
      { from: "api:POST /cart/lines", to: "page:/app/checkout", label: "TC-01.S2", outcome: "passed" },
      { from: "page:/app/checkout", to: "api:GET /cart", label: "TC-01.S3", outcome: "failed" },
    ]);
    const svg = renderGraphSvg(graph);
    expect(svg).toContain("<svg");
    expect(svg).toContain('stroke="#cf222e"');
    expect(svg).toContain("TC-01.S3 (failed)");
    expect(svg).not.toContain("<script");
  });
});
