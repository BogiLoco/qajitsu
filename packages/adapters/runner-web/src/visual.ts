import type { ImageComparison } from "@qajitsu/core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

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
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: colorThreshold });
  return Promise.resolve({
    width: a.width,
    height: a.height,
    diffPixels,
    diff: new Uint8Array(PNG.sync.write(diff)),
  });
}
