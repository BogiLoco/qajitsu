import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventLog, parseEventLines, type RunWorkspace } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { guardTools } from "./loop.js";
import { openMcpTools, type McpServers } from "./mcp.js";
import { stageGuard, type AgentStageDeps } from "./roles-run.js";
import { AGENT_ROLES } from "./roles.js";

const SECRET = "fictional-session-token-123";
const ORIGIN = "http://127.0.0.1:4000";

/**
 * A real MCP server over stdio (newline-delimited JSON-RPC): browser-like tools that log every call they receive
 * to `calls.log` in their working folder, so a test sees exactly what reached the server.
 */
const FAKE_SERVER = `
import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync("calls.log", line + "\\n");
log("argv " + JSON.stringify(process.argv.slice(2)));
log("env " + Object.keys(process.env).filter((k) => k.startsWith("QA") || k.includes("TOKEN")).join(","));
const tools = [
  { name: "browser_navigate", description: "Open a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", description: "Accessibility snapshot", inputSchema: { type: "object", properties: {} } },
  { name: "browser_take_screenshot", description: "Screenshot", inputSchema: { type: "object", properties: {} } },
  { name: "browser_evaluate", description: "Run JavaScript", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
];
let buffer = "";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize")
      send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-browser", version: "1.0.0" } } });
    else if (msg.method === "tools/list") send({ id: msg.id, result: { tools } });
    else if (msg.method === "tools/call") {
      log("call " + msg.params.name + " " + JSON.stringify(msg.params.arguments ?? {}));
      const name = msg.params.name;
      const content =
        name === "browser_take_screenshot"
          ? [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }]
          : name === "browser_snapshot"
            ? [{ type: "text", text: '- button "Pay" [ref=e1]\\n- text: session ${SECRET}' }]
            : [{ type: "text", text: "navigated to " + (msg.params.arguments?.url ?? "?") }];
      send({ id: msg.id, result: { content } });
    } else if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
});
`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const setup = async (servers?: McpServers) => {
  const root = await mkdtemp(join(tmpdir(), "qj-mcp-"));
  dirs.push(root);
  const runDir = join(root, "run");
  for (const d of ["results", "evidence", "specs", "journal"])
    await mkdir(join(runDir, d), { recursive: true });
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  const server = join(root, "fake-server.mjs");
  await writeFile(server, FAKE_SERVER);
  const lines: string[] = [];
  const mask = (text: string): string => text.replaceAll(SECRET, "***");
  const deps = {
    ws: { runId: "20261005-1000-aaaa", dir: runDir } as unknown as RunWorkspace,
    events: createEventLog({
      ticket: "DEMO-1",
      run: "r",
      write: (l) => {
        lines.push(l);
      },
      now: () => new Date(0),
      mask: (v) => v,
    }),
    now: () => new Date(0),
    maskJson: (v: unknown) => JSON.parse(mask(JSON.stringify(v))) as unknown,
    maskText: mask,
  } as unknown as AgentStageDeps;
  const config: McpServers = servers ?? {
    browser: {
      command: [process.execPath, server, "--allowed-origins", "{{allowed_origins}}"],
      roles: ["author"],
      tools: ["browser_navigate", "browser_snapshot", "browser_take_screenshot"],
      timeout_s: 20,
    },
  };
  const session = await openMcpTools({
    servers: config,
    role: "author",
    allowedOrigins: [ORIGIN],
    cwd: scratch,
    mask,
  });
  const role = AGENT_ROLES.find((r) => r.role === "author");
  if (!role) throw new Error("author role missing");
  const guard = stageGuard(deps, "author", role, {
    tools: session.tools.map((t) => t.name),
    networkTools: session.networkTools,
    allowedOrigins: [ORIGIN],
  });
  const tools = guardTools(session.tools, guard);
  const call = async (name: string, input: Record<string, unknown>): Promise<string> => {
    const t = tools[name];
    if (!t?.execute) return `NOT OFFERED: ${name}`;
    const execute = t.execute as (i: unknown, o: unknown) => Promise<unknown>;
    return String(await execute(input, { toolCallId: "c1", messages: [] }));
  };
  const calls = async () =>
    (await readFile(join(scratch, "calls.log"), "utf8").catch(() => "")).trim().split("\n");
  return { session, tools, call, calls, lines, runDir, scratch, guard };
};

