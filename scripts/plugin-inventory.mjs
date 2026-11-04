// Plugin inventory check (REQ-GEN-14/AC5), run by `node scripts/requirements.mjs check` and `index`.
//
// docs/architecture/plugins.md lists every integration: one "### <Name>" entry with "- Field: value" lines. The check
// fails when an entry is incomplete, when a package under packages/adapters/ is not listed, or when a requirement
// names an integration (WATCHED_NAMES, matched as whole words with their case) that no entry lists in its Names.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAreaFile, slugify } from "./requirements.mjs";

export const INVENTORY_PATH = "docs/architecture/plugins.md";
export const PLUGIN_TYPES = [
  "ticket source",
  "test-case source",
  "publisher",
  "ticket workflow",
  "bug tracker",
  "code host",
  "runner",
  "environment provider",
  "device provider",
  "secret provider",
  "evidence store",
  "evidence archive",
  "knowledge store",
  "document source",
  "embedder",
  "message capture",
  "test data",
  "mock server",
  "model provider",
  "tool",
  "chain",
  "wallet",
  "telemetry",
  "pipeline",
];
export const PLUGIN_STATUSES = ["exists", "planned", "idea"];
export const TIERS = ["official open source", "official commercial", "partner", "community"];
export const PLACEMENTS = ["core", "plugin", "outside"];
const FIELDS = [
  "Type",
  "Interface",
  "Status",
  "Package",
  "Requirements",
  "Dependencies",
  "Hosts",
  "Secrets",
  "Tier",
  "Placement",
  "Names",
];
const OPTIONAL_FIELDS = ["Notes"];

/**
 * Integration names watched in the requirements. A requirement that uses one of them needs an inventory entry that
 * lists it in its Names. Add a name here when a requirement starts naming a new product.
 */
export const WATCHED_NAMES = [
  "Jira",
  "Data Center",
  "Xray",
  "Zephyr",
  "Zephyr Scale",
  "Zephyr Squad",
  "TestRail",
  "qTest",
  "Azure DevOps",
  "Azure Repos",
  "Linear",
  "GitHub",
  "GitHub Actions",
  "GitLab",
  "GitLab CI",
  "Bitbucket",
  "Gitea",
  "Jenkins",
  "Vault",
  "Doppler",
  "1Password",
  "AWS Secrets Manager",
  "GCP Secret Manager",
  "Azure Key Vault",
  "Infisical",
  "Bitwarden",
  "S3",
  "MinIO",
  "Object Lock",
  "Confluence",
  "Notion",
  "SharePoint",
  "Chroma",
  "LanceDB",
  "Qdrant",
  "pgvector",
  "webhook.site",
  "Mailpit",
  "Mailosaur",
  "Twilio",
  "BrowserStack",
  "Sauce Labs",
  "LambdaTest",
  "AWS Device Farm",
  "Firebase",
  "Firebase Test Lab",
  "k6",
  "Gatling",
  "JMeter",
  "Locust",
  "Lighthouse",
  "axe-core",
  "ZAP",
  "Pact",
  "Playwright",
  "WebdriverIO",
  "Appium",
  "Maestro",
  "Detox",
  "Espresso",
  "Selenium",
  "Cypress",
  "Postman",
  "FlaUI",
  "Electron",
  "Tauri",
  "Vercel",
  "Netlify",
  "Kubernetes",
  "Helm",
  "Argo CD",
  "Docker",
  "WireMock",
  "Wiremock",
  "Mockoon",
  "Prism",
  "Toxiproxy",
  "Kafka",
  "RabbitMQ",
  "MQTT",
  "Anthropic",
  "OpenAI",
  "Gemini",
  "Ollama",
  "LiteLLM",
  "OpenRouter",
  "Bedrock",
  "vLLM",
  "LM Studio",
  "Langfuse",
  "OpenTelemetry",
  "Prometheus",
  "Grafana",
  "Datadog",
  "Slack",
  "Microsoft Teams",
  "Figma",
  "Ethereum",
  "Solana",
  "Hardhat",
  "Foundry",
  "Anvil",
  "MetaMask",
  "Rabby",
  "Phantom",
  "Keplr",
  "WalletConnect",
];

