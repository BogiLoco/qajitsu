/** An image pinned by version and by the digest of its multi-platform index (REQ-GEN-10/AC4). */
export interface PinnedImage {
  readonly repository: string;
  readonly version: string;
  /** `sha256:<hex>` of the image index, so every platform resolves to the image that was checked. */
  readonly digest: string;
}

/** A model pinned by `name:tag` and the digest of its manifest in the Ollama registry (REQ-GEN-10/AC4). */
export interface PinnedModel {
  readonly name: string;
  readonly digest: string;
}

/**
 * The images of the stack besides QAJitsu's own, moved by hand in a reviewed change (as the release image's base is):
 * the tag says what it is, the digest what is pulled. Docker Hub, 2026-11-15.
 */
export const PINNED_IMAGES = {
  ollama: {
    repository: "ollama/ollama",
    version: "0.40.16",
    digest: "sha256:910d0d8107b538fb0894e63163eb195de0cc7aefcbc666dc62d3b18f71124592",
  },
  /** The same Ollama built for AMD GPUs (ROCm). */
  ollamaRocm: {
    repository: "ollama/ollama",
    version: "0.40.16-rocm",
    digest: "sha256:85b3c895222b1ddc9d63c40b20fc74f37a37593dcbbdfbf28910a925e43ead00",
  },
  chroma: {
    repository: "chromadb/chroma",
    version: "1.5.9",
    digest: "sha256:1e0b73a187a28757c572acba508c46f48c9e8b0acaf5c20e6d95cdedce1acdf6",
  },
} as const satisfies Record<string, PinnedImage>;

/** The release image of QAJitsu (REQ-GEN-09). */
export const QAJITSU_IMAGE = "ghcr.io/bogiloco/qajitsu";

/** Named sets of Ollama models per role (the REQ-GEN-10 note on presets). */
export const STACK_PRESETS = ["small", "local", "hybrid"] as const;
/** One of {@link STACK_PRESETS}. */
export type StackPreset = (typeof STACK_PRESETS)[number];

const PRESETS: Record<StackPreset, Readonly<Record<string, string>>> = {
  // 16 GB machines: one small model with tools and a long context for every text role. It has no vision, so the
  // auditor keeps the project's model (or is switched off).
  small: { default: "qwen3:4b" },
  // About 32 GB of memory: every role local. gpt-oss for the text roles, a small fast model for summary and triage,
  // and the one local model with tools, vision and 128k tokens as the auditor (another model than the author's).
  local: { default: "gpt-oss:20b", summary: "qwen3:4b", triage: "qwen3:4b", auditor: "mistral-small3.2:24b" },
  // Local models where a short context is enough; the configured cloud models keep planner, author, healer and auditor.
  hybrid: { analyst: "qwen3:4b", summary: "qwen3:4b", triage: "qwen3:4b" },
};

/**
 * The Ollama model of each role a preset sets; roles it leaves out keep the project's models.
 *
 * @param preset - One of {@link STACK_PRESETS}.
 * @returns `role` (or `default`) to `name:tag`.
 */
export function presetRoles(preset: StackPreset): Record<string, string> {
  return { ...PRESETS[preset] };
}

/** `name` and `name:tag` with the tag Ollama would use: `latest` when none is given. */
export const withTag = (name: string): string => (/:[\w.-]+$/.test(name) ? name : `${name}:latest`);
