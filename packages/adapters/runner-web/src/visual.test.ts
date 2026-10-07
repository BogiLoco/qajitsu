import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compareImages } from "./visual.js";

/** A w×h PNG filled with one colour, with an optional differing square at the top left. */
const png = (w: number, h: number, colour: [number, number, number], square = 0): Uint8Array => {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inSquare = x < square && y < square;
      img.data[i] = inSquare ? 255 - colour[0] : colour[0];
      img.data[i + 1] = inSquare ? 255 - colour[1] : colour[1];
      img.data[i + 2] = inSquare ? 255 - colour[2] : colour[2];
      img.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(img));
};

describe("image comparison (REQ-EXEC-12/AC2)", () => {
  it("REQ-EXEC-12/AC2: identical images have no differing pixels; a changed region is counted and drawn", async () => {
    const same = await compareImages(png(40, 30, [20, 120, 220]), png(40, 30, [20, 120, 220]));
    expect(same).toMatchObject({ width: 40, height: 30, diffPixels: 0 });
    const changed = await compareImages(png(40, 30, [20, 120, 220]), png(40, 30, [20, 120, 220], 10));
    expect("diffPixels" in changed && changed.diffPixels).toBeGreaterThanOrEqual(80);
    expect("diff" in changed && PNG.sync.read(Buffer.from(changed.diff)).width).toBe(40);
  });

  it("REQ-EXEC-12/AC2: images of different sizes are not compared", async () => {
    expect(await compareImages(png(40, 30, [0, 0, 0]), png(41, 30, [0, 0, 0]))).toEqual({
      sizeMismatch: "baseline is 40×30, the screenshot 41×30",
    });
  });
});
