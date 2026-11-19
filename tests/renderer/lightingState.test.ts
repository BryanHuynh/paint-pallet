// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { ExposureRequest, PaintPalletApi } from '../../src/shared/workerProtocol';
import { dragLightDirection } from '../../src/renderer/components/lightHandle';
import type { ShadowCoverage } from '../../src/renderer/paint/shadowPaint';
import { lightAngles, useSurfaceLighting, worldLightDirection } from '../../src/renderer/paint/useSurfaceLighting';

describe('directional lighting preview', () => {
  const orientation = { upright: '+Y', front: '+Z' } as const;
  const coverage: ShadowCoverage = new Map([[0, new Map([
    [0, { faceId: 0, regionId: 'cloth', batchIndex: 0, triangleIndex: 0 }],
    [1, { faceId: 1, regionId: 'cloth', batchIndex: 0, triangleIndex: 1 }],
    [2, { faceId: 2, regionId: 'cloth', batchIndex: 0, triangleIndex: 2 }],
  ])]]);

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
    await waitFor(() => expect(result.current.draft?.mask.get(0)?.has(1)).toBe(true));
    act(() => result.current.cancel());
    expect(result.current.mask).toBe(committedMask);
  });

  it('edits cumulative masks, duplicates snapshots, and restores edited masks after regeneration undo', async () => {
    const compute = vi.fn<(request: ExposureRequest) => Promise<Float32Array>>()
      .mockResolvedValue(Float32Array.of(0, 0.5, 1));
    const api = { computeLightExposure: compute } as unknown as PaintPalletApi;
    const { result } = renderHook(() => useSurfaceLighting(api, 'model', orientation, coverage));
    const face = { faceId: 0, batchIndex: 0, triangleIndex: 0 };

    act(() => result.current.start());
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => {
      result.current.apply();
      result.current.renameSnapshot('Workshop');
      result.current.setBrushTool('paint-highlight');
    });
    act(() => {
      expect(result.current.beginBrush()).toBe(true);
      result.current.paintFaces([face]);
      result.current.endBrush(true);
    });
    const original = result.current.snapshot.id;
    const originalMask = result.current.mask;
    expect(originalMask.get(0)?.get(0)?.tone).toBe('highlight');

    act(() => result.current.addSnapshot(true));
    const copy = result.current.snapshot.id;
    expect(copy).not.toBe(original);
    expect(result.current.snapshot.name).toBe('Workshop copy');
    expect(result.current.mask).toBe(originalMask);
    act(() => {
      result.current.setAzimuth(120);
      result.current.setBrushTool('erase-midtone');
    });
    act(() => {
      expect(result.current.beginBrush()).toBe(true);
      result.current.paintFaces([face]);
      result.current.endBrush(true);
    });
    expect(result.current.mask.get(0)?.has(0)).toBe(false);

    act(() => result.current.selectSnapshot(original));
    expect(result.current.azimuth).toBe(35);
    expect(result.current.mask).toBe(originalMask);
    act(() => result.current.selectSnapshot(copy));
    expect(result.current.azimuth).toBe(120);
    const editedCopy = result.current.mask;

    act(() => result.current.start());
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.apply());
    expect(result.current.confirming).toBe(true);
    expect(result.current.mask).toBe(editedCopy);
    act(() => result.current.apply(true));
    expect(result.current.manual).toBe(false);
    act(() => result.current.undoMask());
    expect(result.current.mask).toBe(editedCopy);
    expect(result.current.manual).toBe(true);
  });

});
