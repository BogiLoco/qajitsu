/** Tools whose version is shown first, in this order; the rest follow alphabetically. */
const ORDER = [
  "qajitsu",
  "os",
  "node",
  "git",
  "playwright",
  "chromium",
  "firefox",
  "webkit",
  "docker",
  "compose",
];

const rank = (name: string): number => {
  const i = ORDER.indexOf(name);
  return i < 0 ? ORDER.length : i;
};

/**
 * One line of the tool versions a run used (REQ-OBS-10/AC2), e.g. `qajitsu 0.4.0 · node v22.12.0 · chromium 153.0`.
 *
 * @param versions - `{ tool: version }`, `unknown` for a version that could not be read.
 */
export function formatVersions(versions: Readonly<Record<string, string>> | undefined): string {
  if (!versions || Object.keys(versions).length === 0) return "not recorded";
  return Object.entries(versions)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, version]) => `${name} ${version}`)
    .join(" · ");
}

/**
 * The tools whose version differs between two runs (REQ-OBS-10/AC3), e.g. `chromium 150.0 → 153.0`. Only tools both
 * runs recorded are compared, so a run of an older QAJitsu that recorded fewer tools adds no noise. Empty when they
 * are the same or one of the runs did not record its versions.
 *
 * @param before - Versions of the earlier run.
 * @param after - Versions of the later run.
 */
export function diffVersions(
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!before || !after) return [];
  const names = Object.keys(before)
    .filter((n) => n in after)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names
    .filter((n) => before[n] !== after[n])
    .map((n) => `${n} ${before[n] ?? ""} → ${after[n] ?? ""}`);
}
