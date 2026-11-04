import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import {
  analyzeTraffic,
  comparePerformance,
  diffNetwork,
  harRequests,
  linkHar,
  shapeOf,
  type UiRequest,
} from "./network.js";

const req = (r: Partial<UiRequest> & { url: string }): UiRequest => ({
  method: "GET",
  resourceType: "fetch",
  sameOrigin: true,
  status: 200,
  ...r,
});

describe("analysis of the recorded traffic (REQ-EVD-09/AC3..AC7)", () => {
  it("REQ-EVD-09/AC4: per step the number, size and slowest requests, and the budget they went over", () => {
    const analysis = analyzeTraffic(
      [
        {
          stepId: "S1",
          requests: [
            req({ url: "/api/cart", durationMs: 1200.4, bytes: 4096 }),
            req({ url: "/api/products", durationMs: 90, bytes: 2048 }),
            req({ url: "/logo.png", resourceType: "image", bytes: 100 }),
          ],
        },
        { stepId: "S2", requests: [req({ url: "/api/me", durationMs: 50, bytes: 10 })] },
      ],
      {
        appSecure: false,
        budget: { request_ms: 1000, step_requests: 2, step_kb: 5 },
        har: [4, 5, undefined, 7],
      },
    );
    expect(analysis.steps[0]).toEqual({
      stepId: "S1",
      requests: 3,
      bytes: 6244,
      slowest: [
        { stepId: "S1", method: "GET", url: "/api/cart", har: 4, durationMs: 1200 },
        { stepId: "S1", method: "GET", url: "/api/products", har: 5, durationMs: 90 },
      ],
      warnings: [
        "GET /api/cart took 1200 ms, the budget is 1000 ms",
        "3 requests, the budget is 2",
        "6 kB received, the budget is 5 kB",
      ],
    });
    expect(analysis.steps[1]?.warnings).toEqual([]);
    expect(analysis.steps[1]?.slowest[0]?.har).toBe(7);
    expect(
      analyzeTraffic([{ stepId: "S1", requests: [req({ url: "/a" })] }], { appSecure: false }).steps[0],
    ).toEqual({ stepId: "S1", requests: 1, bytes: 0, slowest: [], warnings: [] });
  });

  it("REQ-EVD-09/AC6: tokens and personal data in URLs, mixed content, missing headers and cookies without flags", () => {
    const analysis = analyzeTraffic(
      [
        {
          stepId: "S1",
          requests: [
            req({
              url: "https://analytics.example/collect",
              sameOrigin: false,
              query: { access_token: "***", v: "1" },
            }),
            req({ url: "/search", query: { q: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4" } }),
            req({ url: "/profile", query: { email: "x" } }),
            req({ url: "/go", query: { to: "ann@example.com" } }),
            req({ url: "/search", query: { access_token: "***" } }),
            req({ url: "http://cdn.example/lib.js", sameOrigin: false, resourceType: "script", mixed: true }),
            req({
              url: "/",
              resourceType: "document",
              securityHeaders: { "x-content-type-options": "nosniff" },
            }),
            req({
              url: "/account",
              resourceType: "document",
              securityHeaders: {
                "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
                "x-content-type-options": "nosniff",
                "strict-transport-security": "max-age=1",
              },
              cookies: [
                { name: "sid", secure: false, httpOnly: false },
                { name: "pref", secure: true, httpOnly: true },
              ],
            }),
            req({ url: "/missing", resourceType: "document", status: 404 }),
          ],
        },
      ],
      { appSecure: true },
    );
    expect(analysis.security.map((f) => [f.kind, f.url, f.detail])).toEqual([
      [
        "secret-in-url",
        "https://analytics.example/collect",
        'query parameter "access_token" carries a token or secret',
      ],
      ["secret-in-url", "/search", 'query parameter "q" carries a token or secret'],
      ["personal-data-in-url", "/profile", 'query parameter "email" carries personal data'],
      ["personal-data-in-url", "/go", 'query parameter "to" carries personal data'],
      ["secret-in-url", "/search", 'query parameter "access_token" carries a token or secret'],
      ["mixed-content", "http://cdn.example/lib.js", "an http: request of an https: page"],
      ["missing-header", "/", "no content-security-policy header"],
      ["missing-header", "/", "no x-frame-options header or frame-ancestors"],
      ["missing-header", "/", "no strict-transport-security header"],
      ["insecure-cookie", "/account", 'cookie "sid" without HttpOnly'],
      ["insecure-cookie", "/account", 'cookie "sid" without Secure'],
    ]);
    // On plain http, HSTS and Secure are not expected.
    const plain = analyzeTraffic(
      [
        {
          stepId: "S1",
          requests: [
            req({
              url: "/",
              resourceType: "document",
              securityHeaders: {},
              cookies: [{ name: "a", secure: false, httpOnly: true }],
            }),
          ],
        },
      ],
      { appSecure: false },
    );
    expect(plain.security.map((f) => f.detail)).toEqual([
      "no content-security-policy header",
      "no x-content-type-options header",
      "no x-frame-options header or frame-ancestors",
    ]);
  });

  it("REQ-EVD-09/AC3+AC5: bodies are kept only when enabled, masked, within the size, and never when they look like a secret", () => {
    const masker = createMasker({ secrets: ["s3cr3t-value-123"] });
    const options = {
      appSecure: false,
      bodies: {
        maxBytes: 200,
        mask: (v: unknown) => masker.maskJson(v),
        looksSecret: (t: string) => masker.containsSecret(t) || /eyJ[\w-]{8,}\./.test(t),
      },
      har: [0, 1, 2, 3, 4, 5],
    };
    const analysis = analyzeTraffic(
      [
        {
          stepId: "S1",
          requests: [
            req({
              url: "/api/cart?x=1",
              bodyText: JSON.stringify({ total: 10, lines: [{ sku: "A" }], note: "s3cr3t-value-123" }),
            }),
            req({ url: "/api/big", bodyText: JSON.stringify({ blob: "x".repeat(300) }) }),
            req({ url: "/api/token", bodyText: JSON.stringify({ t: "eyJhbGciOiJIUzI1.payload" }) }),
            req({ url: "/api/text", bodyText: "not json" }),
            req({ url: "https://other.example/api", sameOrigin: false, bodyText: "{}" }),
            req({ url: "/api/none", status: undefined }),
          ],
        },
      ],
      options,
    );
    expect(analysis.bodies).toEqual([
      {
        stepId: "S1",
        method: "GET",
        url: "/api/cart?x=1",
        har: 0,
        status: 200,
        body: { total: 10, lines: [{ sku: "A" }], note: "***" },
      },
    ]);
    expect(analysis.endpoints).toEqual([
      {
        method: "GET",
        path: "/api/cart",
        status: 200,
        shape: "{lines:[{sku:string}],note:string,total:number}",
      },
      { method: "GET", path: "/api/big", status: 200 },
      { method: "GET", path: "/api/token", status: 200 },
      { method: "GET", path: "/api/text", status: 200 },
    ]);
    // Without the option no body is kept, whatever the page received.
    expect(
      analyzeTraffic([{ stepId: "S1", requests: [req({ url: "/api/cart", bodyText: "{}" })] }], {
        appSecure: false,
      }).bodies,
    ).toEqual([]);
    expect([shapeOf(null), shapeOf([]), shapeOf([1]), shapeOf(true)]).toEqual([
      "null",
      "[]",
      "[number]",
      "boolean",
    ]);
  });

  it("REQ-EVD-09/AC7: every request is linked to its HAR entry by order, method and URL", () => {
    const har = harRequests(
      JSON.stringify({
        log: {
          entries: [
            { request: { method: "GET", url: "http://127.0.0.1:3000/" } },
            { request: { method: "GET", url: "https://cdn.example/a.js?v=1" } },
            { request: { method: "POST", url: "http://127.0.0.1:3000/api/cart?x=1" } },
            { request: { method: "GET", url: "http://127.0.0.1:3000/" } },
            { request: { url: "not a url" } },
          ],
        },
      }),
    );
    expect(
      linkHar(
        [
          req({ url: "/", resourceType: "document" }),
          req({ url: "https://cdn.example/a.js", sameOrigin: false }),
          req({ url: "/api/cart?x=1", method: "POST" }),
          req({ url: "/never" }),
          req({ url: "/" }),
        ],
        har,
        "http://127.0.0.1:3000",
      ),
    ).toEqual([0, 1, 2, undefined, 3]);
    expect(harRequests("not json")).toEqual([]);
    expect(harRequests("{}")).toEqual([]);
  });

  it("REQ-EVD-09/AC5+AC4: what changed since the last run of the plan, and the steps that became much slower", () => {
    expect(
      diffNetwork(
        [
          { method: "GET", path: "/api/cart", status: 200, shape: "{total:number}" },
          { method: "GET", path: "/api/old", status: 200 },
          { method: "POST", path: "/api/orders", status: 201 },
          { method: "GET", path: "/api/same", status: 200, shape: "{a:number}" },
        ],
        [
          { method: "GET", path: "/api/cart", status: 200, shape: "{total:string}" },
          { method: "POST", path: "/api/orders", status: 500 },
          { method: "GET", path: "/api/new", status: 200 },
          { method: "GET", path: "/api/same", status: 200 },
        ],
      ),
    ).toEqual([
      {
        change: "shape",
        method: "GET",
        path: "/api/cart",
        before: "{total:number}",
        after: "{total:string}",
      },
      { change: "status", method: "POST", path: "/api/orders", before: "201", after: "500" },
      { change: "appeared", method: "GET", path: "/api/new", after: "200" },
      { change: "disappeared", method: "GET", path: "/api/old", before: "200" },
    ]);
    const step = (stepId: string, ms?: number) => ({
      stepId,
      requests: 1,
      bytes: 0,
      slowest: ms === undefined ? [] : [{ stepId, method: "GET", url: "/api/x", durationMs: ms }],
      warnings: [],
    });
    expect(
      comparePerformance(
        [step("S1", 300), step("S2", 300), step("S3", 100), step("S4")],
        [step("S1", 900), step("S2", 450), step("S3", 250), step("S4", 999), step("S5", 999)],
      ),
    ).toEqual(["S1: GET /api/x took 900 ms, 300 ms in the last run"]);
  });
});
