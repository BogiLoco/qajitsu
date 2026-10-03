import { describe, expect, it } from "vitest";
import { ConfigError, NotImplementedError, QajitsuError, assertNever } from "./errors.js";

describe("errors (REQ-NFR-01)", () => {
  it("carries code, context and the subclass name", () => {
    const error = new ConfigError("CONFIG_INVALID", "Invalid config", { path: ".qa/qa.project.yaml" });
    expect(error).toBeInstanceOf(QajitsuError);
    expect(error.name).toBe("ConfigError");
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.context).toEqual({ path: ".qa/qa.project.yaml" });
  });

  it("defaults context to an empty object", () => {
    expect(new QajitsuError("X", "x").context).toEqual({});
  });

  it("names the requirement in NotImplementedError", () => {
    const error = new NotImplementedError("Local build", "REQ-ENV-03");
    expect(error.code).toBe("NOT_IMPLEMENTED");
    expect(error.message).toContain("REQ-ENV-03");
  });

  it("assertNever always throws", () => {
    expect(() => assertNever("oops" as never)).toThrow(QajitsuError);
  });
});
