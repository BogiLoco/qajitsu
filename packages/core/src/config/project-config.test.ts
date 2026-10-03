import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { parseProjectConfig } from "./project-config.js";

const valid = {
  project: "shop",
  jira: { project_key: "SHOP" },
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
});
