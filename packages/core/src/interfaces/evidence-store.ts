/** One evidence file listed in `evidence/manifest.json` (REQ-VER-05). */
export interface EvidenceEntry {
  readonly path: string;
  readonly sha256: string;
  readonly caseId: string;
  readonly stepId?: string;
  readonly kind: "request" | "response" | "screenshot" | "video" | "trace" | "log" | "har" | "other";
  readonly bytes: number;
}

/** Stores evidence files and the manifest: local disk first, object storage later (REQ-PUB-02). */
export interface EvidenceStore {
  put(entry: Omit<EvidenceEntry, "sha256" | "bytes">, content: Uint8Array): Promise<EvidenceEntry>;
  manifest(): Promise<readonly EvidenceEntry[]>;
}
