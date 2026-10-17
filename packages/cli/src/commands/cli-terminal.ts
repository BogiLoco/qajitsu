/** The terminal of a command-line exploratory session: what a person watches live and what is recorded. */
export interface CliTerminal {
  /** An action starts: its header and the command line, e.g. `qj doctor`. */
  readonly begin: (id: string, command: string) => void;
  /** Output of a command as it arrives; `from` names a background command (`B1`). Masked line by line. */
  readonly output: (text: string, from?: string) => void;
  /** A line typed into a command, or a signal sent to it (shown with `--headed`). */
  readonly echo: (line: string) => void;
  /** The action ended with this state, e.g. `exit 3`. */
  readonly end: (id: string, state: string) => void;
  /** A line shown in every mode: a rejected answer, an observation. */
  readonly note: (line: string) => void;
  /** The recording (asciicast v2) and the plain transcript of everything. */
  readonly finish: () => { readonly cast: string; readonly transcript: string };
}

/**
 * Builds the terminal of a session (REQ-EXEC-24/AC9+AC11). Everything goes to the recording; the person sees one
 * line per action, or with `headed` the whole terminal as it happens. Output is masked per complete line, so a secret
 * split across two chunks is still masked; a partial line is shown when its action ends.
 *
 * @param options - Where live text goes, `--headed`, the clock in ms, masking and the recording's title.
 */
export function createCliTerminal(options: {
  readonly write: (text: string) => void;
  readonly headed: boolean;
  readonly now: () => number;
  readonly mask: (text: string) => string;
  readonly title: string;
  readonly width?: number;
  readonly height?: number;
}): CliTerminal {
  const start = options.now();
  const width = options.width ?? 120;
  const frames: string[] = [];
  let transcript = "";
  const pending = new Map<string, string>();
  const commands = new Map<string, { command: string; startedAt: number }>();

  /** Recorded always; shown live with `--headed`. */
  const record = (text: string, live = options.headed): void => {
    if (text === "") return;
    transcript += text;
    const at = Math.round(options.now() - start) / 1000;
    frames.push(JSON.stringify([at, "o", text.replace(/\r?\n/g, "\r\n")]));
    if (live) options.write(text);
  };
  const prefix = (from: string): string => (from === "" ? "" : `[${from}] `);
  const flush = (from: string): void => {
    const rest = pending.get(from) ?? "";
    pending.delete(from);
    if (rest !== "") record(`${prefix(from)}${options.mask(rest)}\n`);
  };

  return {
    begin(id, command) {
      for (const from of [...pending.keys()]) flush(from);
      commands.set(id, { command: options.mask(command), startedAt: options.now() });
      record(
        `── ${id} ${"─".repeat(Math.max(4, Math.min(width, 60) - id.length - 4))}\n$ ${options.mask(command)}\n`,
      );
    },
    output(text, from = "") {
      const lines = `${pending.get(from) ?? ""}${text}`.split("\n");
      pending.set(from, lines.pop() ?? "");
      if (lines.length > 0) record(lines.map((l) => `${prefix(from)}${options.mask(l)}\n`).join(""));
    },
    echo(line) {
      record(`${options.mask(line)}\n`);
    },
    end(id, state) {
      flush("");
      const c = commands.get(id);
      const took = `(${((options.now() - (c?.startedAt ?? options.now())) / 1000).toFixed(1)} s)`;
      record(`→ ${state} ${took}\n`);
      if (!options.headed) options.write(`${id}  ${c?.command ?? ""} → ${state} ${took}\n`);
    },
    note(line) {
      record(`${options.mask(line)}\n`, false);
      options.write(`${options.mask(line)}\n`);
    },
    finish() {
      for (const from of [...pending.keys()]) flush(from);
      const header = JSON.stringify({
        version: 2,
        width,
        height: options.height ?? 40,
        timestamp: Math.floor(start / 1000),
        title: options.title,
        env: { TERM: "xterm-256color" },
      });
      return { cast: `${[header, ...frames].join("\n")}\n`, transcript };
    },
  };
}
