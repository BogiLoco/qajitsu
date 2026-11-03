import type { AdapterDeps, DocumentSource, SecretProvider, VectorStore } from "@qajitsu/core";
import { documentSourceContract } from "../contract/document-source.contract.js";
import { confluenceConfig, confluenceFixture } from "../support/confluence-fixture.js";
import { vectorStoreContract } from "../contract/vector-store.contract.js";
import { secretProviderContract } from "../contract/secret-provider.contract.js";
import { createFakeChroma } from "../support/fake-chroma.js";
import { createFakeFetch, jsonReply } from "../support/fake-fetch.js";

/** The contract suite of one plugin that moved out, run against its installed copy (REQ-GEN-11/AC11). */
export interface PluginContract {
  readonly id: string;
  readonly run: (installed: <T>(id: string) => Promise<T>, scratch: (key: string) => string) => void;
}

/** A provider whose installed plugin loads on first use: the contracts build providers synchronously. */
const lazy = (make: () => Promise<SecretProvider>, scheme = "plugin"): SecretProvider => {
  let p: Promise<SecretProvider> | undefined;
  return { scheme, resolve: async (ref, signal) => (await (p ??= make())).resolve(ref, signal) };
};

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
  {
    id: "secrets-vault",
    run: (installed) => {
      const TOKEN = "fictional-vault-token";
      secretProviderContract(
        "vault (installed plugin)",
        (secrets) => {
          const fake = createFakeFetch([
            {
              method: "GET",
              match: /^\/v1\/kv\/data\/ci\/qajitsu$/,
              reply: (r) =>
                r.headers["x-vault-token"] === TOKEN
                  ? jsonReply({ data: { data: secrets, metadata: { version: 3 } } })(r)
                  : jsonReply({ errors: ["permission denied"] }, 403)(r),
            },
            { method: "GET", match: /^\/v1\/kv\/data\//, reply: jsonReply({ errors: [] }, 404) },
          ]);
          return lazy(async () =>
            (
              await installed<{
                createVaultSecretProvider(o: {
                  address: string;
                  mount: string;
                  token: () => Promise<string>;
                  fetch: typeof fetch;
                }): SecretProvider;
              }>("secrets-vault")
            ).createVaultSecretProvider({
              address: "https://vault.example.com",
              mount: "kv",
              token: () => Promise.resolve(TOKEN),
              fetch: fake.fetch,
            }),
          );
        },
        "secret://vault/ci/qajitsu#",
      );
    },
  },
];
