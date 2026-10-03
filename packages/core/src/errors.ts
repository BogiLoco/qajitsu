/**
 * Typed errors for QAJitsu library code (coding standards; REQ-NFR-01).
 *
 * Every error carries a stable machine-readable `code` and a `context` object.
 * Never put secret values into messages or context (REQ-CFG-06).
 */

/** Context attached to an error; values must be safe to log. */
export type ErrorContext = Readonly<Record<string, unknown>>;

/** Base class of all errors thrown by QAJitsu packages. */
export class QajitsuError extends Error {
  /** Stable identifier, e.g. `CONFIG_INVALID`. */
  readonly code: string;
  /** Structured, non-secret details for logs and reports. */
  readonly context: ErrorContext;

  /**
   * @param code - Stable error code in SCREAMING_SNAKE_CASE.
   * @param message - Human-readable message without secrets.
   * @param context - Structured details safe to log.
   */
  constructor(code: string, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.context = context;
  }
}

/** Project or environment configuration is missing or invalid (REQ-CFG-01, REQ-CFG-04). */
export class ConfigError extends QajitsuError {}

/** An adapter (Jira, GitHub, GitLab, model provider, ...) failed (REQ-GEN-02). */
export class AdapterError extends QajitsuError {}

/** The tool guard denied an agent action (REQ-VER-03). */
export class GuardDeniedError extends QajitsuError {}

/** A publish gate failed (REQ-VER-07). */
export class GateFailedError extends QajitsuError {}

/** A feature that belongs to a later roadmap stage was called. */
export class NotImplementedError extends QajitsuError {
  /**
   * @param feature - What is missing.
   * @param requirement - Requirement ID that will deliver it, e.g. `REQ-ENV-03`.
   */
  constructor(feature: string, requirement: string) {
    super("NOT_IMPLEMENTED", `${feature} is not implemented yet (${requirement}).`, {
      feature,
      requirement,
    });
  }
}

/**
 * Marks code paths that must be unreachable; used at the end of exhaustive switches.
 *
 * @param value - The value that should have type `never`.
 * @throws {QajitsuError} Always, with code `UNREACHABLE`.
 * @example
 * switch (status) {
 *   case "PASSED": return 1;
 *   // ...all other cases
 *   default: return assertNever(status);
 * }
 */
export function assertNever(value: never): never {
  throw new QajitsuError("UNREACHABLE", "Reached code that should be unreachable.", {
    value: String(value),
  });
}
