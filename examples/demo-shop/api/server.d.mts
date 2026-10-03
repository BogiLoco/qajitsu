/** Type declarations of the demo-shop API for TypeScript tests (the server itself is plain JavaScript). */
import type { IncomingMessage, ServerResponse } from "node:http";

export declare const BUG_FLAGS: readonly string[];

export declare function createShop(options: {
  bugs?: Record<string, boolean>;
  password: string;
  sha?: string;
  now?: () => number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export declare function startShop(options?: {
  port?: number;
  host?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ url: string; close: () => Promise<void> }>;
