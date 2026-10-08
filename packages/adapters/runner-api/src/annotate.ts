import type { ScreenMark } from "@qajitsu/core";
import { PNG } from "pngjs";

const RED = [225, 29, 72] as const;
const WHITE = [255, 255, 255] as const;
const LINE = 3;
const SCALE = 3;

/** 3×5 pixel digits for the mark numbers. */
const DIGITS: Readonly<Record<string, readonly string[]>> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

/**
 * Draws a numbered red box around each mark on a copy of a PNG (REQ-EVD-08). Boxes are clipped to the image; the
 * number sits in a red badge at the box's top left corner. The input is never changed.
 *
 * @param png - The screenshot.
 * @param marks - Numbered boxes in the screenshot's pixels.
 * @returns A new PNG.
 */
export function annotateImage(png: Uint8Array, marks: readonly ScreenMark[]): Promise<Uint8Array> {
  const img = PNG.sync.read(Buffer.from(png));
  const { width, height, data } = img;
  const set = (x: number, y: number, c: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = 255;
  };
  const fill = (x0: number, y0: number, w: number, h: number, c: readonly [number, number, number]): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c);
  };
  for (const { n, box } of marks) {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const right = Math.min(width - 1, Math.round(box.x + box.width));
    const bottom = Math.min(height - 1, Math.round(box.y + box.height));
    if (right < x || bottom < y) continue;
    fill(x - LINE, y - LINE, right - x + 2 * LINE + 1, LINE, RED);
    fill(x - LINE, bottom + 1, right - x + 2 * LINE + 1, LINE, RED);
    fill(x - LINE, y, LINE, bottom - y + 1, RED);
    fill(right + 1, y, LINE, bottom - y + 1, RED);
    const label = String(n);
    const badgeW = label.length * 4 * SCALE + 2 * SCALE;
    const badgeH = 7 * SCALE;
    const bx = Math.min(Math.max(0, x - LINE), Math.max(0, width - badgeW));
    const by = y - LINE - badgeH >= 0 ? y - LINE - badgeH : Math.min(y, Math.max(0, height - badgeH));
    fill(bx, by, badgeW, badgeH, RED);
    Array.from(label).forEach((ch, k) => {
      (DIGITS[ch] ?? []).forEach((row, ry) => {
        Array.from(row).forEach((bit, rx) => {
          if (bit === "1")
            fill(bx + SCALE + (k * 4 + rx) * SCALE, by + SCALE + ry * SCALE, SCALE, SCALE, WHITE);
        });
      });
    });
  }
  return Promise.resolve(new Uint8Array(PNG.sync.write(img)));
}
