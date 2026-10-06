import {
  AdapterError,
  createHttpClient,
  type AdapterDeps,
  type DocumentSource,
  type RemoteDocument,
} from "@qajitsu/core";
import { z } from "zod";

/** Where and how to read Confluence. */
export interface ConfluenceConfig {
  /** Confluence base URL: `https://<site>.atlassian.net/wiki` (Cloud) or the Data Center URL. */
  readonly baseUrl: string;
  /** `cloud`: e-mail + API token (basic); `datacenter`: personal access token (bearer). */
  readonly flavor: "cloud" | "datacenter";
  /** `secret://` reference of the account e-mail (Cloud). */
  readonly email?: string | undefined;
  /** `secret://` reference of the token. */
  readonly token: string;
  readonly space: string;
  /** A page id: only this page and its descendants instead of the whole space. */
  readonly page?: string | undefined;
}

const PAGE_SIZE = 100;
/** Pages read from one source at most; a larger space should be narrowed to a page tree. */
export const MAX_PAGES = 5_000;

const PageSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.object({ number: z.number().int(), when: z.string().optional() }),
});
const ListSchema = z.object({ results: z.array(PageSchema), size: z.number().int().optional() });
const BodySchema = PageSchema.extend({
  body: z.object({ storage: z.object({ value: z.string() }) }),
});

/**
 * DocumentSource for a Confluence space or page tree (REQ-KNOW-12/AC1) over the REST API (`/rest/api/content`, the
 * same on Cloud and Data Center). Listing carries page versions without bodies; `load` fetches one page's storage
 * format (XHTML), which the knowledge base reads as HTML. Credentials come from secret references and are never
 * logged.
 *
 * @param config - Base URL, flavor, secret references and the space or page.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 * @example
 * const source = createConfluenceSource({ baseUrl, flavor: "cloud", email, token, space: "SHOP" }, deps);
 */
export function createConfluenceSource(config: ConfluenceConfig, deps: AdapterDeps): DocumentSource {
  if (!/^[A-Za-z0-9~_]{1,64}$/.test(config.space))
    throw new AdapterError("CONFLUENCE_SPACE_INVALID", "Invalid Confluence space key.", {});
  if (config.page !== undefined && !/^\d{1,20}$/.test(config.page))
    throw new AdapterError("CONFLUENCE_PAGE_INVALID", "A Confluence page id is a number.", {});
  const http = createHttpClient({
    service: "CONFLUENCE",
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    fetch: deps.fetch,
    headers: async () => {
      const token = await deps.resolveSecret(config.token);
      deps.registerSecret(token);
      if (config.flavor === "datacenter") return { authorization: `Bearer ${token}` };
      if (config.email === undefined)
        throw new AdapterError(
          "CONFLUENCE_AUTH_MISSING",
          "Confluence Cloud needs an e-mail and a token.",
          {},
        );
      const email = await deps.resolveSecret(config.email);
      return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
    },
  });
  const toDocument = (p: z.infer<typeof PageSchema>): RemoteDocument => ({
    id: p.id,
    title: p.title,
    version: String(p.version.number),
    modifiedAt: p.version.when ?? new Date(0).toISOString(),
  });
  const paged = async (path: string, signal?: AbortSignal): Promise<RemoteDocument[]> => {
    const out: RemoteDocument[] = [];
    for (let start = 0; start < MAX_PAGES; start += PAGE_SIZE) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await http.json(
        `${path}${sep}expand=version&limit=${String(PAGE_SIZE)}&start=${String(start)}`,
        ListSchema,
        {
          signal,
        },
      );
      out.push(...page.results.map(toDocument));
      if (page.results.length < PAGE_SIZE) break;
    }
    return out;
  };
  return {
    async list(signal) {
      if (config.page === undefined)
        return paged(`/rest/api/content?spaceKey=${encodeURIComponent(config.space)}&type=page`, signal);
      const root = await http.json(`/rest/api/content/${config.page}?expand=version`, PageSchema, { signal });
      return [toDocument(root), ...(await paged(`/rest/api/content/${config.page}/descendant/page`, signal))];
    },
    async load(document, signal) {
      if (!/^\d{1,20}$/.test(document.id))
        throw new AdapterError("CONFLUENCE_PAGE_INVALID", "A Confluence page id is a number.", {});
      const page = await http.json(
        `/rest/api/content/${document.id}?expand=body.storage,version`,
        BodySchema,
        {
          signal,
        },
      );
      // The title becomes the top heading, so sections read "Page title > Heading".
      return {
        format: "html",
        text: `<h1>${page.title.replace(/</g, "&lt;")}</h1>\n${page.body.storage.value}`,
      };
    },
  };
}
