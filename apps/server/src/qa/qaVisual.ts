import { decode, encode } from "fast-png";
import pixelmatch from "pixelmatch";

const toRgba = (png: Uint8Array) => {
  const image = decode(png);
  const { width, height, channels } = image;
  const source = image.data;
  if (image.depth !== 8) throw new Error("Only 8-bit screenshots can be compared.");
  if (channels === 4) return { width, height, data: Uint8Array.from(source) };
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const from = pixel * channels;
    const gray = channels <= 2;
    data[pixel * 4] = source[from]!;
    data[pixel * 4 + 1] = source[gray ? from : from + 1]!;
    data[pixel * 4 + 2] = source[gray ? from : from + 2]!;
    data[pixel * 4 + 3] = channels === 2 || channels === 4 ? source[from + channels - 1]! : 255;
  }
  return { width, height, data };
};

/**
 * How much of `capture` differs from `baseline`, and a PNG that marks where. Captures of different
 * sizes differ entirely: the replay's fixed viewport makes that a real layout change.
 */
export function compareScreenshots(
  baseline: Uint8Array,
  capture: Uint8Array,
): { readonly diffRatio: number; readonly diffPng: Uint8Array | null } {
  const before = toRgba(baseline);
  const after = toRgba(capture);
  if (before.width !== after.width || before.height !== after.height)
    return { diffRatio: 1, diffPng: null };
  const { width, height } = after;
  const diff = new Uint8Array(width * height * 4);
  const differing = pixelmatch(before.data, after.data, diff, width, height, { threshold: 0.1 });
  return {
    diffRatio: width * height === 0 ? 0 : differing / (width * height),
    diffPng: differing === 0 ? null : encode({ width, height, data: diff, channels: 4 }),
  };
}
