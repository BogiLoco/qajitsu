import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { jsonSchema, type JSONSchema7 } from "ai";
import type { AgentTool } from "./loop.js";

/** One MCP server from `mcp.servers` in the project config. */
export interface McpServerConfig {
  /** Command and arguments (no shell); `{{allowed_origins}}` becomes the environment allowlist joined by `;`. */
  readonly command: readonly string[];
  /** Agent roles that get its tools. */
  readonly roles: readonly string[];
  /** Tools of the server the agents may call; everything else is neither offered nor allowed. */
  readonly tools: readonly string[];
  readonly timeout_s: number;
}

/** `mcp.servers` by name. */
export type McpServers = Readonly<Record<string, McpServerConfig>>;

/** What a stage gets from its MCP servers. */
export interface McpSession {
  /** Allowlisted tools as agent tools, named `mcp__<server>__<tool>`. */
  readonly tools: readonly AgentTool[];
  /** Tools with a `url` input; the guard checks it against the environment allowlist. */
  readonly networkTools: readonly string[];
  /** Servers that could not start; the stage runs without their tools. */
  readonly unavailable: readonly { readonly server: string; readonly reason: string }[];
  close(): Promise<void>;
}

/** The part of an MCP client QAJitsu uses (replaced in tests). */
export interface McpClientLike {
  listTools(): Promise<{
    readonly tools: readonly {
      readonly name: string;
      readonly description?: string | undefined;
      readonly inputSchema: unknown;
    }[];
  }>;
  callTool(args: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly options?: { readonly signal?: AbortSignal; readonly timeout?: number };
  }): Promise<{ readonly content?: unknown; readonly isError?: boolean | undefined }>;
  close(): Promise<void>;
}

/** Longest tool output handed back to the model. */
const MAX_OUTPUT = 20_000;

const connectStdio = async (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<McpClientLike> => {
  // No custom environment: the transport passes only HOME, LOGNAME, PATH, SHELL, TERM and USER, so no secret of
  // this process reaches the server. stderr is dropped: it is not journaled and must not reach the terminal raw.
  const transport = new StdioMCPTransport({ command, args: [...args], cwd, stderr: "ignore" });
  const client = await createMCPClient({ transport });
  return {
    listTools: async () => {
      const listed = await client.listTools();
      return {
        tools: listed.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    },
    callTool: async ({ name, arguments: input, options }) => {
      const result: Record<string, unknown> = await client.callTool({
        name,
        arguments: input,
        options: {
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeout ? { timeout: options.timeout } : {}),
        },
      });
      return { content: result["content"], isError: result["isError"] === true };
    },
    close: () => client.close(),
  };
};

/** Turns MCP tool content into text for the model; images and resources are described, never stored. */
const toText = (result: { readonly content?: unknown; readonly isError?: boolean | undefined }): string => {
  const items = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : [];
  const text = items
    .map((item) => {
      if (item["type"] === "text" && typeof item["text"] === "string") return item["text"];
      if (item["type"] === "image")
        return `[image ${typeof item["mimeType"] === "string" ? item["mimeType"] : ""}: shown to the agent, not stored]`;
      if (item["type"] === "resource" || item["type"] === "resource_link") return "[resource: not stored]";
      return `[${typeof item["type"] === "string" ? item["type"] : "content"}]`;
    })
    .join("\n");
  const bounded = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
  return result.isError === true ? `ERROR: ${bounded}` : bounded;
};

const hasUrlInput = (schema: unknown): boolean =>
  typeof schema === "object" &&
  schema !== null &&
  typeof (schema as { properties?: unknown }).properties === "object" &&
  (schema as { properties: Record<string, unknown> | null }).properties !== null &&
  "url" in (schema as { properties: Record<string, unknown> }).properties;

/**
 * Starts the MCP servers configured for a role and exposes their allowlisted tools as agent tools (REQ-EXEC-01,
 * REQ-VER-03/AC3). Every tool goes through `guardTools` like any other: the guard allows only these names, checks
 * `url` inputs against the environment allowlist and journals each call. Output is masked and bounded; images are
 * described to the model but never written anywhere, so exploration produces no results or evidence
 * (REQ-EXEC-01/AC2). A server that cannot start is reported and the stage continues without it.
 *
 * @param options - Servers, the role, the environment allowlist, the server working folder and the masker.
 */
export async function openMcpTools(options: {
  readonly servers: McpServers;
  readonly role: string;
  readonly allowedOrigins: readonly string[];
  /** Working folder of the servers: a scratch folder outside `results/` and `evidence/`. */
  readonly cwd: string;
  readonly mask: (text: string) => string;
  readonly connect?: (command: string, args: readonly string[], cwd: string) => Promise<McpClientLike>;
}): Promise<McpSession> {
  const connect = options.connect ?? connectStdio;
  const clients: McpClientLike[] = [];
  const tools: AgentTool[] = [];
  const networkTools: string[] = [];
  const unavailable: { server: string; reason: string }[] = [];
  for (const [server, config] of Object.entries(options.servers)) {
    if (!config.roles.includes(options.role)) continue;
    const [command = "", ...rawArgs] = config.command;
    const args = rawArgs.map((a) => a.replaceAll("{{allowed_origins}}", options.allowedOrigins.join(";")));
    let client: McpClientLike;
    let listed: Awaited<ReturnType<McpClientLike["listTools"]>>;
    try {
      client = await connect(command, args, options.cwd);
      clients.push(client);
      listed = await client.listTools();
    } catch (error) {
      unavailable.push({
        server,
        reason: options.mask(error instanceof Error ? error.message : String(error)),
      });
      continue;
    }
    const allowed = new Set(config.tools);
    for (const t of listed.tools) {
      if (!allowed.has(t.name)) continue;
      const name = `mcp__${server}__${t.name}`;
      if (hasUrlInput(t.inputSchema)) networkTools.push(name);
      const remote = client;
      tools.push({
        name,
        description: `${t.description ?? t.name} (MCP server '${server}'; exploration only, never test execution)`,
        inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema as JSONSchema7),
        async execute(input, signal) {
          const result = await remote.callTool({
            name: t.name,
            arguments: input,
            options: { ...(signal ? { signal } : {}), timeout: config.timeout_s * 1000 },
          });
          return options.mask(toText(result));
        },
      });
    }
  }
  return {
    tools,
    networkTools,
    unavailable,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    },
  };
}
