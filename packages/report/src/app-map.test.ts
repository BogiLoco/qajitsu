import { describe, expect, it } from "vitest";
import { buildAppMap, renderAppMapHtml } from "./app-map.js";
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
