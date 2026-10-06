/**
 * QAJitsu model layer: provider-agnostic access to LLMs (cloud, LiteLLM, Ollama) with a model per
 * agent role and capability profiles (REQ-LLM-01..03). The only package that imports provider SDKs.
 *
 * @packageDocumentation
 */
export * from "./model-ref.js";
export * from "./capabilities.js";
export * from "./registry.js";
export * from "./embedder.js";
