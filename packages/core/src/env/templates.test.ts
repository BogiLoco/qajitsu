import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../config/project-config.js";
import { renderTemplate, resolveServiceEnv, templateReferences, toDotenv } from "./templates.js";

const context = {
  svc: { db: { host: "db", port: 5432 }, api: { host: "127.0.0.1", port: 51234 } },
  port: 40001,
};

describe("service variables and templates (REQ-CFG-02)", () => {
  it("REQ-CFG-02/AC2: templates resolve to dynamically assigned hosts and ports", () => {
    expect(renderTemplate("postgres://{{svc.db.host}}:{{ svc.db.port }}/shop", context)).toBe(
      "postgres://db:5432/shop",
    );
    expect(renderTemplate("--port={{port}} {{svc.api.url}}", context)).toBe(
      "--port=40001 http://127.0.0.1:51234",
    );
    expect(() => renderTemplate("{{svc.cache.host}}", context)).toThrow(/Unknown template reference/);
    expect(() => renderTemplate("{{port}}", { svc: {} })).toThrow();
    expect(templateReferences("a {{svc.db.host}} b {{port}}")).toEqual(["svc.db.host", "port"]);
  });

  it("REQ-CFG-02/AC1+AC3: constants, templates and secrets; only overridable variables accept run overrides", async () => {
    const env = {
      MODE: "test",
      LOG_LEVEL: { value: "info", overridable: true },
      DB_URL: { template: "postgres://{{svc.db.host}}:{{svc.db.port}}/shop", overridable: false },
      PASSWORD: { secret: "secret://env/DB_PASSWORD" },
    };
    const resolve = (ref: string) => Promise.resolve(`value-of-${ref.slice(13)}`);
    const { vars, secrets } = await resolveServiceEnv(env, context, resolve, { LOG_LEVEL: "debug" });
    expect(vars).toEqual({
      MODE: "test",
      LOG_LEVEL: "debug",
      DB_URL: "postgres://db:5432/shop",
      PASSWORD: "value-of-DB_PASSWORD",
    });
    expect(secrets).toEqual(["value-of-DB_PASSWORD"]);
    await expect(resolveServiceEnv(env, context, resolve, { MODE: "prod" })).rejects.toMatchObject({
      code: "VARIABLE_NOT_OVERRIDABLE",
    });
    expect(toDotenv({ A: 'x"y', B: "l1\nl2" })).toBe('A="x\\"y"\nB="l1\\nl2"\n');
  });

  it("REQ-ENV-03: build and services are validated with the project", () => {
    const base = {
      project: "demo",
      jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
      code_hosts: { local: { type: "local", root: "~/git" } },
      repos: { shop: { host: "local", path: "a/b" } },
    };
    const ok = parseProjectConfig({
      ...base,
      services: {
        api: {
          kind: "process",
          command: ["node", "api/server.mjs", "--port", "{{port}}"],
          health: { http: "/health" },
        },
        db: { kind: "compose", port: 5432, health: { port: true } },
        payments: { kind: "stub", engine: "wiremock", mappings: "stubs/payments" },
      },
      build: { repo: "shop", base_service: "api", compose_file: "docker-compose.yml" },
    });
    expect(ok.cleanup).toEqual({ policy: "on_success", keep_last: 10, max_age_days: 30 });
    expect(() =>
      parseProjectConfig({
        ...base,
        services: { db: { kind: "compose", port: 5432 } },
        build: { repo: "shop", base_service: "db" },
      }),
    ).toThrow(/Invalid configuration/);
    expect(() => parseProjectConfig({ ...base, build: { repo: "nope", base_service: "api" } })).toThrow();
    expect(() =>
      parseProjectConfig({
        ...base,
        services: { api: { kind: "process", command: ["x"], health: { http: "/h", port: true } } },
      }),
    ).toThrow();
    expect(() =>
      parseProjectConfig({
        ...base,
        services: { api: { kind: "process", command: ["x"], cwd: "../../etc" } },
      }),
    ).toThrow();
  });
});
