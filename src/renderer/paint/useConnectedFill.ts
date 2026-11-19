import { useEffect, useMemo, useState } from 'react';
import { ANCHOR_ADDRESS, type PartAddress } from '../../shared/kit';
import type { PaintPalletApi } from '../../shared/workerProtocol';
import { paintShadowFaces, startShadowStroke, type ShadowCoverage, type SurfaceFace } from './shadowPaint';

export const FILL_PREVIEW_REGION = 'connected-fill-preview';

interface FillSeed {
  modelId: string;
  regionId: string;
  faceId: number;
}

export function* unpackFillFaces(packed: Uint32Array, address: PartAddress = ANCHOR_ADDRESS): Iterable<SurfaceFace> {
  for (let i = 0; i < packed.length; i += 3) {
    yield { faceId: packed[i] + address.faceOffset, batchIndex: packed[i + 1] + address.batchOffset, triangleIndex: packed[i + 2] };
  }
}

export function useConnectedFill(
  api: PaintPalletApi | undefined,
  enabled: boolean,
  modelId: string | undefined,
  regionId: string | undefined,
  coverage: ShadowCoverage,
  part?: PartAddress & { faceCount: number },
  previewBeforeFill = false,
) {
  const [seed, setSeed] = useState<FillSeed | null>(null);
  const [creaseDegrees, setCreaseDegrees] = useState(35);
  const query = useMemo(() => {
    if (!enabled || !seed || seed.modelId !== modelId || seed.regionId !== regionId) return null;
    return { seed, creaseDegrees, coverage, part };
  }, [enabled, seed, modelId, regionId, creaseDegrees, coverage, part]);
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
          const local = hit.faceId - (query.part?.faceOffset ?? 0);
          if (hit.regionId !== query.seed.regionId && (!query.part || (local >= 0 && local < query.part.faceCount))) blockedFaces.push(local);
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
        if (previewBeforeFill) {
          const draft = startShadowStroke(query.coverage, FILL_PREVIEW_REGION, 'brush');
          paintShadowFaces(draft, unpackFillFaces(packed, query.part));
          setResult({ query, packed, coverage: draft.coverage, added: draft.edit.added.length });
        } else {
          setResult({ query, packed });
        }
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
  }, [api, query, previewBeforeFill]);

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
