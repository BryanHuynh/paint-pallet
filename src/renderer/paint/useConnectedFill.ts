import { useEffect, useMemo, useState } from 'react';
import type { PaintPalletApi } from '../../shared/workerProtocol';
import { paintShadowFaces, startShadowStroke, type ShadowCoverage, type SurfaceFace } from './shadowPaint';

export const FILL_PREVIEW_REGION = 'connected-fill-preview';

interface FillSeed {
  modelId: string;
  regionId: string;
  faceId: number;
}

export function* unpackFillFaces(packed: Uint32Array): Iterable<SurfaceFace> {
  for (let i = 0; i < packed.length; i += 3) {
    yield { faceId: packed[i], batchIndex: packed[i + 1], triangleIndex: packed[i + 2] };
  }
}

export function useConnectedFill(
  api: PaintPalletApi | undefined,
  enabled: boolean,
  modelId: string | undefined,
  regionId: string | undefined,
  coverage: ShadowCoverage,
) {
  const [seed, setSeed] = useState<FillSeed | null>(null);
  const [creaseDegrees, setCreaseDegrees] = useState(35);
  const query = useMemo(() => {
    if (!enabled || !seed || seed.modelId !== modelId || seed.regionId !== regionId) return null;
    return { seed, creaseDegrees, coverage };
  }, [enabled, seed, modelId, regionId, creaseDegrees, coverage]);
  const [result, setResult] = useState<{
    query: NonNullable<typeof query>;
    packed?: Uint32Array;
    coverage?: ShadowCoverage;
    added?: number;
    error?: string;
  } | null>(null);

  useEffect(() => {
    const preview = api?.previewConnectedFill;
    if (!query || !preview) return;
    let active = true;
    let started = false;
    const jobId = crypto.randomUUID();
    const timeout = window.setTimeout(async () => {
      started = true;
      const blockedFaces: number[] = [];
      for (const batch of query.coverage.values()) {
        for (const hit of batch.values()) {
          if (hit.regionId !== query.seed.regionId) blockedFaces.push(hit.faceId);
        }
      }

      try {
        const packed = await preview({
          jobId,
          modelId: query.seed.modelId,
          faceId: query.seed.faceId,
          maxCreaseDegrees: query.creaseDegrees,
          blockedFaces,
        });
        if (!active) return;
        const draft = startShadowStroke(query.coverage, FILL_PREVIEW_REGION, 'brush');
        paintShadowFaces(draft, unpackFillFaces(packed));
        setResult({ query, packed, coverage: draft.coverage, added: draft.edit.added.length });
      } catch (error) {
        if (active) {
          setResult({ query, error: error instanceof Error ? error.message : 'Could not preview the connected fill.' });
        }
      } finally {
        started = false;
      }
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      if (started) void api?.cancelConnectedFill?.(jobId).catch(() => {});
    };
  }, [api, query]);

  const ready = result?.query === query ? result : null;
  return {
    available: Boolean(api?.previewConnectedFill),
    seeded: Boolean(query),
    loading: Boolean(query && !ready),
    previewCoverage: ready?.coverage,
    packed: ready?.packed,
    added: ready?.added ?? 0,
    error: ready?.error,
    creaseDegrees,
    setCreaseDegrees,
    select: setSeed,
    cancel: () => {
      setSeed(null);
      setResult(null);
    },
  };
}
