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

  it("REQ-OBS-06/AC4: arrows end at the target's edge, parallel edges are apart, a step on the same node is a loop, and every edge is labelled", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "page" as const, label: "start" },
        { id: "api:GET /cart", kind: "api" as const, label: "GET /cart" },
        { id: "api:POST /cart/discount", kind: "api" as const, label: "POST /cart/discount" },
      ],
      edges: [
        { from: "start", to: "api:GET /cart", label: "TC-01.S1", outcome: "failed" as const },
        { from: "start", to: "api:GET /cart", label: "TC-05.S1", outcome: "passed" as const },
        {
          from: "api:POST /cart/discount",
          to: "api:POST /cart/discount",
          label: "TC-03.S2",
          outcome: "failed" as const,
        },
      ],
    };
    const svg = renderGraphSvg(graph);
    const paths = [
      ...svg.matchAll(/<path class="edge" d="([^"]+)"[^>]*marker-end="url\(#arrow-(passed|failed)\)"/g),
    ];
    expect(paths).toHaveLength(3);
    const [first, second, loop] = paths.map((m) => m[1] ?? "");
    // Two edges between the same nodes are two different curves.
    expect(first).not.toBe(second);
    // The loop starts and ends on the same node's right side: a cubic curve back to it.
    expect(loop).toMatch(/^M[\d.]+ [\d.]+C/);
    // An arrow ends on the border of the target box, not inside it.
    const box = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"[^>]*\/><text[^>]*>GET \/cart</.exec(
      svg,
    );
    const bx = Number(box?.[1]);
    const by = Number(box?.[2]);
    const bw = Number(box?.[3]);
    const bh = Number(box?.[4]);
    const end = /([\d.]+) ([\d.]+)$/.exec(first ?? "");
    const [x, y] = [Number(end?.[1]), Number(end?.[2])];
    const near = (v: number, lo: number, hi: number) => v >= lo - 4 && v <= hi + 4;
    const inside = (v: number, lo: number, hi: number) => v > lo + 2 && v < hi - 2;
    expect(near(x, bx, bx + bw) && near(y, by, by + bh)).toBe(true);
    expect(inside(x, bx, bx + bw) && inside(y, by, by + bh)).toBe(false);
    for (const label of ["TC-01.S1", "TC-05.S1", "TC-03.S2"]) expect(svg).toContain(`>${label}</text>`);
  });
});
