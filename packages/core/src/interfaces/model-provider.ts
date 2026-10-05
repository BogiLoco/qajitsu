/** Capabilities a role may require from a model (REQ-LLM-03). */
export interface ModelCapabilities {
  readonly tools: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly contextWindow: number;
}

/** A configured model: its `<provider>/<model>` id, an opaque handle for the agent loop and its capabilities. */
export interface ResolvedModelHandle {
  readonly id: string;
  /** Provider SDK handle, typed in `@qajitsu/models`; core never imports provider SDKs (invariant 11). */
  readonly model: unknown;
  readonly profile: ModelCapabilities;
}

/**
 * Access to the configured models across providers (REQ-LLM-01, REQ-LLM-02, REQ-GEN-02, ADR-0005). Unknown providers
 * are configuration errors that never repeat an API key.
 */
export interface ModelProvider {
  /** Resolves `<provider>/<model>`. */
  resolve(reference: string): Promise<ResolvedModelHandle>;
  /** Resolves the model of an agent role; roles without their own model use `default` (REQ-LLM-02/AC1). */
  forRole(role: string): Promise<ResolvedModelHandle>;
}
