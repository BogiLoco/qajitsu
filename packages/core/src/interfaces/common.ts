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
  /** Registers a secret an adapter obtained another way (e.g. a minted installation token) with the masker. */
  readonly registerSecret: (value: string) => void;
}
