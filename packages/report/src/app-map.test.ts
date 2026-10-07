import { describe, expect, it } from "vitest";
import { buildAppMap, mapAroundChange, renderAppMapHtml } from "./app-map.js";
import type { TransitionGraph } from "./graph.js";

const graph = (outcome: "passed" | "failed"): TransitionGraph => ({
  nodes: [
    { id: "page:start", kind: "page", label: "start" },
    { id: "api:GET /cart", kind: "api", label: "GET /cart" },
  ],
  edges: [{ from: "page:start", to: "api:GET /cart", label: "TC-01.S1", outcome }],
});

describe("application map (REQ-OBS-07)", () => {
  it("REQ-OBS-07/AC1: aggregates runs, keeps the last outcome and lists known nodes never tested", () => {
    const map = buildAppMap(
      [
        { ticket: "DEMO-2", runId: "r2", at: "2026-10-02T00:00:00Z", graph: graph("failed") },
        { ticket: "DEMO-1", runId: "r1", at: "2026-10-01T00:00:00Z", graph: graph("passed") },
      ],
      { pages: ["/products", "/cart"], api: ["GET /cart", "POST /orders"] },
      new Date("2026-10-04T00:00:00Z"),
    );
    expect(map.runs).toBe(2);
    expect(map.edges).toEqual([
      {
        from: "page:start",
        to: "api:GET /cart",
        passed: 1,
        failed: 1,
        lastOutcome: "failed",
        lastTested: "2026-10-02T00:00:00Z",
        tickets: ["DEMO-1", "DEMO-2"],
      },
    ]);
    expect(map.nodes.find((n) => n.id === "api:GET /cart")).toMatchObject({
      tested: true,
      tickets: ["DEMO-1", "DEMO-2"],
      lastTested: "2026-10-02T00:00:00Z",
    });
    expect(map.neverTested).toEqual(["api:POST /orders", "page:/cart", "page:/products"]);
  });

  it("REQ-OBS-07/AC2: renders a static page without scripts, escaping labels", () => {
    const map = buildAppMap([], { pages: ['/x"<y>'], api: [] }, new Date(0));
    const html = renderAppMapHtml(map, "demo<shop>");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<script");
    expect(html).toContain("demo&lt;shop&gt;");
    expect(html).toContain("page:/x&quot;&lt;y&gt;");
    expect(renderAppMapHtml(buildAppMap([], { pages: [], api: [] }, new Date(0)), "p")).toContain(
      "Every known screen and endpoint was reached",
    );
  });
});

describe("map around a change (REQ-OBS-08)", () => {
  const map = buildAppMap(
    [
      {
        ticket: "DEMO-1",
        runId: "r1",
        at: "2026-10-01T00:00:00Z",
        graph: {
          nodes: [
            { id: "page:/cart", kind: "page", label: "/cart" },
            { id: "api:GET /cart", kind: "api", label: "GET /cart" },
            { id: "page:/products", kind: "page", label: "/products" },
          ],
          edges: [
            { from: "page:/cart", to: "api:GET /cart", label: "TC-01.S1", outcome: "failed" },
            { from: "page:/products", to: "page:/products", label: "TC-02.S1", outcome: "passed" },
          ],
        },
      },
    ],
    {
      pages: ["/", "/cart", "/cart/checkout", "/products", "/orders/:id"],
      api: ["GET /cart", "POST /cart/discount", "DELETE /cart/items/{id}", "GET /orders/{id}"],
    },
    new Date("2026-10-04T00:00:00Z"),
  );

  it("REQ-OBS-08/AC1: lists touched nodes, never tested nodes in the same area and transitions around the change", () => {
    const around = mapAroundChange(map, {
      endpoints: ["POST /cart/discount", "/cart"],
      screens: ["Cart page"],
      files: ["src/api/discount.ts"],
    });
    expect(around.changed).toEqual([
      { id: "api:GET /cart", tested: true, tickets: ["DEMO-1"], lastTested: "2026-10-01T00:00:00Z" },
      { id: "api:POST /cart/discount", tested: false, tickets: [] },
      { id: "page:/cart", tested: true, tickets: ["DEMO-1"], lastTested: "2026-10-01T00:00:00Z" },
    ]);
    expect(around.untested).toEqual([
      { id: "api:DELETE /cart/items/{id}", near: "api:GET /cart" },
      { id: "page:/cart/checkout", near: "page:/cart" },
    ]);
    expect(around.transitions).toEqual([
      { from: "page:/cart", to: "api:GET /cart", passed: 0, failed: 1, lastOutcome: "failed" },
    ]);
    expect(around.runs).toBe(1);
  });

  it("REQ-OBS-08/AC1: templated paths match concrete ones; nothing touched gives empty lists", () => {
    expect(
      mapAroundChange(map, { endpoints: ["GET /orders/42"], screens: [], files: [] }).changed.map(
        (c) => c.id,
      ),
    ).toEqual(["api:GET /orders/{id}"]);
    expect(
      mapAroundChange(map, { endpoints: ["PUT /cart"], screens: ["Home"], files: ["README.md"] }),
    ).toMatchObject({ changed: [], untested: [], transitions: [] });
  });
});
