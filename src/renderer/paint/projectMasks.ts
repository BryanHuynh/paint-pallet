import type { ShadowCoverage, ShadowHit } from './shadowPaint';
import type { ToneAssignment, ToneMask } from './lightingState';

export function packShadowCoverage(coverage: ShadowCoverage, recipes: readonly { id: string }[],
  painted?: ShadowCoverage): Uint32Array {
  const indices = new Map(recipes.map((recipe, index) => [recipe.id, index]));
  let length = 0;
  for (const faces of coverage.values()) length += faces.size * 4;
  const packed = new Uint32Array(length);
  let index = 0;
  for (const [batch, faces] of coverage) {
    const base = painted?.get(batch);
    for (const { faceId, batchIndex, triangleIndex, recipeId } of faces.values()) {
      if (painted && base?.get(faceId)?.recipeId !== recipeId) continue;
      const recipeIndex = indices.get(recipeId);
      if (recipeIndex === undefined) throw new Error('A painted face is missing its assigned recipe.');
      packed[index++] = faceId;
      packed[index++] = batchIndex;
      packed[index++] = triangleIndex;
      packed[index++] = recipeIndex;
    }
  }
  return packed.subarray(0, index);
}

export function unpackShadowCoverage(packed: Uint32Array, recipes: readonly { id: string }[]): ShadowCoverage {
  const coverage = new Map<number, Map<number, ShadowHit>>();
  for (let i = 0; i < packed.length; i += 4) {
    const [faceId, batchIndex, triangleIndex, recipeIndex] = packed.subarray(i, i + 4);
    let batch = coverage.get(batchIndex);
    if (!batch) {
      batch = new Map();
      coverage.set(batchIndex, batch);
    }
    batch.set(faceId, { faceId, batchIndex, triangleIndex, recipeId: recipes[recipeIndex].id });
  }
  return coverage;
}

export function packToneMask(mask: ToneMask, recipes: readonly { id: string }[], painted: ShadowCoverage): Uint32Array {
  const indices = new Map(recipes.map((recipe, index) => [recipe.id, index]));
  let length = 0;
  for (const faces of mask.values()) length += faces.size * 4;
  const packed = new Uint32Array(length);
  let index = 0;
  for (const [batchIndex, faces] of mask) {
    const base = painted.get(batchIndex);
    if (!base) continue;
    for (const [faceId, hit] of faces) {
      if (base.get(faceId)?.recipeId !== hit.recipeId) continue;
      const recipeIndex = indices.get(hit.recipeId);
      if (recipeIndex === undefined) throw new Error('A lighting mask is missing its assigned recipe.');
      packed[index++] = faceId;
      packed[index++] = batchIndex;
      packed[index++] = recipeIndex;
      packed[index++] = hit.tone === 'highlight' ? 2 : 1;
    }
  }
  return packed.subarray(0, index);
}

export function unpackToneMask(packed: Uint32Array, recipes: readonly { id: string }[]): ToneMask {
  const coverage = new Map<number, Map<number, ToneAssignment>>();
  for (let i = 0; i < packed.length; i += 4) {
    const [faceId, batchIndex, recipeIndex, value] = packed.subarray(i, i + 4);
    let batch = coverage.get(batchIndex);
    if (!batch) {
      batch = new Map();
      coverage.set(batchIndex, batch);
    }
    batch.set(faceId, { recipeId: recipes[recipeIndex].id, tone: value === 2 ? 'highlight' : 'midtone' });
  }
  return coverage;
}
