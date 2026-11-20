import type { ShadowCoverage, ShadowHit, SurfaceFace } from './shadowPaint';

export type GeneratedTone = 'midtone' | 'highlight';
export interface ToneAssignment {
  recipeId: string;
  tone: GeneratedTone;
}
export type ToneMask = ReadonlyMap<number, ReadonlyMap<number, ToneAssignment>>;

export interface LightTonePreview {
  scores: Float32Array;
  midtone: number;
  highlight: number;
}

export function summarizeExposure(coverage: ShadowCoverage, exposure: Float32Array) {
  const bins = new Uint32Array(101);
  let unlit = 0;
  for (const faces of coverage.values()) {
    for (const { faceId } of faces.values()) {
      const score = exposure[faceId];
      if (score > 0) bins[Math.min(100, Math.floor(score * 100))]++;
      else unlit++;
    }
  }
  const atOrAbove = bins.slice();
  for (let i = 99; i >= 0; i--) atOrAbove[i] += atOrAbove[i + 1];
  bins[0] += unlit;
  return { bins, atOrAbove };
}

export function toneColorKey(recipeId: string, tone: GeneratedTone): string {
  return `${recipeId}:${tone}`;
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
      batch.set(hit.faceId, { recipeId: hit.recipeId, tone: highlight ? 'highlight' : 'midtone' });
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
      if (!hit || hit.recipeId !== shade.recipeId) continue;
      batch ??= new Map(faces);
      batch.set(faceId, { ...hit, recipeId: toneColorKey(hit.recipeId, shade.tone) });
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
    const recipeId = shadow.get(face.batchIndex)?.get(face.faceId)?.recipeId;
    if (!recipeId) continue;
    const changed = changes.get(face.batchIndex);
    const original = mask.get(face.batchIndex);
    const former = (changed ?? original)?.get(face.faceId);
    const previous = former?.recipeId === recipeId ? former.tone : undefined;
    const next = erase
      ? tone === 'midtone' ? undefined : previous === 'highlight' ? 'midtone' : previous
      : previous === 'highlight' ? previous : tone;
    if (next === previous) continue;

    const batch = changed ?? new Map(original);
    if (next) batch.set(face.faceId, { recipeId, tone: next });
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
