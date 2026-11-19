import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
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
  part: (PartAddress & { faceCount: number }) | undefined,
  previewBeforeFill: boolean,
  commit: (faces: Iterable<SurfaceFace>) => void,
) {
  const [seeds, setSeeds] = useState<FillSeed[]>([]);
  const seed = seeds[0];
  const [creaseDegrees, setCreaseDegrees] = useState(35);
  const query = useMemo(() => {
    if (!enabled || !seed || seed.modelId !== modelId || seed.regionId !== regionId) return null;
    return { seed, creaseDegrees, coverage, part, previewBeforeFill };
  }, [enabled, seed, modelId, regionId, creaseDegrees, coverage, part, previewBeforeFill]);
  const [result, setResult] = useState<{
    query: NonNullable<typeof query>;
    packed?: Uint32Array;
    coverage?: ShadowCoverage;
    added?: number;
    error?: string;
  } | null>(null);
  const [error, setError] = useState<string>();

  const finish = useEffectEvent((completed: NonNullable<typeof query>, packed: Uint32Array) => {
    if (query !== completed) return;
    if (completed.previewBeforeFill) {
      const draft = startShadowStroke(completed.coverage, FILL_PREVIEW_REGION, 'brush');
      paintShadowFaces(draft, unpackFillFaces(packed, completed.part));
      setResult({ query: completed, packed, coverage: draft.coverage, added: draft.edit.added.length });
    } else {
      commit(unpackFillFaces(packed, completed.part));
      setSeeds((previous) => previous.slice(1));
    }
  });

  const fail = useEffectEvent((completed: NonNullable<typeof query>, failure: unknown) => {
    if (query !== completed) return;
    const message = failure instanceof Error ? failure.message : 'Could not prepare the connected fill.';
    if (completed.previewBeforeFill) setResult({ query: completed, error: message });
    else {
      setError(message);
      setSeeds((previous) => previous.slice(1));
    }
  });

  useEffect(() => {
    const preview = api?.previewConnectedFill;
    if (!query || !preview) return;
    let active = true;
    let started = false;
    const jobId = crypto.randomUUID();
    const run = async () => {
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
        if (active) finish(query, packed);
      } catch (error) {
        if (active) fail(query, error);
      } finally {
        started = false;
      }
    };
    const timeout = window.setTimeout(run, query.previewBeforeFill ? 120 : 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      if (started) void api?.cancelConnectedFill?.(jobId).catch(() => {});
    };
  }, [api, query]);

  const cancel = useCallback(() => {
    setSeeds([]);
    setResult(null);
    setError(undefined);
  }, []);

  useEffect(() => {
    if (!enabled) cancel();
  }, [cancel, enabled]);

  const ready = result?.query === query ? result : null;
  return {
    available: Boolean(api?.previewConnectedFill),
    seeded: Boolean(query),
    loading: Boolean(query && !ready),
    previewCoverage: ready?.coverage,
    packed: ready?.packed,
    added: ready?.added ?? 0,
    error: ready?.error ?? error,
    creaseDegrees,
    setCreaseDegrees,
    select(next: FillSeed) {
      setError(undefined);
      setSeeds((previous) => previewBeforeFill ? [next] : [...previous, next]);
    },
    cancel,
  };
}
