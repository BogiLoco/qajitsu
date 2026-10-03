import type { RunId, TicketKey } from "../identifiers.js";

/** What the run needs from an environment (REQ-ENV-01, REQ-ENV-03). */
export interface EnvironmentRequest {
  readonly ticket: TicketKey;
  readonly runId: RunId;
  /** `remote` uses a given profile or URL; `build` starts the app from the fetched repositories. */
  readonly mode: "remote" | "build";
  readonly profile?: string;
  readonly url?: string;
  /** Working copies at the analysed SHA, keyed by repo alias (REQ-CTX-04). */
  readonly worktrees: Readonly<Record<string, string>>;
}

/** A running (or reachable) environment. */
export interface EnvironmentHandle {
  /** Base URLs per service, e.g. `{ web: "http://localhost:51234" }`. */
  readonly baseUrls: Readonly<Record<string, string>>;
  /** Deployed version (commit SHA) when the environment reports it (REQ-ENV-02). */
  readonly deployedSha?: string;
  /** Stops and cleans up everything this handle started (REQ-WS-03). */
  stop(): Promise<void>;
}

/** Starts or connects to an environment: remote, Docker Compose, device farm (REQ-GEN-02). */
export interface EnvProvider {
  start(request: EnvironmentRequest, signal?: AbortSignal): Promise<EnvironmentHandle>;
}