const INDEX_START = "<!-- plugin-index:start -->";
const INDEX_END = "<!-- plugin-index:end -->";
const FIELD_LINE = /^- ([A-Z][a-z]+):\s*(.*)$/;
const REQ_ID = /^REQ-[A-Z]+-\d{2,3}$/;
const list = (value) =>
  value === undefined || value === "-" || value === ""
    ? []
    : value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

/**
 * Parses the inventory: one entry per "### " heading, its "- Field: value" lines, and the "## " section it is in.
 * @returns {{ entries: {name: string, section: string|undefined, line: number, fields: Record<string, string>}[], problems: string[] }}
 */
export function parseInventory(content, file = INVENTORY_PATH) {
  const entries = [];
  const problems = [];
  let section;
  let current;
  let inFence = false;
  content.split(/\r?\n/).forEach((line, i) => {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) return;
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      current = undefined;
      return;
    }
    if (line.startsWith("### ")) {
      current = { name: line.slice(4).trim(), section, line: i + 1, fields: {} };
      entries.push(current);
      return;
    }
    if (line.startsWith("# ")) current = undefined;
    if (!current) return;
    const m = FIELD_LINE.exec(line);
    if (!m) return;
    if (!FIELDS.includes(m[1]) && !OPTIONAL_FIELDS.includes(m[1])) {
      problems.push(`${file}:${String(i + 1)} ${current.name}: unknown field "${m[1]}"`);
      return;
    }
    current.fields[m[1].toLowerCase()] = m[2].trim();
  });
  return { entries, problems };
}

const nameRegex = (name) =>
  new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

/** One entry's own problems: fields, values, interfaces, packages and requirements. */
function entryProblems(e, ctx, file, known) {
  const at = `${file}:${String(e.line)} ${e.name}`;
  const problems = FIELDS.filter((f) => e.fields[f.toLowerCase()] === undefined).map(
    (f) => `${at}: missing "- ${f}:"`,
  );
  const { type, interface: iface, status, package: pkg, requirements, tier, placement } = e.fields;
  for (const t of list(type))
    if (!PLUGIN_TYPES.includes(t))
      problems.push(`${at}: unknown plugin type "${t}" (${PLUGIN_TYPES.join("|")})`);
  if (status !== undefined && !PLUGIN_STATUSES.includes(status))
    problems.push(`${at}: invalid status "${status}" (${PLUGIN_STATUSES.join("|")})`);
  if (tier !== undefined && !TIERS.includes(tier))
    problems.push(`${at}: invalid tier "${tier}" (${TIERS.join("|")})`);
  if (placement !== undefined && !PLACEMENTS.includes(placement))
    problems.push(`${at}: invalid placement "${placement}" (${PLACEMENTS.join("|")})`);
  // REQ-GEN-14/AC3: an interface is one @qajitsu/core exports, or a gap named "new <Name> ..." that needs an ADR.
  for (const i of list(iface))
    if (!i.startsWith("new ") && !ctx.interfaces.has(i))
      problems.push(`${at}: "${i}" is not an interface of @qajitsu/core (write "new <Name>" for a gap)`);
  const packages = list(pkg);
  for (const p of packages) if (!ctx.paths.has(p)) problems.push(`${at}: package ${p} does not exist`);
  if (status === "exists" && packages.length === 0)
    problems.push(`${at}: status exists but names no package`);
  const reqs = list(requirements);
  if (requirements !== undefined && reqs.length === 0) problems.push(`${at}: names no requirement`);
  for (const r of reqs)
    if (!REQ_ID.test(r) || !known.has(r)) problems.push(`${at}: unknown requirement ${r}`);
  return problems;
}

/**
 * Validates a parsed inventory against the repository.
 * @param {ReturnType<typeof parseInventory>} inventory
 * @param {{ adapterPackages: string[], paths: {has: (path: string) => boolean}, interfaces: Set<string>,
 *   requirements: {id: string, status: string|undefined, text: string}[], watchedNames: string[] }} ctx
 * @returns {string[]} problems
 */
