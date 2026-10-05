import { execFile } from "node:child_process";
import { AdapterError, ConfigError, parseSecretRef, type SecretProvider } from "@qajitsu/core";

/** Runs a secret manager's CLI: command, argument array, environment and timeout; resolves with stdout. */
export type SecretCliExec = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
) => Promise<string>;

const runCli: SecretCliExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        env: { ...options.env },
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout) => {
        // The CLI's own messages are not repeated: they may name accounts, tokens or the value.
        if (error) reject(new Error(`${command} failed`));
        else resolve(stdout);
      },
    );
  });

/** Common options of the CLI-backed providers. */
export interface SecretCliOptions {
  /** The environment the CLI's own variables come from (only those are passed on). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Replaced in tests; default `execFile` with an argument array, never a shell. */
  readonly exec?: SecretCliExec;
  readonly timeoutMs?: number;
}

/** PATH, HOME and the variables of one CLI; nothing else of the parent process reaches it. */
const cliEnv = (env: SecretCliOptions["env"], allowed: (name: string) => boolean): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (entry[0] === "PATH" || entry[0] === "HOME" || allowed(entry[0])),
    ),
  );

const invalid = (provider: string, shape: string): ConfigError =>
  new ConfigError("SECRET_REF_INVALID", `${provider} references look like ${shape}.`, { provider });

/**
 * Builds a provider around a CLI call: validates the reference, runs the CLI with an argument array and a minimal
 * environment, and reports failures without the CLI's output (invariant 8).
 */
function cliProvider(
  scheme: string,
  options: SecretCliOptions,
  allowed: (name: string) => boolean,
  call: (path: string) => {
    readonly command: string;
    readonly args: readonly string[];
    readonly pick?: (out: string) => string | undefined;
  },
): SecretProvider {
  const exec = options.exec ?? runCli;
  const env = cliEnv(options.env, allowed);
  return {
    scheme,
    async resolve(reference, signal) {
      signal?.throwIfAborted();
      const { command, args, pick } = call(parseSecretRef(reference).path);
      let out: string;
      try {
        out = await exec(command, args, {
          env,
          timeoutMs: options.timeoutMs ?? 30_000,
          ...(signal ? { signal } : {}),
        });
      } catch {
        signal?.throwIfAborted();
        throw new AdapterError(
          "SECRET_SOURCE_UNREADABLE",
          `${command} could not read the secret (is it installed and signed in?).`,
          {
            provider: scheme,
          },
        );
      }
      const value = pick ? pick(out) : out;
      if (value === undefined || value === "")
        throw new AdapterError("SECRET_NOT_FOUND", `${scheme} returned no value for the reference.`, {
          provider: scheme,
        });
      return value;
    },
  };
}

const SEGMENT = /^(?!-)[\w .@+=-]+$/;

/**
 * `op` provider (1Password CLI, REQ-CFG-03/AC3): `secret://op/<vault>/<item>/<field>` runs
 * `op read --no-newline op://<vault>/<item>/<field>`. Sign in with a service account (`OP_SERVICE_ACCOUNT_TOKEN`) or
 * the desktop app; only `OP_*` variables are passed on.
 *
 * @param options - Environment, exec and timeout.
 * @example
 * const op = createOnePasswordSecretProvider({ env: process.env });
 * await op.resolve("secret://op/QA/Jira/token");
 */
export function createOnePasswordSecretProvider(options: SecretCliOptions): SecretProvider {
  return cliProvider(
    "op",
    options,
    (n) => n.startsWith("OP_") || n === "XDG_CONFIG_HOME",
    (path) => {
      const segments = path.split("/");
      if (segments.length < 3 || segments.length > 4 || !segments.every((s) => SEGMENT.test(s)))
        throw invalid("1Password", "secret://op/<vault>/<item>/<field>");
      return { command: "op", args: ["read", "--no-newline", `op://${path}`] };
    },
  );
}

const AWS_ID = /^(?!-)[\w/+=.@:-]+$/;

/**
 * `aws` provider (AWS Secrets Manager through the AWS CLI, REQ-CFG-03/AC3): `secret://aws/<secret-id>[#<json-key>]`
 * reads the SecretString, optionally one key of a JSON secret. Credentials come from the usual `AWS_*` variables or
 * the named profile.
 *
 * @param options - Region, optional profile, environment, exec and timeout.
 * @example
 * const aws = createAwsSecretProvider({ region: "eu-central-1", env: process.env });
 * await aws.resolve("secret://aws/shop/ci/jira#token");
 */
export function createAwsSecretProvider(
  options: SecretCliOptions & { readonly region: string; readonly profile?: string },
): SecretProvider {
  return cliProvider(
    "aws",
    options,
    (n) => n.startsWith("AWS_"),
    (path) => {
      const hash = path.indexOf("#");
      const id = hash >= 0 ? path.slice(0, hash) : path;
      const key = hash >= 0 ? path.slice(hash + 1) : undefined;
      if (!AWS_ID.test(id) || (key !== undefined && !/^[\w.-]+$/.test(key)))
        throw invalid("AWS", "secret://aws/<secret-id>[#<json-key>]");
      return {
        command: "aws",
        args: [
          "secretsmanager",
          "get-secret-value",
          "--secret-id",
          id,
          "--query",
          "SecretString",
          "--output",
          "text",
          "--region",
          options.region,
          ...(options.profile ? ["--profile", options.profile] : []),
        ],
        pick: (out) => {
          const text = out.replace(/\r?\n$/, "");
          if (key === undefined) return text;
          try {
            const value = (JSON.parse(text) as Record<string, unknown>)[key];
            return typeof value === "string" ? value : undefined;
          } catch {
            return undefined;
          }
        },
      };
    },
  );
}

/**
 * `gcp` provider (Google Secret Manager through `gcloud`, REQ-CFG-03/AC3): `secret://gcp/<name>[@<version>]` reads
 * the version (`latest` by default) in the configured project. Credentials come from gcloud's own login or
 * `GOOGLE_APPLICATION_CREDENTIALS`; only `CLOUDSDK_*` and that variable are passed on.
 *
 * @param options - Project, environment, exec and timeout.
 * @example
 * const gcp = createGcpSecretProvider({ project: "shop-qa", env: process.env });
 * await gcp.resolve("secret://gcp/jira-token");
 */
export function createGcpSecretProvider(
  options: SecretCliOptions & { readonly project: string },
): SecretProvider {
  return cliProvider(
    "gcp",
    options,
    (n) => n.startsWith("CLOUDSDK_") || n === "GOOGLE_APPLICATION_CREDENTIALS",
    (path) => {
      const [name = "", version = "latest", ...rest] = path.split("@");
      if (rest.length > 0 || !/^(?!-)[\w-]+$/.test(name) || !/^(latest|\d+)$/.test(version))
        throw invalid("GCP", "secret://gcp/<name>[@<version>]");
      return {
        command: "gcloud",
        args: ["secrets", "versions", "access", version, `--secret=${name}`, `--project=${options.project}`],
      };
    },
  );
}
