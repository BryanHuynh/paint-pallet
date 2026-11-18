import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SurfaceBrush } from '../../src/renderer/paint/surfaceBrush';

describe('surface brush', () => {
  it('reads a swept footprint, resolves hits across batches, and visits each face once', () => {
    const renderer = {
      capabilities: { maxTextureSize: 4096 },
      getRenderTarget: () => null,
      setRenderTarget: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(),
      readRenderTargetPixels(
        target: THREE.WebGLRenderTarget, x: number, y: number, width: number, height: number, pixels: Uint8Array,
      ) {
        for (let row = 0; row < height; row++) {
          const screenY = (target.height - y - row - 0.5) / 2;
          for (let column = 0; column < width; column++) {
            const screenX = (x + column + 0.5) / 2;
            const key = screenY < 1 ? 3 : screenY > 4 ? 5 : screenX < 2 ? 1 : screenX < 4 ? 4 : 2;
            pixels[(row * width + column) * 4] = key;
          }
        }
      },
    } as unknown as THREE.WebGLRenderer;
    const brush = new SurfaceBrush();
    const mesh = new THREE.Mesh();
    const camera = new THREE.PerspectiveCamera();
    const rect = { left: 0, top: 0, width: 6, height: 5 } as DOMRect;
    const batches = [
      { index: 9, mesh, faceIds: Uint32Array.of(101, 102, 103) },
      { index: 4, mesh, faceIds: Uint32Array.of(201, 202) },
    ];

    try {
      expect(brush.capture(renderer, camera, rect, [], batches)).toBe(true);
      const from = { x: 1, y: 2.5 };
      const to = { x: 5, y: 2.5 };
      expect(brush.sample(renderer, from, to, 2)).toEqual([
        { faceId: 101, batchIndex: 9, triangleIndex: 0 },
        { faceId: 201, batchIndex: 4, triangleIndex: 0 },
        { faceId: 102, batchIndex: 9, triangleIndex: 1 },
      ]);
      expect(brush.sample(renderer, to, from, 2)).toEqual([]);
      brush.clear();
      expect(brush.sample(renderer, from, to, 2)).toEqual([]);
    } finally {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      brush.dispose();
    }
  });
});