export function validateInventory(inventory, ctx, file = INVENTORY_PATH) {
  const problems = [...inventory.problems];
  const known = new Set(ctx.requirements.map((r) => r.id));
  const seen = new Set();
  const owners = new Map();
  for (const e of inventory.entries) {
    if (seen.has(e.name)) problems.push(`${file}:${String(e.line)}: duplicate entry "${e.name}"`);
    seen.add(e.name);
    problems.push(...entryProblems(e, ctx, file, known));
    for (const n of list(e.fields.names)) {
      const owner = owners.get(n);
      if (owner !== undefined && owner !== e.name)
        problems.push(`${file}:${String(e.line)} ${e.name}: name "${n}" is listed by "${owner}" too`);
      else owners.set(n, e.name);
    }
  }
  const listed = new Set(inventory.entries.flatMap((e) => list(e.fields.package)));
  for (const p of ctx.adapterPackages)
    if (!listed.has(p)) problems.push(`${file}: integration package ${p} is missing from the inventory`);
  for (const name of ctx.watchedNames) {
    if (owners.has(name)) continue;
    const re = nameRegex(name);
    for (const r of ctx.requirements)
      if (r.status !== "deprecated" && re.test(r.text))
        problems.push(
          `${file}: ${r.id} names the integration "${name}", which is missing from the inventory (add it to the Names of an entry)`,
        );
  }
  return problems;
}

/** The summary table between the plugin-index markers. */
export function renderInventoryIndex(inventory) {
  const cell = (v) => (v ?? "?").replace(/\|/g, "\\|");
  return [
    "| Plugin | Type | Interface | Status | Placement | Tier |",
    "| --- | --- | --- | --- | --- | --- |",
    ...inventory.entries.map(
      (e) =>
        `| [${cell(e.name)}](#${slugify(e.name)}) | ${cell(e.fields.type)} | ${cell(e.fields.interface)} | ${cell(e.fields.status)} | ${cell(e.fields.placement)} | ${cell(e.fields.tier)} |`,
    ),
  ].join("\n");
}

/** The inventory with its summary table regenerated; undefined when the markers are missing. */
export function replaceInventoryIndex(content) {
  const start = content.indexOf(INDEX_START);
  const end = content.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  const table = renderInventoryIndex(parseInventory(content));
  return `${content.slice(0, start + INDEX_START.length)}\n${table}\n${content.slice(end)}`;
}

/**
 * Every problem of the inventory, including a missing file and a stale summary table.
 * @param {{ content: string|undefined, path: string } & Parameters<typeof validateInventory>[1]} loaded
 */
export function checkInventory(loaded) {
  const file = loaded.path;
  if (loaded.content === undefined)
    return [`${file}: missing; every integration package must be listed (REQ-GEN-14)`];
  const problems = validateInventory(parseInventory(loaded.content, file), loaded, file);
  const expected = replaceInventoryIndex(loaded.content);
  if (expected === undefined) problems.push(`${file}: must contain ${INDEX_START} and ${INDEX_END}`);
  else if (expected !== loaded.content)
    problems.push(`${file}: summary table is stale, run \`pnpm req:index\``);
  return problems;
}

const dirs = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

/** Reads the inventory, the packages, the core interfaces and the requirement texts from a repository root. */
export function loadInventory(root) {
  const path = join(root, INVENTORY_PATH);
  const content = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const adapterPackages = dirs(join(root, "packages", "adapters")).map((d) => `packages/adapters/${d}`);
  // A package is a directory of the repository: packages/..., or ci/... and plugin/ for what runs QAJitsu elsewhere.
  const paths = { has: (p) => !p.split("/").includes("..") && existsSync(join(root, p)) };
  const indexPath = join(root, "packages", "core", "src", "interfaces", "index.ts");
  const interfaces = new Set(
    existsSync(indexPath)
      ? [...readFileSync(indexPath, "utf8").matchAll(/export type \{([^}]*)\}/g)].flatMap((m) =>
          m[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : [],
  );
  const reqDir = join(root, "docs", "requirements");
  const requirements = [];
  for (const f of readdirSync(reqDir).filter(
    (n) => n.endsWith(".md") && n !== "README.md" && !n.startsWith("_"),
  )) {
    const text = readFileSync(join(reqDir, f), "utf8");
    const lines = text.split(/\r?\n/);
    const parsed = parseAreaFile(text, f).requirements;
    parsed.forEach((r, i) => {
      const end = parsed[i + 1]?.line ?? lines.length + 1;
      requirements.push({
        id: r.id,
        status: r.meta.status,
        text: lines.slice(r.line - 1, end - 1).join("\n"),
      });
    });
  }
  return {
    path: INVENTORY_PATH,
    content,
    adapterPackages,
    paths,
    interfaces,
    requirements,
    watchedNames: WATCHED_NAMES,
  };
}
