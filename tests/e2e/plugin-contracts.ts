import type { AdapterDeps, DocumentSource, VectorStore } from "@qajitsu/core";
import { documentSourceContract } from "../contract/document-source.contract.js";
import { confluenceConfig, confluenceFixture } from "../support/confluence-fixture.js";
import { vectorStoreContract } from "../contract/vector-store.contract.js";
import { createFakeChroma } from "../support/fake-chroma.js";

/** The contract suite of one plugin that moved out, run against its installed copy (REQ-GEN-11/AC11). */
export interface PluginContract {
  readonly id: string;
  readonly run: (installed: <T>(id: string) => Promise<T>, scratch: (key: string) => string) => void;
}

/** Every plugin that moved out of the CLI, with its contract; a plugin pull request adds its row. */
export const pluginContracts: readonly PluginContract[] = [
  {
    id: "knowledge-lancedb",
    run: (installed, scratch) => {
      vectorStoreContract("lancedb (installed plugin)", async (key) =>
        (
          await installed<{ createLanceDbStore(dir: string): Promise<VectorStore> }>("knowledge-lancedb")
        ).createLanceDbStore(scratch(`lancedb-${key}`)),
      );
    },
  },
  {
    id: "knowledge-chroma",
    run: (installed) => {
      const server = createFakeChroma();
      vectorStoreContract("chroma (installed plugin)", async (key) =>
        (
          await installed<{
            createChromaStore(o: {
              url: string;
              token: string;
              collection: string;
              fetch: typeof fetch;
            }): Promise<VectorStore>;
          }>("knowledge-chroma")
        ).createChromaStore({
          url: "https://chroma.example.com",
          token: "t0ken",
          collection: `qajitsu-${key}`,
          fetch: server.fetch,
        }),
      );
    },
  },
  {
    id: "knowledge-confluence",
    run: (installed) => {
      documentSourceContract("confluence (installed plugin)", confluenceFixture, async (deps) =>
        (
          await installed<{
            createConfluenceSource(c: typeof confluenceConfig, d: AdapterDeps): DocumentSource;
          }>("knowledge-confluence")
        ).createConfluenceSource(confluenceConfig, deps),
      );
    },
  },
];
