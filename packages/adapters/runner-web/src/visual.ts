import type { ImageComparison } from "@qajitsu/core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const DIFF: [number, number, number] = [255, 0, 0];
const CELL = 8;
const MAX_REGIONS = 20;

/**
 * Groups the differing pixels of a pixelmatch diff into rectangles (REQ-EVD-08/AC3): the image is split into 8×8
 * cells, cells with a differing pixel that are at most one free cell apart form one region, and each region becomes
 * its bounding box with a small margin. At most 20 regions, the largest first.
 *
 * @param diff - RGBA pixels of the diff image; differing pixels are pure red.
 * @param width - Image width.
 * @param height - Image height.
 */
export function diffRegions(
  diff: Uint8Array,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number }[] {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const hot = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (diff[i] === 255 && diff[i + 1] === 0 && diff[i + 2] === 0)
        hot[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
    }
  const seen = new Uint8Array(cols * rows);
  const boxes: { x: number; y: number; width: number; height: number; cells: number }[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (hot[start] !== 1 || seen[start] === 1) continue;
    let minC = cols;
    let minR = rows;
    let maxC = 0;
    let maxR = 0;
    let cells = 0;
    const stack = [start];
    seen[start] = 1;
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      const c = at % cols;
      const r = Math.floor(at / cols);
      cells += 1;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const next = nr * cols + nc;
          if (hot[next] === 1 && seen[next] !== 1) {
            seen[next] = 1;
            stack.push(next);
          }
        }
    }
    const x = Math.max(0, minC * CELL - 4);
    const y = Math.max(0, minR * CELL - 4);
    boxes.push({
      x,
      y,
      width: Math.min(width, (maxC + 1) * CELL + 4) - x,
      height: Math.min(height, (maxR + 1) * CELL + 4) - y,
      cells,
    });
  }
  return boxes
    .sort((p, q) => q.cells - p.cells)
    .slice(0, MAX_REGIONS)
    .map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }));
}

/**
 * Compares a screenshot with its baseline pixel by pixel (REQ-EXEC-12/AC2): anti-aliasing is ignored, `colorThreshold`
 * is pixelmatch's per-pixel sensitivity. Images of different sizes are not compared. The caller decides with the
 * plan's threshold whether the share of differing pixels passes.
 *
 * @param baseline - PNG of the approved baseline.
 * @param actual - PNG of this run.
 * @param colorThreshold - 0 (exact) to 1; 0.1 by default.
 */
export function compareImages(
  baseline: Uint8Array,
  actual: Uint8Array,
  colorThreshold = 0.1,
): Promise<ImageComparison> {
  const a = PNG.sync.read(Buffer.from(baseline));
  const b = PNG.sync.read(Buffer.from(actual));
  if (a.width !== b.width || a.height !== b.height)
    return Promise.resolve({
      sizeMismatch: `baseline is ${String(a.width)}×${String(a.height)}, the screenshot ${String(b.width)}×${String(b.height)}`,
    });
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: colorThreshold,
    diffColor: DIFF,
  });
  return Promise.resolve({
    width: a.width,
    height: a.height,
    diffPixels,
    diff: new Uint8Array(PNG.sync.write(diff)),
    regions: diffRegions(diff.data, a.width, a.height),
  });
}
