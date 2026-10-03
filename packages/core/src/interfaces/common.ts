/** Minimal structured logger port; implemented with pino in the CLI (REQ-OBS-01). */
export interface Logger {
  debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** Ports injected into every adapter so side effects stay replaceable in tests (REQ-NFR-02). */
export interface AdapterDeps {
  readonly logger: Logger;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => Date;
  /** Resolves `secret://` references; resolved values are registered with the masker (REQ-CFG-06). */
  readonly resolveSecret: (reference: string) => Promise<string>;
}
