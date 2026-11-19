import type { PixelRect, ToneSuggestions } from './types';

function byteToHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
}

export function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return `#${match[1].toUpperCase()}`;
}

export function mapClientToCanvasPixel(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
  const x = Math.max(
    0,
    Math.min(canvas.width - 1, Math.floor((clientX - rect.left) * scaleX)),
  );
  const y = Math.max(
    0,
    Math.min(canvas.height - 1, Math.floor((clientY - rect.top) * scaleY)),
  );
  return { x, y };
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export interface OklabSample {
  L: number;
  a: number;
  b: number;
  r: number;
  g: number;
  bl: number;
}

export function rgbToOklabSample(r: number, g: number, bl: number): OklabSample {
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(bl);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    r,
    g,
    bl,
  };
}

export function suggestTonesFromImageData(
  imageData: ImageData,
  selection?: { mask: Uint8Array; count: number },
): ToneSuggestions | null {
  const totalPixels = imageData.width * imageData.height;
  if (totalPixels === 0) {
    return null;
  }

  const stride = Math.max(1, selection ? Math.ceil(selection.count / 12000) : Math.floor(totalPixels / 12000));
  const samples: OklabSample[] = [];
  const data = imageData.data;

  let selectedIndex = 0;
  for (let i = 0; i < totalPixels; i += selection ? 1 : stride) {
    if (selection && (!selection.mask[i] || selectedIndex++ % stride !== 0)) continue;
    const offset = i * 4;
    if (data[offset + 3] < 128) {
      continue;
    }
    samples.push(rgbToOklabSample(data[offset], data[offset + 1], data[offset + 2]));
  }

  if (samples.length === 0) {
    return null;
  }

  const sortedByLightness = [...samples].sort((x, y) => x.L - y.L);
  const seedIndices = [
    Math.floor((sortedByLightness.length - 1) * 0.15),
    Math.floor((sortedByLightness.length - 1) * 0.5),
    Math.floor((sortedByLightness.length - 1) * 0.85),
  ];

  const centroids = seedIndices.map((idx) => ({
    L: sortedByLightness[idx].L,
    a: sortedByLightness[idx].a,
    b: sortedByLightness[idx].b,
  }));

  const assignments = new Int32Array(samples.length);

  for (let iter = 0; iter < 10; iter++) {
    let changed = false;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < 3; c++) {
        const dL = s.L - centroids[c].L;
        const da = s.a - centroids[c].a;
        const db = s.b - centroids[c].b;
        const dist = dL * dL + da * da + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }

    const sums = [
      { L: 0, a: 0, b: 0, count: 0 },
      { L: 0, a: 0, b: 0, count: 0 },
      { L: 0, a: 0, b: 0, count: 0 },
    ];
    for (let i = 0; i < samples.length; i++) {
      const c = assignments[i];
      sums[c].L += samples[i].L;
      sums[c].a += samples[i].a;
      sums[c].b += samples[i].b;
      sums[c].count += 1;
    }

    for (let c = 0; c < 3; c++) {
      if (sums[c].count > 0) {
        centroids[c].L = sums[c].L / sums[c].count;
        centroids[c].a = sums[c].a / sums[c].count;
        centroids[c].b = sums[c].b / sums[c].count;
      }
    }

    if (!changed) {
      break;
    }
  }

  const clusterRgb = [0, 1, 2].map((c) => {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;
    for (let i = 0; i < samples.length; i++) {
      if (assignments[i] === c) {
        sumR += samples[i].r;
        sumG += samples[i].g;
        sumB += samples[i].bl;
        count += 1;
      }
    }
    if (count === 0) {
      const fallback = sortedByLightness[seedIndices[c]];
      return {
        L: fallback.L,
        hex: rgbToHex(fallback.r, fallback.g, fallback.bl),
      };
    }
    return {
      L: centroids[c].L,
      hex: rgbToHex(sumR / count, sumG / count, sumB / count),
    };
  });

  clusterRgb.sort((x, y) => x.L - y.L);

  return {
    shadow: clusterRgb[0].hex,
    midtone: clusterRgb[1].hex,
    highlight: clusterRgb[2].hex,
  };
}

const MAX_AREA_SAMPLE_PIXELS = 65536;

export function readBoundedRegionImageData(
  sourceCanvas: HTMLCanvasElement,
  rect: PixelRect,
  maxSamplePixels = MAX_AREA_SAMPLE_PIXELS,
): ImageData | null {
  const area = rect.width * rect.height;
  if (area <= 0) {
    return null;
  }
  if (area <= maxSamplePixels) {
    const ctx = sourceCanvas.getContext('2d');
    return ctx ? ctx.getImageData(rect.x, rect.y, rect.width, rect.height) : null;
  }

  const scale = Math.sqrt(maxSamplePixels / area);
  const sampleW = Math.max(1, Math.floor(rect.width * scale));
  const sampleH = Math.max(1, Math.floor(rect.height * scale));
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sampleW;
  sampleCanvas.height = sampleH;
  const sampleCtx = sampleCanvas.getContext('2d');
  if (!sampleCtx) {
    return null;
  }
  sampleCtx.imageSmoothingEnabled = false;
  sampleCtx.drawImage(
    sourceCanvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    sampleW,
    sampleH,
  );
  return sampleCtx.getImageData(0, 0, sampleW, sampleH);
}
