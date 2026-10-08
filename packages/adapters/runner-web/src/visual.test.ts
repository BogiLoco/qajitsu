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

/** A white w×h PNG with dark rectangles [x, y, width, height]. */
const blocks = (w: number, h: number, rects: [number, number, number, number][]): Uint8Array => {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dark = rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
      img.data.fill(dark ? 30 : 255, i, i + 3);
      img.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(img));
};

describe("changed regions (REQ-EVD-08/AC3)", () => {
  it("REQ-EVD-08/AC3: a moved element gives a region at the old and at the new place", async () => {
    const before = blocks(200, 120, [[10, 10, 30, 20]]);
    const after = blocks(200, 120, [[150, 80, 30, 20]]);
    const result = await compareImages(before, after);
    expect("regions" in result && result.regions).toHaveLength(2);
    const regions = "regions" in result ? (result.regions ?? []) : [];
    const contains = (x: number, y: number) =>
      regions.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
    expect(contains(25, 20)).toBe(true);
    expect(contains(165, 90)).toBe(true);
    expect(contains(100, 60)).toBe(false);
  });

  it("REQ-EVD-08/AC3: identical images and painted masks give no region; nearby changes form one region", async () => {
    const same = await compareImages(blocks(80, 60, [[5, 5, 10, 10]]), blocks(80, 60, [[5, 5, 10, 10]]));
    expect("regions" in same && same.regions).toEqual([]);
    const near = await compareImages(
      blocks(80, 60, []),
      blocks(80, 60, [
        [10, 10, 6, 6],
        [24, 10, 6, 6],
      ]),
    );
    expect("regions" in near && near.regions).toHaveLength(1);
  });

  it("keeps at most the 20 largest regions", async () => {
    const many: [number, number, number, number][] = [];
    for (let i = 0; i < 30; i++) many.push([(i % 10) * 40 + 2, Math.floor(i / 10) * 40 + 2, 4, 4]);
    const result = await compareImages(blocks(400, 120, []), blocks(400, 120, many));
    expect("regions" in result && result.regions).toHaveLength(20);
  });
});
