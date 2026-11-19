import { QajitsuError } from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import { startConsole } from "../console/server.js";
import type { CommandIO } from "./fetch.js";
import type { RunPorts } from "./run.js";

/**
 * `qajitsu console [--port <n>]`: the local web console over every registered project (REQ-WEB-01), on 127.0.0.1
 * until Ctrl+C. The printed address carries a one-time token: only the browser that opens it is let in.
 *
 * @returns 0 after Ctrl+C, 3 on errors.
 */
export async function runConsole(
  options: { readonly port?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & Pick<RunPorts, "signals">,
): Promise<number> {
  const signals = ports.signals ?? process;
  let stop: () => void = () => undefined;
  const onSignal = (): void => {
    stop();
  };
  try {
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      io.writeError("--port must be a port number.\n");
      return 3;
    }
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    const server = await startConsole({ env: ports.env, userHome: ports.home, port });
    io.write(
      `QAJitsu console: ${server.url}\nOpen it in your browser (the address signs you in; keep it to yourself). Press Ctrl+C to stop.\n`,
    );
    await stopped;
    await server.close();
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }
}
