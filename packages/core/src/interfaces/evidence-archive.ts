/** How an object stays locked in write-once storage (REQ-VER-19). */
export type RetentionMode = "compliance" | "governance";

/** What write-once storage reports about one stored object. */
export interface ArchivedObject {
  readonly key: string;
  readonly bytes: number;
  /** The lock the storage holds on the object, as it reports it. */
  readonly mode?: RetentionMode;
  readonly retainUntil?: string;
  /** MD5 of the content as the storage reports it (S3 ETag of a single-part upload), hex. */
  readonly md5?: string;
  readonly versionId?: string;
}

/**
 * Write-once storage for a run's evidence and certificate (REQ-VER-19): objects that nobody, an administrator
 * included, can change or delete before their retention ends. S3 Object Lock (AWS, MinIO and other S3-compatible
 * stores) is the first implementation; it is a plugin behind this interface (INV-12).
 */
export interface EvidenceArchive {
  readonly id: string;
  /** Where the objects of a key prefix live, as a URI for reports and the certificate (e.g. `s3://bucket/prefix/`). */
  uri(prefix: string): string;
  /** Writes an object locked until `retainUntil`; refuses to overwrite nothing, the storage keeps versions. */
  put(
    key: string,
    data: Uint8Array,
    lock: { readonly mode: RetentionMode; readonly retainUntil: string },
    signal?: AbortSignal,
  ): Promise<ArchivedObject>;
  /** Reads back what the storage holds for an object, lock included. */
  head(key: string, signal?: AbortSignal): Promise<ArchivedObject | undefined>;
}
