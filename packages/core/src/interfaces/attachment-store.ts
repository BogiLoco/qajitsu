/** A file put into object storage instead of the ticket, with the link that reads it (REQ-PUB-02/AC3). */
export interface StoredAttachment {
  /** The object's key in the storage. */
  readonly key: string;
  /** A time-limited link that reads the object, for the ticket comment. */
  readonly url: string;
  /** When the link stops working, ISO 8601. */
  readonly expiresAt: string;
  readonly bytes: number;
}

/**
 * Object storage for attachments larger than the ticket system takes (REQ-PUB-02/AC3): the file is uploaded and a
 * link that expires is put into the comment instead. S3 (AWS, MinIO and other S3-compatible stores) and Azure Blob
 * Storage are plugins behind this interface (INV-12).
 */
export interface AttachmentStore {
  readonly id: string;
  /**
   * Uploads a file and returns a read-only link valid for `expiresInSeconds`.
   *
   * @throws AdapterError when the storage refuses the upload; nothing is linked then.
   */
  put(
    key: string,
    data: Uint8Array,
    options: { readonly mimeType: string; readonly expiresInSeconds: number },
    signal?: AbortSignal,
  ): Promise<StoredAttachment>;
}
