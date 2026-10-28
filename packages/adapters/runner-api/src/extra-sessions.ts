import type { EvidenceItem, UiDriver } from "@qajitsu/steps";
import type { AttemptInput } from "./attempt.js";
import type { BrowserFactory, BrowserSession } from "./sandbox.js";

/**
 * The further browser sessions of an attempt (REQ-EXEC-62): each a browser of its own from the same factory, so
 * cookies and storage never mix; closed with the attempt, their evidence named after the session (`buyer-video.webm`).
 */
export function extraSessions(
  factory: BrowserFactory | undefined,
  input: AttemptInput,
): {
  readonly open: ((name: string) => Promise<UiDriver>) | undefined;
  readonly close: (failed: boolean) => Promise<EvidenceItem[]>;
} {
  const opened: [string, BrowserSession][] = [];
  return {
    open: factory
      ? (name) => {
          const session = factory(input);
          opened.push([name, session]);
          return session.driver();
        }
      : undefined,
    close: async (failed) => {
      const items: EvidenceItem[] = [];
      for (const [name, session] of opened) {
        const media = await session.close(failed).catch(() => [] as EvidenceItem[]);
        items.push(...media.map((m) => ({ ...m, name: `${name}-${m.name}` })));
      }
      return items;
    },
  };
}
