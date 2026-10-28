/** Type declarations of the demo identity provider for TypeScript tests. */
export declare function totpAt(seed: string, ms: number): string;

export declare function startIdp(options: {
  password: string;
  totpSeed: string;
  port?: number;
}): Promise<{ url: string; close: () => Promise<void> }>;
