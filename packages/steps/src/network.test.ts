import { describe, expect, it } from "vitest";
import { diagnoseNetwork, reachedEndpoints, type UiRequest } from "./network.js";

const req = (r: Partial<UiRequest> & Pick<UiRequest, "url">): UiRequest => ({
  method: "GET",
  resourceType: "fetch",
  sameOrigin: true,
  ...r,
});

describe("network diagnosis of a step (REQ-EVD-09/AC1)", () => {
  it("REQ-EVD-09/AC1: names the requests that went wrong in the order they were sent; fine requests are not listed", () => {
    const problems = diagnoseNetwork([
      req({ url: "/products", status: 200 }),
      req({ method: "POST", url: "/orders", status: 500 }),
      req({ url: "/me", status: 401 }),
      req({ url: "/slow", failure: "net::ERR_TIMED_OUT" }),
      req({ url: "/down", failure: "net::ERR_CONNECTION_REFUSED" }),
      req({ url: "https://tracker.example/p", refused: true, sameOrigin: false }),
      req({ url: "https://api.other.example/x", cors: true, sameOrigin: false, failure: "net::ERR_FAILED" }),
      req({
        url: "/app/checkout",
        status: 302,
        location: "/app/login?next=/app/checkout",
        resourceType: "document",
      }),
      req({ url: "/favicon.ico", status: 404, resourceType: "image" }),
      req({ url: "/aborted", failure: "net::ERR_ABORTED" }),
    ]);
    expect(problems.map((p) => [p.kind, p.method, p.url, p.status ?? p.detail])).toEqual([
      ["server-error", "POST", "/orders", 500],
      ["client-error", "GET", "/me", 401],
      ["timeout", "GET", "/slow", "net::ERR_TIMED_OUT"],
      ["connection", "GET", "/down", "net::ERR_CONNECTION_REFUSED"],
      ["refused-by-allowlist", "GET", "https://tracker.example/p", "not on the environment allowlist"],
      ["cors", "GET", "https://api.other.example/x", "blocked by the browser's CORS policy"],
      ["login-redirect", "GET", "/app/checkout", 302],
      ["client-error", "GET", "/favicon.ico", 404],
    ]);
    expect(problems.find((p) => p.kind === "login-redirect")?.detail).toBe("redirected to /app/login");
    // A request the page cancelled itself (navigation away) is not a failure.
    expect(problems.some((p) => p.url === "/aborted")).toBe(false);
  });

  it("REQ-EVD-09/AC1: at most 20 problems, with how many there were", () => {
    const many = Array.from({ length: 30 }, (_, i) => req({ url: `/x/${String(i)}`, status: 503 }));
    const problems = diagnoseNetwork(many);
    expect(problems).toHaveLength(20);
    expect(diagnoseNetwork([])).toEqual([]);
  });
});

describe("endpoints the cases reached (REQ-EVD-09/AC2)", () => {
  it("REQ-EVD-09/AC2: pages and API calls of the application's origin, once each, without query and assets", () => {
    expect(
      reachedEndpoints([
        req({ method: "POST", url: "/orders?x=1", status: 201 }),
        req({ method: "POST", url: "/orders", status: 201 }),
        req({ url: "/orders/42", status: 200, resourceType: "xhr" }),
        req({ url: "/app/checkout", status: 200, resourceType: "document" }),
        req({ url: "/app.js", status: 200, resourceType: "script" }),
        req({ url: "https://cdn.example/lib.js", status: 200, sameOrigin: false }),
        req({ url: "/refused", refused: true }),
      ]),
    ).toEqual([
      { method: "POST", path: "/orders", status: 201 },
      { method: "GET", path: "/orders/42", status: 200 },
      { method: "GET", path: "/app/checkout", status: 200 },
    ]);
  });
});
