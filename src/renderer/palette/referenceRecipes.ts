import { rgbToHex, rgbToOklabSample, type OklabSample } from './colorMath';
import type { ToneSuggestions } from './types';

type Point = Pick<OklabSample, 'L' | 'a' | 'b'>;
export interface ReferenceRecipe {
  name: string;
  tones: ToneSuggestions;
}

const MAX_RECIPES = 6;

function distance(a: Point, b: Point) {
  return .35 * (a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2;
}

function nearest(point: Point, centers: readonly Point[]) {
  let index = 0;
  for (let i = 1; i < centers.length; i++) {
    if (distance(point, centers[i]) < distance(point, centers[index])) index = i;
  }
  return index;
}

function foreground(image: ImageData): OklabSample[] {
  const pixels: OklabSample[] = [];
  const border: OklabSample[] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = (y * image.width + x) * 4;
      if (image.data[index + 3] < 160) continue;
      const point = rgbToOklabSample(image.data[index], image.data[index + 1], image.data[index + 2]);
      pixels.push(point);
      if (x === 0 || x === image.width - 1 || y === 0 || y === image.height - 1) border.push(point);
    }
  }
  if (border.length < 12) return pixels;
  const candidate = border[Math.floor(border.length / 2)];
  if (border.filter((point) => distance(point, candidate) < .0016).length < border.length * .68) return pixels;
  const retained = pixels.filter((point) => distance(point, candidate) >= .0016);
  return retained.length >= pixels.length * .12 ? retained : pixels;
}

function colorName(point: Point) {
  if (Math.hypot(point.a, point.b) < .033) {
    return point.L < .35 ? 'Charcoal' : point.L < .75 ? 'Gray' : 'Ivory';
  }
  const hue = (Math.atan2(point.b, point.a) * 180 / Math.PI + 360) % 360;
  if (hue < 36 || hue >= 348) return 'Red';
  if (hue < 72) return point.L < .62 ? 'Brown' : 'Orange';
  if (hue < 118) return 'Gold';
  if (hue < 166) return 'Green';
  if (hue < 209) return 'Teal';
  if (hue < 275) return 'Blue';
  if (hue < 320) return 'Violet';
  return 'Rose';
}

function toTones(samples: OklabSample[]) {
  const ordered = samples.slice().sort((a, b) => a.L - b.L);
  const choose = (percentile: number) => ordered[Math.round((ordered.length - 1) * percentile)];
  const dark = choose(.12), middle = choose(.5), light = choose(.88);
  const hex = (sample: OklabSample) => rgbToHex(sample.r, sample.g, sample.bl);
  return {
    shadow: middle.L - dark.L >= .045 ? hex(dark) : rgbToHex(middle.r * .7, middle.g * .7, middle.bl * .7),
    midtone: hex(middle),
    highlight: light.L - middle.L >= .045 ? hex(light) :
      rgbToHex(middle.r * .67 + 255 * .33, middle.g * .67 + 255 * .33, middle.bl * .67 + 255 * .33),
  };
}

export function generateReferenceRecipes(images: readonly ImageData[]): ReferenceRecipe[] {
  const pixels = images.flatMap(foreground);
  if (!pixels.length) return [];
  // Fit the color clusters from the supplied images using perceptual color coordinates.
  const first = pixels[Math.floor(pixels.length / 2)];
  const centers: Point[] = [first];
  while (centers.length < MAX_RECIPES) {
    let farthest: Point = first;
    let separation = 0;
    for (const point of pixels) {
      const gap = distance(point, centers[nearest(point, centers)]);
      if (gap > separation) {
        farthest = point;
        separation = gap;
      }
    }
    if (separation < .012) break;
    centers.push(farthest);
  }
  let groups: OklabSample[][] = [];
  for (let iteration = 0; iteration < 8; iteration++) {
    groups = centers.map(() => []);
    for (const point of pixels) groups[nearest(point, centers)].push(point);
    groups.forEach((group, index) => {
      if (!group.length) return;
      const sum = group.reduce((total, point) => ({
        L: total.L + point.L, a: total.a + point.a, b: total.b + point.b,
      }), { L: 0, a: 0, b: 0 });
      centers[index] = { L: sum.L / group.length, a: sum.a / group.length, b: sum.b / group.length };
    });
  }

  const named = new Map<string, OklabSample[]>();
  const minimumSupport = Math.max(1, pixels.length * .025);
  for (const { group, center } of groups.map((group, index) => ({ group, center: centers[index] }))
    .sort((a, b) => b.group.length - a.group.length)) {
    if (group.length < minimumSupport && named.size) continue;
    const name = colorName(center);
    const prior = named.get(name);
    if (prior) {
      for (const sample of group) prior.push(sample);
    } else named.set(name, group);
  }
  return [...named].map(([name, samples]) => ({ name, tones: toTones(samples) }));
}
