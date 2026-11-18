import type { ShadowCoverage, ShadowHit, ShadowRegion } from './shadowPaint';
import type { ToneAssignment, ToneMask } from './lightingState';

export function packShadowCoverage(coverage: ShadowCoverage, regions: ShadowRegion[]): Uint32Array {
  const indices = new Map(regions.map((region, index) => [region.id, index]));
  let length = 0;
  for (const faces of coverage.values()) length += faces.size * 4;
  const packed = new Uint32Array(length);
  let index = 0;
  for (const faces of coverage.values()) {
    for (const { faceId, batchIndex, triangleIndex, regionId } of faces.values()) {
      const regionIndex = indices.get(regionId);
      if (regionIndex === undefined) throw new Error('A painted face is missing its assigned region.');
      packed[index++] = faceId;
      packed[index++] = batchIndex;
      packed[index++] = triangleIndex;
      packed[index++] = regionIndex;
    }
  }
  return packed;
}

export function unpackShadowCoverage(packed: Uint32Array, regions: ShadowRegion[]): ShadowCoverage {
  const coverage = new Map<number, Map<number, ShadowHit>>();
  for (let i = 0; i < packed.length; i += 4) {
    const [faceId, batchIndex, triangleIndex, regionIndex] = packed.subarray(i, i + 4);
    let batch = coverage.get(batchIndex);
    if (!batch) {
      batch = new Map();
      coverage.set(batchIndex, batch);
    }
    batch.set(faceId, { faceId, batchIndex, triangleIndex, regionId: regions[regionIndex].id });
  }
  return coverage;
}

export function packToneMask(mask: ToneMask, regions: ShadowRegion[]): Uint32Array {
  const indices = new Map(regions.map((region, index) => [region.id, index]));
  let length = 0;
  for (const faces of mask.values()) length += faces.size * 4;
  const packed = new Uint32Array(length);
  let index = 0;
  for (const [batchIndex, faces] of mask) {
    for (const [faceId, hit] of faces) {
      const regionIndex = indices.get(hit.regionId);
      if (regionIndex === undefined) throw new Error('A lighting mask is missing its assigned region.');
      packed[index++] = faceId;
      packed[index++] = batchIndex;
      packed[index++] = regionIndex;
      packed[index++] = hit.tone === 'highlight' ? 2 : 1;
    }
  }
  return packed;
}

export function unpackToneMask(packed: Uint32Array, regions: ShadowRegion[]): ToneMask {
  const coverage = new Map<number, Map<number, ToneAssignment>>();
  for (let i = 0; i < packed.length; i += 4) {
    const [faceId, batchIndex, regionIndex, value] = packed.subarray(i, i + 4);
    let batch = coverage.get(batchIndex);
    if (!batch) {
      batch = new Map();
      coverage.set(batchIndex, batch);
    }
    batch.set(faceId, { regionId: regions[regionIndex].id, tone: value === 2 ? 'highlight' : 'midtone' });
  }
  return coverage;
}
