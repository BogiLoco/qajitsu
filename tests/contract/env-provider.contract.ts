import type { EnvProvider } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

/**
 * Shared contract of every EnvProvider (REQ-GEN-02/AC3, REQ-ENV-01, REQ-ENV-03, ADR-0005): a started environment
 * answers on its base URL and is healthy; an application that is not up is never reported healthy; stop always
 * resolves with the logs it wrote.
 *
 * @param name - Implementation name for test titles.
 * @param up - A provider for an application that works, with a cleanup.
 * @param down - A provider for an application that is not up.
 * @param stopsApp - Whether `stop` takes the application down (a provided environment is left alone).
 */
export function envProviderContract(
  name: string,
  up: () => Promise<{ readonly provider: EnvProvider; readonly cleanup: () => Promise<void> }>,
  down: () => Promise<{ readonly provider: EnvProvider; readonly cleanup: () => Promise<void> }>,
  stopsApp: boolean,
): void {
  describe(`EnvProvider contract: ${name}`, () => {
    it("REQ-GEN-02/AC3 + REQ-ENV-01/AC1: a started environment is healthy and answers on its base URL", async () => {
      const { provider, cleanup } = await up();
      try {
        const handle = await provider.start();
        expect(handle.baseUrl).toMatch(/^https?:\/\/[^/]+$/);
        expect(handle.health.ok).toBe(true);
        expect((await fetch(`${handle.baseUrl}/health`)).ok).toBe(true);
        const stopped = await handle.stop();
        expect(Array.isArray(stopped.logs)).toBe(true);
        if (stopsApp) await expect(fetch(`${handle.baseUrl}/health`)).rejects.toThrow();
        else expect((await fetch(`${handle.baseUrl}/health`)).ok).toBe(true);
      } finally {
        await cleanup();
      }
    }, 60_000);

    it("REQ-GEN-02/AC3 + invariant 1: an application that is not up is never reported healthy", async () => {
      const { provider, cleanup } = await down();
      try {
        const healthy = await provider.start().then(
          async (handle) => {
            await handle.stop();
            return handle.health.ok;
          },
          () => false,
        );
        expect(healthy).toBe(false);
      } finally {
        await cleanup();
      }
    }, 60_000);
  });
}
