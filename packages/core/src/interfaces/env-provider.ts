/** Whether the environment answered its health check (REQ-ENV-01/AC1). */
export interface EnvironmentHealth {
  readonly ok: boolean;
  readonly detail: string;
}

/** A running (or reachable) environment for one run. */
export interface EnvironmentHandle {
  readonly baseUrl: string;
  readonly health: EnvironmentHealth;
  /** Deployed version (commit SHA) when the environment reports it (REQ-ENV-02). */
  readonly deployedSha?: string | undefined;
  /** Stubbed dependencies, listed in the report (REQ-ENV-05/AC2). */
  readonly stubs: readonly string[];
  /**
   * Stops what this handle started and returns the service logs it wrote (REQ-WS-03). With `keep`, containers
   * stay up for debugging. A provided environment starts nothing and stops nothing.
   */
  stop(options?: { readonly keep?: boolean }): Promise<{ readonly logs: readonly string[] }>;
}

/**
 * Starts or connects to the environment of a run: a provided one, one built from the worktree, later Kubernetes or
 * a device farm (REQ-GEN-02, ADR-0005). A provider is built with its own options by its factory. It never reports
 * an application that is not up as healthy: it returns `health.ok: false` or throws with the logs it collected.
 */
export interface EnvProvider {
  readonly kind: string;
  start(): Promise<EnvironmentHandle>;
}
