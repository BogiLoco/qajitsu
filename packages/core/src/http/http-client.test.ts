import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHttpClient } from "./http-client.js";

const make = (responses: (() => Response)[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return Promise.resolve(next());
  }) as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  const http = createHttpClient({
    service: "SVC",
    baseUrl: "https://api.example.com/v1",
    headers: () => Promise.resolve({ authorization: "Bearer t" }),
    fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { http, calls, sleeps };
};

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}): (() => Response) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

describe("http client (REQ-GEN-02)", () => {
  it("resolves paths against the base URL, sends auth headers and parses with Zod", async () => {
    const { http, calls } = make([json({ id: 1 })]);
    expect(await http.json("/items/1", z.object({ id: z.number() }))).toEqual({ id: 1 });
    expect(calls[0]?.url).toBe("https://api.example.com/v1/items/1");
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer t", accept: "application/json" });
  });

  it("retries 429 honouring retry-after, then succeeds", async () => {
    const { http, sleeps } = make([json({}, 429, { "retry-after": "2" }), json({}, 503), json({ ok: true })]);
    expect(await http.json("x", z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("gives up after the retry budget with RATE_LIMITED", async () => {
    const { http } = make([json({}, 429), json({}, 429), json({}, 429), json({}, 429)]);
    await expect(http.text("x")).rejects.toMatchObject({ code: "SVC_RATE_LIMITED" });
  });

  it.each([
    [401, "SVC_AUTH"],
    [403, "SVC_AUTH"],
    [404, "SVC_NOT_FOUND"],
    [500, "SVC_HTTP_ERROR"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const { http } = make([json({}, status)]);
    await expect(http.text("x")).rejects.toMatchObject({ code, context: { status } });
  });

  it("rejects malformed JSON and unexpected shapes", async () => {
    const { http } = make([() => new Response("<html>"), json({ id: "x" })]);
    await expect(http.json("x", z.object({}))).rejects.toMatchObject({ code: "SVC_MALFORMED" });
    await expect(http.json("x", z.object({ id: z.number() }))).rejects.toMatchObject({
      code: "SVC_MALFORMED",
    });
  });

  it("never sends credentials to another origin", async () => {
    const { http, calls } = make([json({})]);
    await expect(http.text("https://evil.example.org/steal")).rejects.toMatchObject({
      code: "SVC_FOREIGN_URL",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps network failures to UNREACHABLE and returns bytes", async () => {
    const failing = createHttpClient({
      service: "SVC",
      baseUrl: "https://api.example.com",
      headers: () => Promise.resolve({}),
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(failing.text("x")).rejects.toMatchObject({ code: "SVC_UNREACHABLE" });
    const { http } = make([() => new Response(new Uint8Array([1, 2]))]);
    expect(await http.bytes("https://api.example.com/v1/f")).toEqual(new Uint8Array([1, 2]));
  });

  it("stops when the signal is aborted, also while waiting to retry", async () => {
    const { http } = make([json({})]);
    await expect(http.text("x", { signal: AbortSignal.abort() })).rejects.toThrow();
    const controller = new AbortController();
    const real = createHttpClient({
      service: "SVC",
      baseUrl: "https://api.example.com",
      headers: () => Promise.resolve({}),
      fetch: () => {
        setTimeout(() => {
          controller.abort();
        }, 1);
        return Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "30" } }));
      },
    });
    await expect(real.text("x", { signal: controller.signal })).rejects.toThrow();
  });

  it("follows same-origin redirects and refuses cross-origin ones without sending credentials", async () => {
    const redirect =
      (location: string, status = 302) =>
      () =>
        new Response(null, { status, headers: { location } });
    const ok = make([redirect("/v1/moved"), json({ id: 2 })]);
    expect(await ok.http.json("x", z.object({ id: z.number() }))).toEqual({ id: 2 });
    expect(ok.calls[1]?.url).toBe("https://api.example.com/v1/moved");
    expect(ok.calls[0]?.init.redirect).toBe("manual");

    const foreign = make([redirect("https://attacker.example.org/steal"), json({})]);
    await expect(foreign.http.text("x")).rejects.toMatchObject({ code: "SVC_FOREIGN_URL" });
    expect(foreign.calls).toHaveLength(1);

    const loop = make(Array.from({ length: 10 }, () => redirect("/v1/again", 307)));
    await expect(loop.http.text("x")).rejects.toMatchObject({ code: "SVC_HTTP_ERROR" });

    const seeOther = make([redirect("/v1/result", 303), json({})]);
    await seeOther.http.text("x", { method: "POST", body: "payload" });
    expect(seeOther.calls[1]?.init).toMatchObject({ method: "GET" });
    expect(seeOther.calls[1]?.init.body).toBeUndefined();
  });

  it("follows a cross-origin redirect only when asked, and then without credentials", async () => {
    const calls: { url: string; headers: unknown }[] = [];
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, headers: init?.headers });
      if (url.startsWith("https://api.example.com"))
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://media.example.org/file?sig=1" } }),
        );
      return Promise.resolve(new Response(new Uint8Array([7])));
    }) as typeof globalThis.fetch;
    const http = createHttpClient({
      service: "SVC",
      baseUrl: "https://api.example.com",
      headers: () => Promise.resolve({ authorization: "Bearer secret" }),
      fetch,
    });
    await expect(http.bytes("/attachment/1")).rejects.toMatchObject({ code: "SVC_FOREIGN_URL" });
    expect(
      await http.bytes("/attachment/1", {
        anonymousCrossOriginRedirect: true,
        anonymousRedirectHosts: ["example.org"],
      }),
    ).toEqual(new Uint8Array([7]));
    await expect(
      http.bytes("/attachment/1", {
        anonymousCrossOriginRedirect: true,
        anonymousRedirectHosts: ["other.net"],
      }),
    ).rejects.toMatchObject({ code: "SVC_FOREIGN_URL" });
    expect(calls).toContainEqual({ url: "https://media.example.org/file?sig=1", headers: undefined });
    expect(calls.filter((c) => c.url.startsWith("https://media.example.org"))).toHaveLength(1);
  });
});
