import type { ModelProvider } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

/**
 * Shared contract of every ModelProvider (REQ-GEN-02/AC3, REQ-LLM-01..03, ADR-0005).
 *
 * @param name - Implementation name for test titles.
 * @param create - Builds a provider whose roles are `{ default: <defaultRef>, planner: <plannerRef> }`.
 * @param refs - The configured references and an API key value that must never appear in errors.
 */
export function modelProviderContract(
  name: string,
  create: () => ModelProvider,
  refs: { readonly defaultRef: string; readonly plannerRef: string; readonly apiKey: string },
): void {
  describe(`ModelProvider contract: ${name}`, () => {
    it("REQ-GEN-02/AC3 + REQ-LLM-02/AC1: a role resolves to its model; roles without one use default", async () => {
      const provider = create();
      expect((await provider.forRole("planner")).id).toBe(refs.plannerRef);
      expect((await provider.forRole("analyst")).id).toBe(refs.defaultRef);
    });

    it("REQ-GEN-02/AC3 + REQ-LLM-03/AC1: a resolved model has a handle and a capability profile", async () => {
      const resolved = await create().resolve(refs.defaultRef);
      expect(resolved.model).toBeDefined();
      expect(resolved.profile).toEqual(
        expect.objectContaining({
          tools: expect.any(Boolean) as unknown,
          structuredOutput: expect.any(Boolean) as unknown,
          vision: expect.any(Boolean) as unknown,
          contextWindow: expect.any(Number) as unknown,
        }),
      );
      expect(resolved.profile.contextWindow).toBeGreaterThan(0);
    });

    it("REQ-GEN-02/AC3 + invariant 8: an unknown provider is a configuration error without the API key", async () => {
      const error = await create()
        .resolve("nope/x")
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "MODEL_PROVIDER_UNKNOWN" });
      expect(JSON.stringify(error) + String(error)).not.toContain(refs.apiKey);
    });
  });
}
