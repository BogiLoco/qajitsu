import type { SecretProvider } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

/**
 * Shared contract every SecretProvider passes (REQ-CFG-03, REQ-GEN-02).
 *
 * @param name - Provider name for test titles.
 * @param create - Builds the provider so that the given name/value pairs are resolvable.
 * @param prefix - Reference prefix, e.g. `secret://env/`.
 */
export function secretProviderContract(
  name: string,
  create: (secrets: Record<string, string>) => SecretProvider,
  prefix: string,
): void {
  describe(`SecretProvider contract: ${name}`, () => {
    it("REQ-CFG-03/AC1: resolves a secret:// reference to its value", async () => {
      const provider = create({ JIRA_TOKEN: "jira-token-value" });
      await expect(provider.resolve(`${prefix}JIRA_TOKEN`)).resolves.toBe("jira-token-value");
    });

    it("REQ-CFG-03: an unknown secret fails without revealing other values", async () => {
      const provider = create({ JIRA_TOKEN: "jira-token-value" });
      const error = await provider.resolve(`${prefix}MISSING`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error) + JSON.stringify(error)).not.toContain("jira-token-value");
    });

    it("honours an aborted signal", async () => {
      const provider = create({ A: "value-a" });
      await expect(provider.resolve(`${prefix}A`, AbortSignal.abort())).rejects.toThrow();
    });
  });
}
