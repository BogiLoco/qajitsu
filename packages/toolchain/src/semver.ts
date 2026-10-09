/**
 * Numeric parts of a tool's version as tools print it: `17.0.20.1+1`, `1.8.0_392` (Java 8 is `8`), `v3.8.0`,
 * `android-34`, `Xcode 16.4`. Build suffixes after `+`, `-` or `_` are ignored except for the legacy Java scheme.
 *
 * @returns The parts, or undefined when the text holds no version (it is never guessed).
 */
export function parseVersion(text: string): number[] | undefined {
  const match = /(\d+(?:\.\d+)*)(?:_(\d+))?/.exec(text);
  if (!match?.[1]) return undefined;
  const parts = match[1].split(".").map(Number);
  // Java up to 8 reports 1.8.0_392; its major version is the second part.
  if (parts[0] === 1 && parts.length >= 2 && match[2] !== undefined)
    return [...parts.slice(1), Number(match[2])];
  return parts;
}

/**
 * Compares two versions part by part; a missing part counts as 0 (`21` equals `21.0.0`).
 *
 * @returns Negative, 0 or positive like `Array.prototype.sort` expects. An unreadable version sorts first.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [];
  const y = parseVersion(b) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const comparator = (version: string, part: string): boolean | undefined => {
  if (part === "*") return true;
  const m = /^(>=|<=|>|<|=|\^)?(\d+(?:\.\d+)*)$/.exec(part);
  if (!m?.[2]) return undefined;
  const bound = m[2];
  const c = compareVersions(version, bound);
  switch (m[1] ?? "") {
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    case "^": {
      const parts = bound.split(".").map(Number);
      // ^0.4.0 allows 0.4.x; ^8.7.0 allows 8.x from 8.7.0.
      const lead = parts[0] === 0 ? 2 : 1;
      const upper = [...parts.slice(0, lead - 1), (parts[lead - 1] ?? 0) + 1].join(".");
      return c >= 0 && compareVersions(version, upper) < 0;
    }
    case "=":
      return c === 0;
    default:
      // A bare number: `21` means any 21.x; `3.8.0` means exactly 3.8.0.
      return bound.includes(".") ? c === 0 : (parseVersion(version)?.[0] ?? Number.NaN) === Number(bound);
  }
};

/**
 * Whether a version is in a range: space-separated comparators that must all hold (`>=3.0.0 <4.0.0`), `^8.7.0`,
 * a bare major (`21`), an exact version or `*`.
 *
 * @returns False for an unreadable version or range: unknown is never compatible.
 */
export function satisfies(version: string, range: string): boolean {
  if (parseVersion(version) === undefined) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => comparator(version, p) === true);
}
