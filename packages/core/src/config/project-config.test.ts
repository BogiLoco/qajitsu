import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { parseProjectConfig } from "./project-config.js";

const valid = {
  project: "shop",
  jira: {
    project_key: "SHOP",
    base_url: "https://jira.example.com",
    email: "secret://env/JIRA_EMAIL",
    token: "secret://env/JIRA_TOKEN",
  },
  code_hosts: {
    github: { type: "github", token: "secret://env/GITHUB_TOKEN" },
    gitlab: { type: "gitlab", base_url: "https://gitlab.example.com", token: "secret://env/GITLAB_TOKEN" },
  },
  repos: {
    backend: { host: "gitlab", path: "acme/shop-backend" },
    web: { host: "github", path: "acme/shop-web", default_ref: "develop" },
  },
};

describe("parseProjectConfig (REQ-GEN-01, REQ-CTX-02)", () => {
  it("accepts a GitHub + GitLab project and applies defaults", () => {
    const config = parseProjectConfig(valid);
    expect(config.repos["backend"]?.default_ref).toBe("main");
    expect(config.test_types).toEqual(["api"]);
    expect(config.change_discovery).toContain("jira_dev_panel");
  });

  it("rejects plain-text tokens (REQ-CFG-03)", () => {
    const raw = { ...valid, code_hosts: { github: { type: "github", token: "ghp_plain" } }, repos: {} };
    expect(() => parseProjectConfig(raw)).toThrow(ConfigError);
  });

  it("rejects unknown keys so typos surface early", () => {
    expect(() => parseProjectConfig({ ...valid, jria: {} })).toThrow(/Invalid configuration/);
  });

  it("lists every issue with its path", () => {
    try {
      parseProjectConfig({ project: "Shop", jira: {} }, "test.yaml");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).context["issues"] as string[];
      expect(issues.some((i) => i.startsWith("project:"))).toBe(true);
      expect(issues.some((i) => i.startsWith("jira.project_key:"))).toBe(true);
    }
  });

  it("rejects repos pointing at an undefined code host", () => {
    const raw = { ...valid, repos: { x: { host: "bitbucket", path: "a/b" } } };
    expect(() => parseProjectConfig(raw)).toThrow(ConfigError);
  });

  it("REQ-CFG-03/AC1: rejects a plain-text Jira token", () => {
    const raw = { ...valid, jira: { ...valid.jira, token: "plain-api-token" } };
    const error = (() => {
      try {
        parseProjectConfig(raw);
        return undefined;
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(error?.context["issues"]).toEqual(["jira.token: Expected a secret:// reference"]);
  });

  it("REQ-CTX-01: Jira Cloud needs base_url, email and token; file mode needs tickets_dir", () => {
    expect(() => parseProjectConfig({ ...valid, jira: { project_key: "SHOP" } })).toThrow(ConfigError);
    try {
      parseProjectConfig({ ...valid, jira: { type: "file", project_key: "SHOP" } });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).context["issues"]).toEqual([
        "jira.tickets_dir: Required when jira.type is 'file'",
      ]);
    }
    const file = parseProjectConfig({
      ...valid,
      jira: { type: "file", project_key: "SHOP", tickets_dir: "../t" },
    });
    expect(file.jira.type).toBe("file");
  });

  it("REQ-WS-01/AC4: workspace root is optional and defaults later to the home directory", () => {
    expect(parseProjectConfig(valid).workspace).toEqual({});
    expect(parseProjectConfig({ ...valid, workspace: { root: "~/runs" } }).workspace.root).toBe("~/runs");
  });

  it("REQ-CTX-02/AC3: a GitHub host authenticates with a token or a GitHub App, never both", () => {
    const app = { app_id: 123, installation_id: "456", private_key: "secret://env/GH_APP_KEY" };
    const withApp = parseProjectConfig({
      ...valid,
      code_hosts: { ...valid.code_hosts, github: { type: "github", app } },
    });
    expect(withApp.code_hosts["github"]?.app).toEqual({ ...app, app_id: "123" });
    expect(() =>
      parseProjectConfig({
        ...valid,
        code_hosts: { ...valid.code_hosts, github: { type: "github", app, token: "secret://env/T" } },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      parseProjectConfig({ ...valid, code_hosts: { ...valid.code_hosts, gitlab: { type: "gitlab", app } } }),
    ).toThrow(ConfigError);
  });

  it("REQ-NFR-04: a local code host needs a root and takes no credentials", () => {
    const local = parseProjectConfig({
      ...valid,
      code_hosts: { ...valid.code_hosts, local: { type: "local", root: "~/.qa-demo/git" } },
    });
    expect(local.code_hosts["local"]?.root).toBe("~/.qa-demo/git");
    for (const bad of [
      { type: "local" },
      { type: "local", root: "x", token: "secret://env/T" },
      { type: "github", root: "x", token: "secret://env/T" },
    ]) {
      expect(() => parseProjectConfig({ ...valid, code_hosts: { ...valid.code_hosts, bad } })).toThrow(
        ConfigError,
      );
    }
  });

  it("REQ-WS-01: repo and host aliases are safe folder names", () => {
    for (const alias of ["../results", "..", "a/b", "-x", "Results"]) {
      expect(() =>
        parseProjectConfig({ ...valid, repos: { [alias]: { host: "github", path: "a/b" } } }),
      ).toThrow(ConfigError);
      expect(() =>
        parseProjectConfig({
          ...valid,
          repos: {},
          code_hosts: { [alias]: { type: "github", token: "secret://env/T" } },
        }),
      ).toThrow(ConfigError);
    }
  });

  it("REQ-LLM-02/AC2: provider definitions live in models.providers and roles must reference them", () => {
    const models = {
      providers: {
        cloud: { type: "anthropic", api_key: "secret://env/ANTHROPIC_API_KEY" },
        local: {
          type: "ollama",
          base_url: "http://localhost:11434/api",
          models: { "qwen3:32b": { tools: true, context_window: 32768 } },
        },
        company: {
          type: "openai-compatible",
          base_url: "https://litellm.example.com/v1",
          api_key: "secret://env/LITELLM_KEY",
        },
      },
      roles: { default: "cloud/claude-sonnet-5", summary: "local/qwen3:32b" },
      token_budget: 500000,
    };
    const config = parseProjectConfig({ ...valid, models });
    expect(config.models.providers["local"]?.models["qwen3:32b"]).toEqual({
      tools: true,
      context_window: 32768,
    });
    expect(() =>
      parseProjectConfig({ ...valid, models: { ...models, roles: { default: "nope/x" } } }),
    ).toThrow(ConfigError);
    expect(() => parseProjectConfig({ ...valid, models: { providers: { a: { type: "openai" } } } })).toThrow(
      ConfigError,
    );
    expect(() =>
      parseProjectConfig({ ...valid, models: { providers: { a: { type: "openai-compatible" } } } }),
    ).toThrow(ConfigError);
    expect(() =>
      parseProjectConfig({ ...valid, models: { providers: { a: { type: "openai", api_key: "sk-plain" } } } }),
    ).toThrow(ConfigError);
  });
});
