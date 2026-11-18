import type { ShadowCoverage, ShadowHit, SurfaceFace } from './shadowPaint';

export type GeneratedTone = 'midtone' | 'highlight';
export interface ToneAssignment {
  regionId: string;
  tone: GeneratedTone;
}
export type ToneMask = ReadonlyMap<number, ReadonlyMap<number, ToneAssignment>>;

export function toneColorKey(regionId: string, tone: GeneratedTone): string {
  return `${regionId}:${tone}`;
}

export function generateToneMask(
  coverage: ShadowCoverage,
  exposure: Float32Array,
  midtonePercent: number,
  highlightPercent: number,
) {
  const mask = new Map<number, ReadonlyMap<number, ToneAssignment>>();
  let midtoneFaces = 0;
  let highlightFaces = 0;
  const midtoneCutoff = midtonePercent / 100;
  const highlightCutoff = Math.max(midtonePercent, highlightPercent) / 100;

  for (const [index, faces] of coverage) {
    const batch = new Map<number, ToneAssignment>();
    for (const hit of faces.values()) {
      const score = exposure[hit.faceId];
      if (!(score > 0) || score < midtoneCutoff) continue;
      const highlight = score >= highlightCutoff;
      batch.set(hit.faceId, { regionId: hit.regionId, tone: highlight ? 'highlight' : 'midtone' });
      midtoneFaces++;
      if (highlight) highlightFaces++;
    }
    if (batch.size) mask.set(index, batch);
  }

  return { mask, midtoneFaces, highlightFaces };
}

export function renderToneMask(coverage: ShadowCoverage, mask: ToneMask): ShadowCoverage {
  if (!mask.size) return coverage;
  const rendered = new Map(coverage);
  for (const [index, shades] of mask) {
    const faces = coverage.get(index);
    if (!faces) continue;
    let batch: Map<number, ShadowHit> | null = null;
    for (const [faceId, shade] of shades) {
      const hit = faces.get(faceId);
      if (!hit || hit.regionId !== shade.regionId) continue;
      batch ??= new Map(faces);
      batch.set(faceId, { ...hit, regionId: toneColorKey(hit.regionId, shade.tone) });
    }
    if (batch) rendered.set(index, batch);
  }
  return rendered;
}


export const MASK_BRUSH_TOOLS = {
  'paint-midtone': { tone: 'midtone', erase: false },
  'erase-midtone': { tone: 'midtone', erase: true },
  'paint-highlight': { tone: 'highlight', erase: false },
  'erase-highlight': { tone: 'highlight', erase: true },
} as const;
export type MaskBrushTool = keyof typeof MASK_BRUSH_TOOLS;

export function paintToneFaces(
  mask: ToneMask,
  shadow: ShadowCoverage,
  faces: Iterable<SurfaceFace>,
  tool: MaskBrushTool,
): ToneMask {
  const { tone, erase } = MASK_BRUSH_TOOLS[tool];
  const changes = new Map<number, Map<number, ToneAssignment>>();
  for (const face of faces) {
    const regionId = shadow.get(face.batchIndex)?.get(face.faceId)?.regionId;
    if (!regionId) continue;
    const changed = changes.get(face.batchIndex);
    const original = mask.get(face.batchIndex);
    const former = (changed ?? original)?.get(face.faceId);
    const previous = former?.regionId === regionId ? former.tone : undefined;
    const next = erase
      ? tone === 'midtone' ? undefined : previous === 'highlight' ? 'midtone' : previous
      : previous === 'highlight' ? previous : tone;
    if (next === previous) continue;

    const batch = changed ?? new Map(original);
    if (next) batch.set(face.faceId, { regionId, tone: next });
    else batch.delete(face.faceId);
    changes.set(face.batchIndex, batch);
  }

  if (!changes.size) return mask;
  const nextMask = new Map(mask);
  for (const [index, batch] of changes) {
    if (batch.size) nextMask.set(index, batch);
    else nextMask.delete(index);
  }
  return nextMask;
}
