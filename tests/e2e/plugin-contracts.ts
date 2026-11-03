import type {
  AdapterDeps,
  DocumentSource,
  EvidenceArchive,
  MessageCapture,
  SecretProvider,
  TestCaseSource,
  VectorStore,
} from "@qajitsu/core";
import { testCaseSourceContract } from "../contract/test-case-source.contract.js";
import { xrayConfig, xrayFixture } from "../support/xray-fixture.js";
import { evidenceArchiveContract } from "../contract/evidence-archive.contract.js";
import { messageCaptureContract } from "../contract/message-capture.contract.js";
import { webhookSiteConfig, webhookSiteFixture } from "../support/webhook-site-fixture.js";
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
  {
    id: "secrets-doppler",
    run: (installed) => {
      const TOKEN = "dp.st.fictional-token";
      secretProviderContract(
        "doppler (installed plugin)",
        (secrets) => {
          const fake = createFakeFetch([
            {
              method: "GET",
              match: /^\/v3\/configs\/config\/secrets\/download\?/,
              reply: (r) =>
                r.headers["authorization"] === `Bearer ${TOKEN}`
                  ? jsonReply(secrets)(r)
                  : jsonReply({ messages: ["Invalid token"] }, 401)(r),
            },
          ]);
          return lazy(async () =>
            (
              await installed<{
                createDopplerSecretProvider(o: {
                  token: () => Promise<string>;
                  project: string;
                  config: string;
                  fetch: typeof fetch;
                }): SecretProvider;
              }>("secrets-doppler")
            ).createDopplerSecretProvider({
              token: () => Promise.resolve(TOKEN),
              project: "shop",
              config: "ci",
              fetch: fake.fetch,
            }),
          );
        },
        "secret://doppler/",
      );
    },
  },
  {
    id: "secrets-cli",
    run: (installed) => {
      type Exec = (
        command: string,
        args: readonly string[],
        options: { env: Record<string, string> },
      ) => Promise<string>;
      const cli = () =>
        installed<{
          createOnePasswordSecretProvider(o: { env: Record<string, string>; exec: Exec }): SecretProvider;
        }>("secrets-cli");
      secretProviderContract(
        "op (installed plugin)",
        (secrets) => {
          const exec: Exec = (_command, args) => {
            const value = secrets[String(args.at(-1)).split("/").at(-1) ?? ""];
            return value === undefined
              ? Promise.reject(new Error("op exited with 1"))
              : Promise.resolve(value);
          };
          return lazy(async () =>
            (await cli()).createOnePasswordSecretProvider({ env: { PATH: "/usr/bin" }, exec }),
          );
        },
        "secret://op/QA/jira/",
      );
    },
  },
  {
    id: "messages-webhooksite",
    run: (installed) => {
      messageCaptureContract("webhook.site (installed plugin)", webhookSiteFixture, async (deps) =>
        (
          await installed<{
            createWebhookSiteCapture(c: typeof webhookSiteConfig, d: AdapterDeps): MessageCapture;
          }>("messages-webhooksite")
        ).createWebhookSiteCapture(webhookSiteConfig, deps),
      );
    },
  },
  {
    id: "evidence-s3",
    run: (installed) => {
      evidenceArchiveContract("s3 (installed plugin)", async (t) =>
        (
          await installed<{
            createS3Archive(
              c: { endpoint: string; region: string; bucket: string; pathStyle: boolean },
              d: {
                fetch: typeof fetch;
                now: () => Date;
                credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
              },
            ): EvidenceArchive;
          }>("evidence-s3")
        ).createS3Archive(
          { endpoint: t.endpoint, region: "us-east-1", bucket: t.bucket, pathStyle: true },
          {
            fetch: globalThis.fetch,
            now: () => new Date(),
            credentials: () => Promise.resolve(t.credentials),
          },
        ),
      );
    },
  },
  {
    id: "testcases",
    run: (installed) => {
      testCaseSourceContract("xray (installed plugin)", xrayFixture, async (deps) =>
        (
          await installed<{ createXrayCaseSource(c: typeof xrayConfig, d: AdapterDeps): TestCaseSource }>(
            "testcases",
          )
        ).createXrayCaseSource(xrayConfig, deps),
      );
    },
  },
];
