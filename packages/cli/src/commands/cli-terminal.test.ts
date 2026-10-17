import { describe, expect, it } from "vitest";
import { createCliTerminal } from "./cli-terminal.js";

const setup = (headed: boolean) => {
  let t = 1_000_000;
  const shown: string[] = [];
  const terminal = createCliTerminal({
    write: (s) => shown.push(s),
    headed,
    now: () => t,
    mask: (s) => s.replaceAll("token123", "***"),
    title: "qj explore S01",
  });
  return { terminal, shown: () => shown.join(""), tick: (ms: number) => (t += ms) };
};

const play = (s: ReturnType<typeof setup>) => {
  s.terminal.begin("A01", "qj doctor");
  s.tick(200);
  s.terminal.output("✔ node 22\n✘ android: tok");
  s.terminal.output("en123 missing\npartial");
  s.tick(1000);
  s.terminal.end("A01", "exit 3");
  s.terminal.begin("A02", "qj serve");
  s.terminal.output("listening\n", "B1");
  s.terminal.echo("> yes");
  s.terminal.end("A02", "still running (B1)");
  s.terminal.note("✘ answer rejected: item 1 names doctor, which none of its actions (A02) ran");
};

describe("terminal of a command-line session (REQ-EXEC-24)", () => {
  it("REQ-EXEC-24/AC9: by default one line per action and every note; the recording keeps everything", () => {
    const s = setup(false);
    play(s);
    expect(s.shown()).toBe(
      [
        "A01  qj doctor → exit 3 (1.2 s)",
        "A02  qj serve → still running (B1) (0.0 s)",
        "✘ answer rejected: item 1 names doctor, which none of its actions (A02) ran",
        "",
      ].join("\n"),
    );
    const { transcript } = s.terminal.finish();
    expect(transcript).toContain("$ qj doctor\n✔ node 22\n✘ android: *** missing\npartial\n→ exit 3 (1.2 s)");
    expect(transcript).toContain("[B1] listening\n> yes\n");
  });

  it("REQ-EXEC-24/AC9: --headed shows every command, its output as it arrives, typed answers and background output; secrets are masked across chunks", () => {
    const s = setup(true);
    play(s);
    const shown = s.shown();
    expect(shown).toContain("── A01 ");
    expect(shown).toContain("$ qj doctor\n✔ node 22\n✘ android: *** missing\npartial\n→ exit 3 (1.2 s)\n");
    expect(shown).toContain("[B1] listening\n");
    expect(shown).toContain("> yes\n");
    expect(shown).not.toContain("token123");
    expect(shown).not.toContain("tok\n");
    expect(shown).toBe(s.terminal.finish().transcript);
  });

  it("REQ-EXEC-24/AC11: the recording is asciicast v2 with growing times and terminal line ends", () => {
    const s = setup(false);
    play(s);
    const [head = "", ...rest] = s.terminal.finish().cast.trimEnd().split("\n");
    expect(JSON.parse(head)).toMatchObject({ version: 2, width: 120, height: 40, title: "qj explore S01" });
    const frames = rest.map((l) => JSON.parse(l) as [number, string, string]);
    expect(frames.every(([, kind]) => kind === "o")).toBe(true);
    const times = frames.map(([at]) => at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)).toBeCloseTo(1.2, 3);
    const data = frames.map(([, , d]) => d).join("");
    expect(data).toContain("$ qj doctor\r\n");
    expect(data).not.toMatch(/[^\r]\n/);
    expect(data).not.toContain("token123");
  });
});
