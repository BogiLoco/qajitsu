import { createSign } from "node:crypto";
import { AdapterError, type HttpClient } from "@qajitsu/core";
import { z } from "zod";

const base64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/**
 * Builds the RS256 JWT a GitHub App uses to request installation tokens.
 *
 * @param appId - GitHub App id.
 * @param privateKeyPem - App private key (PEM).
 * @param now - Current time.
 */
export function createAppJwt(appId: string, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  try {
    return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
  } catch {
    throw new AdapterError("GITHUB_APP_KEY_INVALID", "The GitHub App private key cannot sign a token.", {
      appId,
    });
  }
}

const InstallationTokenSchema = z.object({ token: z.string(), expires_at: z.string() });

/**
 * Returns a cached installation token provider for a GitHub App (REQ-CTX-02/AC3).
 *
 * @param options - App ids, private key resolver, an HTTP client without auth and the clock.
 */
export function createInstallationTokenProvider(options: {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: () => Promise<string>;
  readonly http: HttpClient;
  readonly now: () => Date;
  /** Registers minted tokens and JWTs with the masker (invariant 8). */
  readonly registerSecret: (value: string) => void;
}): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    const now = options.now().getTime();
    if (cached && cached.expiresAt - 60_000 > now) return cached.token;
    const jwt = createAppJwt(options.appId, await options.privateKey(), options.now());
    options.registerSecret(jwt);
    const result = await options.http.json(
      `/app/installations/${options.installationId}/access_tokens`,
      InstallationTokenSchema,
      { method: "POST", headers: { authorization: `Bearer ${jwt}` } },
    );
    options.registerSecret(result.token);
    cached = { token: result.token, expiresAt: Date.parse(result.expires_at) };
    return result.token;
  };
}
