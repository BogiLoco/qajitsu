/** Resolves `secret://<provider>/<path>` references (REQ-CFG-03). Values are never logged. */
export interface SecretProvider {
  readonly scheme: string;
  resolve(reference: string, signal?: AbortSignal): Promise<string>;
}
