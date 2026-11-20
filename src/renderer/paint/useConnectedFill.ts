import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { ANCHOR_ADDRESS, type PartAddress } from '../../shared/kit';
import type { ModelSummary, PaintPalletApi } from '../../shared/workerProtocol';
import { paintShadowFaces, startShadowStroke, type ShadowCoverage, type SurfaceFace } from './shadowPaint';

export const FILL_PREVIEW_RECIPE = 'connected-fill-preview';

interface FillSeed {
  model: ModelSummary;
  address: PartAddress;
  recipeId: string;
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
  recipeId: string | undefined,
  coverage: ShadowCoverage,
  previewBeforeFill: boolean,
  repaint: boolean,
  commit: (faces: Iterable<SurfaceFace>, repaint: boolean) => void,
) {
  const [seeds, setSeeds] = useState<FillSeed[]>([]);
  const seed = seeds[0];
  const [creaseDegrees, setCreaseDegrees] = useState(35);
  const query = useMemo(() => {
    if (!enabled || !seed || seed.recipeId !== recipeId) return null;
    return { seed, creaseDegrees, coverage, previewBeforeFill, repaint };
  }, [enabled, seed, recipeId, creaseDegrees, coverage, previewBeforeFill, repaint]);
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
      const draft = startShadowStroke(completed.coverage, FILL_PREVIEW_RECIPE, completed.repaint ? 'repaint' : 'brush');
      function* changedFaces() {
        for (const face of unpackFillFaces(packed, completed.seed.address)) {
          if (completed.coverage.get(face.batchIndex)?.get(face.faceId)?.recipeId !== completed.seed.recipeId) yield face;
        }
      }
      paintShadowFaces(draft, changedFaces());
      setResult({ query: completed, packed, coverage: draft.coverage, added: draft.edit.added.length });
    } else {
      commit(unpackFillFaces(packed, completed.seed.address), completed.repaint);
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
      const { model, address } = query.seed;
      const painted = model.batches.flatMap(({ batchIndex }) => {
        const batch = query.coverage.get(batchIndex + address.batchOffset);
        return batch ? [batch] : [];
      });
      const seedFaceId = query.seed.faceId + address.faceOffset;
      const sourceRecipe = query.repaint
        ? painted.find((batch) => batch.has(seedFaceId))?.get(seedFaceId)?.recipeId
        : undefined;
      const passableRecipe = sourceRecipe ?? query.seed.recipeId;
      for (const batch of painted) {
        for (const hit of batch.values()) {
          if (hit.recipeId !== passableRecipe) blockedFaces.push(hit.faceId - address.faceOffset);
        }
      }

      try {
        const packed = await preview({
          jobId,
          modelId: model.modelId,
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
    added: ready?.added ?? 0,
    error: ready?.error ?? error,
    creaseDegrees,
    setCreaseDegrees,
    applyPreview() {
      if (ready?.packed && ready.query.previewBeforeFill) {
        commit(unpackFillFaces(ready.packed, ready.query.seed.address), ready.query.repaint);
      }
    },
    select(next: FillSeed) {
      setError(undefined);
      setSeeds((previous) => previewBeforeFill ? [next] : [...previous, next]);
    },
    cancel,
  };
}
