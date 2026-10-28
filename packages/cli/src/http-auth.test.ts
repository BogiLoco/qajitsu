import { describe, expect, it } from "vitest";
import { httpCredentialsFor, testHeadersFor } from "./http-auth.js";

const env = (profile: Record<string, unknown>) =>
  ({ profile: { test_headers: {}, ...profile } }) as unknown as Parameters<typeof testHeadersFor>[0];
const resolve = (ref: string) => Promise.resolve(`resolved(${ref})`);

describe("environment test mechanisms (REQ-EXEC-61/AC5, REQ-EXEC-55/AC4)", () => {
  it("REQ-EXEC-55/AC4: test headers resolve secret references and keep plain values", async () => {
    expect(
      await testHeadersFor(
        env({ test_headers: { "X-Captcha-Bypass": "secret://vault/staging#bypass", "X-Test-Mode": "1" } }),
        resolve,
      ),
    ).toEqual({ "X-Captcha-Bypass": "resolved(secret://vault/staging#bypass)", "X-Test-Mode": "1" });
    expect(await testHeadersFor(env({}), resolve)).toEqual({});
  });

  it("REQ-EXEC-61/AC5: HTTP authentication takes its password from the secret provider", async () => {
    expect(
      await httpCredentialsFor(env({ http_auth: { username: "qa", password: "secret://vault/x" } }), resolve),
    ).toEqual({ username: "qa", password: "resolved(secret://vault/x)" });
    expect(await httpCredentialsFor(env({}), resolve)).toBeUndefined();
  });
});
