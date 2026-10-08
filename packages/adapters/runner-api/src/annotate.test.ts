import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { annotateImage } from "./annotate.js";

const white = (w: number, h: number): Uint8Array => {
  const img = new PNG({ width: w, height: h });
  img.data.fill(255);
  return new Uint8Array(PNG.sync.write(img));
};
const pixel = (png: Uint8Array, x: number, y: number): number[] => {
  const img = PNG.sync.read(Buffer.from(png));
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? -1, img.data[i + 1] ?? -1, img.data[i + 2] ?? -1];
};

describe("annotated screenshots (REQ-EVD-08)", () => {
  it("REQ-EVD-08/AC1+AC4: draws a red box around the mark with its number, on a copy", async () => {
    const original = white(120, 100);
    const copy = Uint8Array.from(original);
    const out = await annotateImage(original, [{ n: 1, box: { x: 40, y: 50, width: 30, height: 20 } }]);
    expect(original).toEqual(copy);
    expect(pixel(out, 38, 60)).toEqual([225, 29, 72]); // left edge
    expect(pixel(out, 55, 71)).toEqual([225, 29, 72]); // bottom edge
    expect(pixel(out, 55, 60)).toEqual([255, 255, 255]); // inside stays visible
    expect(pixel(out, 100, 10)).toEqual([255, 255, 255]); // elsewhere untouched
    // The badge with the number sits above the top left corner, red with white digit pixels.
    const badge = [pixel(out, 38, 34), pixel(out, 41, 37)];
    expect(badge).toContainEqual([225, 29, 72]);
  });

  it("REQ-EVD-08/AC1: boxes at the edge are clipped, boxes outside the image are skipped, numbers above 9 fit", async () => {
    const out = await annotateImage(white(60, 40), [
      { n: 12, box: { x: -10, y: -10, width: 30, height: 30 } },
      { n: 3, box: { x: 500, y: 500, width: 10, height: 10 } },
    ]);
    expect(PNG.sync.read(Buffer.from(out)).width).toBe(60);
    expect(pixel(out, 10, 22)).toEqual([225, 29, 72]); // bottom edge of the clipped box
    expect(pixel(out, 50, 35)).toEqual([255, 255, 255]);
  });
});
