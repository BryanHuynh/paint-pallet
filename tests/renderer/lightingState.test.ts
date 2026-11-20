// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { ExposureRequest, PaintPalletApi } from '../../src/shared/workerProtocol';
import { dragLightDirection } from '../../src/renderer/components/lightHandle';
import type { ShadowCoverage } from '../../src/renderer/paint/shadowPaint';
import { lightAngles, useSurfaceLighting, worldLightDirection } from '../../src/renderer/paint/useSurfaceLighting';
import type { ProjectState } from '../../src/shared/paintProject';
import { generateToneMask, summarizeExposure } from '../../src/renderer/paint/lightingState';
import { createEmptyRecipe } from '../../src/renderer/palette/recipes';
import { IDENTITY_PART_POSE } from '../../src/shared/kit';

describe('directional lighting preview', () => {
  const orientation = { upright: '+Y', front: '+Z' } as const;
  const coverage: ShadowCoverage = new Map([[0, new Map([
    [0, { faceId: 0, recipeId: 'cloth', batchIndex: 0, triangleIndex: 0 }],
    [1, { faceId: 1, recipeId: 'cloth', batchIndex: 0, triangleIndex: 1 }],
    [2, { faceId: 2, recipeId: 'cloth', batchIndex: 0, triangleIndex: 2 }],
  ])]]);

  it('counts histogram cutoffs the same way as the committed tone mask', () => {
    const scores = Float32Array.of(0, 0.35, 1);
    const histogram = summarizeExposure(coverage, scores);
    expect(histogram.bins.reduce((sum, count) => sum + count, 0)).toBe(3);
    for (const cutoff of [0, 34, 35, 36, 100]) {
      const mask = generateToneMask(coverage, scores, cutoff, cutoff);
      expect(histogram.atOrAbove[cutoff]).toBe(mask.highlightFaces);
    }
  });

  it('retraces with inter-part shadows off and records the setting in the project', async () => {
    const compute = vi.fn<(request: ExposureRequest) => Promise<Float32Array>>()
      .mockResolvedValueOnce(Float32Array.of(0, 0.5, 1))
      .mockResolvedValueOnce(Float32Array.of(0.9, 0.5, 1));
    const api = { computeLightExposure: compute } as unknown as PaintPalletApi;
    const parts = [
      { modelId: 'model', pose: IDENTITY_PART_POSE, faceOffset: 0 },
      { modelId: 'trim', pose: IDENTITY_PART_POSE, faceOffset: 2 },
    ];
    const { result } = renderHook(() => useSurfaceLighting(api, 'model', orientation, coverage, parts, 'kit'));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.draft?.midtoneFaces).toBe(2));
    expect(result.current.castShadowsBetweenParts).toBe(true);
    act(() => result.current.setCastShadowsBetweenParts(false));
    await waitFor(() => expect(result.current.draft?.midtoneFaces).toBe(3));
    expect(compute.mock.calls[1][0].castShadowsBetweenParts).toBe(false);
    act(() => result.current.apply());
    const saved = result.current.exportProject([{ ...createEmptyRecipe(1), id: 'cloth' }], coverage);
    expect(saved.lighting).toMatchObject({ castShadowsBetweenParts: false });
  });

  it('combines light sources using independent intensities without retracing for intensity changes', async () => {
    const compute = vi.fn<(request: ExposureRequest) => Promise<Float32Array>>()
      .mockResolvedValueOnce(Float32Array.of(0.5, 0, 0))
      .mockResolvedValueOnce(Float32Array.of(1, 1, 0));
    const api = { computeLightExposure: compute } as unknown as PaintPalletApi;
    const { result } = renderHook(() => useSurfaceLighting(api, 'model', orientation, coverage));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.lightPreview?.scores[0]).toBeCloseTo(0.5));
    const main = result.current.source!.id;
    act(() => result.current.addSource());
    await waitFor(() => expect(result.current.lightPreview?.scores[0]).toBeCloseTo(0.8));
    expect(result.current.draft?.midtoneFaces).toBe(1);
    act(() => result.current.setIntensity(50));
    await waitFor(() => expect(result.current.lightPreview?.scores[1]).toBeCloseTo(0.5));
    expect(result.current.draft?.midtoneFaces).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
    const fill = result.current.source!.id;
    act(() => result.current.selectSource(main));
    expect(result.current.intensity).toBe(100);
    expect(result.current.lightPreview?.scores[1]).toBeCloseTo(0.5);
    act(() => { result.current.selectSource(fill); result.current.removeSource(); });
    await waitFor(() => expect(result.current.lightPreview?.scores[1]).toBe(0));
    expect(result.current.sources).toHaveLength(1);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('converts a camera light direction to the same world direction used by the viewport', () => {
    expect(lightAngles([0, 0, 1])).toEqual({ azimuth: 0, elevation: 0 });
    expect(lightAngles([-1, 0, 0])).toEqual({ azimuth: 270, elevation: 0 });
    expect(lightAngles([0, 1, 0])).toEqual({ azimuth: 0, elevation: 90 });
    for (const [azimuth, elevation] of [[355, 27], [45, -33], [180, 3]]) {
      expect(lightAngles(worldLightDirection(azimuth, elevation).toArray())).toEqual({ azimuth, elevation });
    }
  });

  it('moves the light toward the pointer on both hemispheres of an orbited camera', () => {
    const camera = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
    const viewRight = new Vector3(1, 0, 0).applyQuaternion(camera);
    for (const depth of [-1, 1]) {
      const direction = new Vector3(0, 0, depth).applyQuaternion(camera).toArray();
      const next = new Vector3(...dragLightDirection(direction, camera, 60, -60, 600));
      expect(next.dot(viewRight)).toBeGreaterThan(0.25);
      expect(next.y).toBeGreaterThan(0.25);
      expect(next.length()).toBeCloseTo(1);
    }
  });

  it('reuses exposure for cutoff edits and preserves committed masks while a new angle computes', async () => {
    const compute = vi.fn<(request: ExposureRequest) => Promise<Float32Array>>();
    compute.mockResolvedValueOnce(Float32Array.of(0, 0.5, 1));
    let resolveNewAngle: (scores: Float32Array) => void = () => {};
    compute.mockImplementationOnce(() => new Promise((resolve) => { resolveNewAngle = resolve; }));
    const api = { computeLightExposure: compute } as unknown as PaintPalletApi;
    const { result } = renderHook(() => useSurfaceLighting(api, 'model', orientation, coverage));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.draft?.midtoneFaces).toBe(2));
    expect(result.current.draft?.highlightFaces).toBe(1);

    act(() => result.current.setMidtone(60));
    expect(result.current.draft?.midtoneFaces).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
    act(() => result.current.apply());
    const committedMask = result.current.mask;

    act(() => {
      result.current.setAzimuth(90);
      result.current.start();
    });
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(true);
    expect(result.current.mask).toBe(committedMask);
    act(() => resolveNewAngle(Float32Array.of(0, 0.99, 0.1)));
    await waitFor(() => expect(result.current.lightPreview?.scores[1]).toBeCloseTo(0.99));
    act(() => result.current.cancel());
    expect(result.current.mask).toBe(committedMask);
  });

  it('refreshes a restored automatic mask and keeps giving newly painted faces the applied light', async () => {
    const compute = vi.fn<(request: ExposureRequest) => Promise<Float32Array>>()
      .mockResolvedValue(Float32Array.of(0.9, 0.5, 1));
    const api = { computeLightExposure: compute } as unknown as PaintPalletApi;
    const original: ShadowCoverage = new Map([[0, new Map([...coverage.get(0)!].slice(0, 2))]]);
    const { result, rerender } = renderHook(({ paint }: { paint: ShadowCoverage }) =>
      useSurfaceLighting(api, 'model', orientation, paint), { initialProps: { paint: original } });
    const recipes = [{ ...createEmptyRecipe(1), id: 'cloth' }];
    const state: ProjectState = {
      orientation, recipes, activeRecipeId: 'cloth', references: [], activeReferenceId: null,
      lighting: {
        sources: [{ id: 'light', name: 'Light', azimuth: 15, elevation: 36, intensity: 100 }],
        activeSourceId: 'light', midtone: 32, highlight: 66, castShadowsBetweenParts: true, applied: true, manual: false,
      },
    };

    act(() => result.current.restoreProject(state, Uint32Array.of(0, 0, 0, 2)));
    await waitFor(() => expect(result.current.committedMask.get(0)?.get(1)?.tone).toBe('midtone'));
    rerender({ paint: coverage });
    await waitFor(() => expect(result.current.committedMask.get(0)?.get(2)?.tone).toBe('highlight'));
    expect(compute).toHaveBeenCalledTimes(1);

    act(() => result.current.restoreProject({
      ...state, lighting: { ...state.lighting, manual: true },
    }, Uint32Array.of(0, 0, 0, 2)));
    expect(result.current.committedMask.get(0)?.size).toBe(1);
    expect(result.current.manual).toBe(true);
  });

  it('edits cumulative masks and restores manual work after regeneration undo', async () => {
    const compute = vi.fn<(request: ExposureRequest) => Promise<Float32Array>>()
      .mockResolvedValue(Float32Array.of(0, 0.5, 1));
    const api = { computeLightExposure: compute } as unknown as PaintPalletApi;
    const { result } = renderHook(() => useSurfaceLighting(api, 'model', orientation, coverage));
    const face = { faceId: 0, batchIndex: 0, triangleIndex: 0 };

    act(() => result.current.start());
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => {
      result.current.apply();
      result.current.setBrushTool('paint-highlight');
    });
    act(() => {
      expect(result.current.beginBrush()).toBe(true);
      result.current.paintFaces([face]);
      result.current.endBrush(true);
    });
    const editedMask = result.current.mask;
    expect(editedMask.get(0)?.get(0)?.tone).toBe('highlight');
    act(() => result.current.setAzimuth(120));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.apply());
    expect(result.current.confirming).toBe(true);
    expect(result.current.mask).toBe(editedMask);
    act(() => result.current.apply(true));
    expect(result.current.manual).toBe(false);
    act(() => result.current.undoMask());
    expect(result.current.mask).toBe(editedMask);
    expect(result.current.manual).toBe(true);
  });

});
