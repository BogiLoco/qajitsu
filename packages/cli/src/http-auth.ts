import type { ResolvedEnvironment } from "@qajitsu/core";

/**
 * HTTP authentication of an environment for the browser and the API client (REQ-EXEC-61/AC5): the user name as written
 * and the password from the secret provider, registered with the masker by the resolver.
 */
export async function httpCredentialsFor(
  env: Pick<ResolvedEnvironment, "profile">,
  resolveSecret: (reference: string) => Promise<string>,
): Promise<{ username: string; password: string } | undefined> {
  const auth = env.profile.http_auth;
  if (!auth) return undefined;
  return { username: auth.username, password: await resolveSecret(auth.password) };
}