describe("MCP tools for exploration (REQ-VER-03/AC3, REQ-EXEC-01/AC2)", () => {
  it("REQ-VER-03/AC3: only allowlisted MCP tools are offered, every call goes through the guard and is journaled", async () => {
    const { session, tools, call, calls, lines } = await setup();
    try {
      expect(Object.keys(tools).sort()).toEqual([
        "mcp__browser__browser_navigate",
        "mcp__browser__browser_snapshot",
        "mcp__browser__browser_take_screenshot",
      ]);
      expect(session.networkTools).toEqual(["mcp__browser__browser_navigate"]);
      expect(await call("mcp__browser__browser_navigate", { url: `${ORIGIN}/cart` })).toBe(
        `navigated to ${ORIGIN}/cart`,
      );
      expect(await call("mcp__browser__browser_navigate", { url: "https://evil.example.com/" })).toMatch(
        /^DENIED \(URL_NOT_ALLOWED\)/,
      );
      // Not on the allowlist: not offered to the model at all.
      expect(await call("mcp__browser__browser_evaluate", { code: "1" })).toBe(
        "NOT OFFERED: mcp__browser__browser_evaluate",
      );
      const received = (await calls()).filter((l) => l.startsWith("call "));
      expect(received).toEqual([`call browser_navigate {"url":"${ORIGIN}/cart"}`]);
      const events = parseEventLines(lines.join("\n")).events.map((e) => [
        e.event,
        (e.details as { tool?: string }).tool,
      ]);
      expect(events).toEqual([
        ["tool_allowed", "mcp__browser__browser_navigate"],
        ["tool_result", "mcp__browser__browser_navigate"],
        ["tool_denied", "mcp__browser__browser_navigate"],
      ]);
    } finally {
      await session.close();
    }
  });

  it("REQ-EXEC-01/AC2 + invariant 2: exploration output is masked, images are not stored, nothing lands in results/ or evidence/", async () => {
    const { session, call, runDir, lines } = await setup();
    try {
      const snapshot = await call("mcp__browser__browser_snapshot", {});
      expect(snapshot).toContain('button "Pay"');
      expect(snapshot).not.toContain(SECRET);
      expect(await call("mcp__browser__browser_take_screenshot", {})).toBe(
        "[image image/png: shown to the agent, not stored]",
      );
      expect(await readdir(join(runDir, "results"))).toEqual([]);
      expect(await readdir(join(runDir, "evidence"))).toEqual([]);
      expect(lines.join("\n")).not.toContain(SECRET);
    } finally {
      await session.close();
    }
  });

  it("REQ-VER-03/AC3 + invariant 10: the server gets the allowed origins, a minimal environment and its own scratch folder", async () => {
    process.env["QAJITSU_TEST_TOKEN"] = SECRET;
    try {
      const { session, calls, scratch } = await setup();
      await session.close();
      const log = await calls();
      expect(log[0]).toBe(`argv ["--allowed-origins","${ORIGIN}"]`);
      expect(log[1]).toBe("env");
      expect(await readdir(scratch)).toEqual(["calls.log"]);
    } finally {
      delete process.env["QAJITSU_TEST_TOKEN"];
    }
  });

  it("REQ-EXEC-01/AC2: servers of other roles are not started; a server that cannot start leaves the agent without its tools", async () => {
    const other = await setup({
      browser: {
        command: [process.execPath, "-e", "process.exit(0)"],
        roles: ["healer"],
        tools: ["x"],
        timeout_s: 5,
      },
    });
    expect(other.session.tools).toEqual([]);
    const broken = await setup({
      browser: {
        command: [join(tmpdir(), "no-such-mcp-server")],
        roles: ["author"],
        tools: ["x"],
        timeout_s: 5,
      },
    });
    expect(broken.session.tools).toEqual([]);
    expect(broken.session.unavailable).toEqual([
      { server: "browser", reason: expect.any(String) as unknown },
    ]);
  });
});
