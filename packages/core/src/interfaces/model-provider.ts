/** Capabilities a role may require from a model (REQ-LLM-03). */
export interface ModelCapabilities {
  readonly tools: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly contextWindow: number;
}

/**
 * Access to LLMs from one provider (REQ-LLM-01). Core never imports provider SDK types
 * (invariant 11), so the language model handle is opaque here and typed in `@qajitsu/models`.
 */
export interface ModelProvider {
  readonly id: string;
  capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities>;
  languageModel(model: string): unknown;
}
