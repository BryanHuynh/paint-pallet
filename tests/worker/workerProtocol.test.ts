import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeBinaryStl, writeGridBinaryStl } from '../fixtures/stlFixture';
import { WorkerClient, readBatchBinary } from '../../src/main/workerClient';
import { assertWorkerBinaryPresent } from '../../forge.config';

describe('Worker import/batch/pick protocol', () => {
  let tempDir: string;
  let client: WorkerClient;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-worker-test-'));
    client = new WorkerClient({
      cacheDir: path.join(tempDir, 'cache'),
    });
  });

  afterEach(async () => {
    await client.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('imports a valid binary STL into disk-backed spatial batches and retains original face IDs', async () => {
    const stlPath = path.join(tempDir, 'quad_pair.stl');
    writeBinaryStl(stlPath, [
      { v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] },
      { v1: [1, 0, 0], v2: [1, 1, 0], v3: [0, 1, 0] },
      { v1: [10, 0, 0], v2: [11, 0, 0], v3: [10, 1, 0] },
      { v1: [11, 0, 0], v2: [11, 1, 0], v3: [10, 1, 0] },
    ]);

    const summary = await client.importStl(stlPath, 'job-1');

    expect(summary.triangleCount).toBe(4);
    expect(summary.fileName).toBe('quad_pair.stl');
    expect(summary.bounds.min).toEqual([0, 0, 0]);
    expect(summary.bounds.max).toEqual([11, 1, 0]);
    expect(summary.batches.length).toBeGreaterThanOrEqual(1);

    const seenFaceIds = new Set<number>();
    for (const batch of summary.batches) {
      expect(fs.existsSync(batch.filePath)).toBe(true);
      const data = await readBatchBinary(batch.filePath);
      expect(data.triangleCount).toBe(batch.triangleCount);
      for (let i = 0; i < data.faceIds.length; i++) {
        seenFaceIds.add(data.faceIds[i]);
      }
    }

    expect([...seenFaceIds].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('picks the exact originalFaceId for a surface ray hit and returns miss otherwise', async () => {
    const stlPath = path.join(tempDir, 'layered.stl');
    writeBinaryStl(stlPath, [
      // Face 0: z = 0
      { v1: [0, 0, 0], v2: [2, 0, 0], v3: [0, 2, 0] },
      // Face 1: z = 5 (closer to origin [0.25, 0.25, 10] looking -Z)
      { v1: [0, 0, 5], v2: [2, 0, 5], v3: [0, 2, 5] },
      // Face 2: offset in X
      { v1: [10, 0, 0], v2: [12, 0, 0], v3: [10, 2, 0] },
    ]);

    const summary = await client.importStl(stlPath, 'job-pick');

    const hitFront = await client.pickFace(summary.modelId, [0.25, 0.25, 10], [0, 0, -1]);
    expect(hitFront.hit).toBe(true);
    expect(hitFront.partId).toBe(summary.partId);
    expect(hitFront.originalFaceId).toBe(1);
    expect(hitFront.distance).toBeCloseTo(5, 4);

    const hitOffset = await client.pickFace(summary.modelId, [10.25, 0.25, 10], [0, 0, -1]);
    expect(hitOffset.hit).toBe(true);
    expect(hitOffset.originalFaceId).toBe(2);

    const miss = await client.pickFace(summary.modelId, [50, 50, 10], [0, 0, -1]);
    expect(miss.hit).toBe(false);
    expect(miss.originalFaceId).toBeNull();
  });

  it('rejects malformed or truncated STLs, cleans up partial data, and keeps the previous model open', async () => {
    const validPath = path.join(tempDir, 'valid.stl');
    writeBinaryStl(validPath, [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }]);
    const validSummary = await client.importStl(validPath, 'job-valid');

    // 1. Short header (<84 bytes)
    const shortPath = path.join(tempDir, 'short.stl');
    fs.writeFileSync(shortPath, Buffer.alloc(40));
    await expect(client.importStl(shortPath, 'job-short')).rejects.toThrow(/84-byte/i);
    expect(fs.existsSync(path.join(tempDir, 'cache', 'job_job-short'))).toBe(false);

    // 2. Zero triangles
    const zeroPath = path.join(tempDir, 'zero.stl');
    const zeroBuf = Buffer.alloc(84);
    zeroBuf.writeUInt32LE(0, 80);
    fs.writeFileSync(zeroPath, zeroBuf);
    await expect(client.importStl(zeroPath, 'job-zero')).rejects.toThrow(/0/);

    // 3. Truncated payload (claims 10 triangles, only 2 records present)
    const truncPath = path.join(tempDir, 'truncated.stl');
    const truncBuf = Buffer.alloc(84 + 2 * 50);
    truncBuf.writeUInt32LE(10, 80);
    fs.writeFileSync(truncPath, truncBuf);
    await expect(client.importStl(truncPath, 'job-trunc')).rejects.toThrow(/Truncated or malformed/i);
    expect(fs.existsSync(path.join(tempDir, 'cache', 'job_job-trunc'))).toBe(false);

    // Previous valid model is still active and pickable
    const active = await client.getActiveModel();
    expect(active?.modelId).toBe(validSummary.modelId);
    const pick = await client.pickFace(validSummary.modelId, [0.2, 0.2, 5], [0, 0, -1]);
    expect(pick.hit).toBe(true);
    expect(pick.originalFaceId).toBe(0);
  });

  it('emits chunked progress, supports mid-import cancellation with cleanup, and allows worker reuse', async () => {
    const basePath = path.join(tempDir, 'base.stl');
    writeBinaryStl(basePath, [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }]);
    const baseModel = await client.importStl(basePath, 'job-base');

    const largePath = path.join(tempDir, 'large_grid.stl');
    writeGridBinaryStl(largePath, 220000); // ~11 MiB -> multiple 65k-triangle chunks

    const progressEvents: number[] = [];
    let cancelTriggered = false;
    const unsub = client.onProgress((evt) => {
      if (evt.jobId === 'job-cancel') {
        progressEvents.push(evt.trianglesRead);
        if (!cancelTriggered) {
          cancelTriggered = true;
          void client.cancelImport('job-cancel');
        }
      }
    });

    await expect(client.importStl(largePath, 'job-cancel')).rejects.toThrow(/canceled/i);
    unsub();

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tempDir, 'cache', 'job_job-cancel'))).toBe(false);

    // Previous model remains active
    const active = await client.getActiveModel();
    expect(active?.modelId).toBe(baseModel.modelId);

    // Worker can be reused for a subsequent full import
    const reusedSummary = await client.importStl(largePath, 'job-reuse');
    expect(reusedSummary.triangleCount).toBe(220000);
    expect(reusedSummary.batches.length).toBeGreaterThan(1);

    const seenIds = new Set<number>();
    for (const b of reusedSummary.batches) {
      const bin = await readBatchBinary(b.filePath);
      for (let i = 0; i < bin.faceIds.length; i++) {
        seenIds.add(bin.faceIds[i]);
      }
    }
    expect(seenIds.size).toBe(220000);
  });

  it('rejects unsafe jobIds and returns canceled:false for late-cancel after completion', async () => {
    const stlPath = path.join(tempDir, 'single.stl');
    writeBinaryStl(stlPath, [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }]);

    await expect(client.importStl(stlPath, '../escape')).rejects.toThrow(/Invalid jobId/i);

    const summary = await client.importStl(stlPath, 'job_late_done');
    expect(summary.triangleCount).toBe(1);

    // Late cancel after completion must return canceled: false
    const lateAck = await client.cancelImport('job_late_done');
    expect(lateAck.canceled).toBe(false);

    const active = await client.getActiveModel();
    expect(active?.modelId).toBe(summary.modelId);
  });

  it('cancels cleanly during finalization, closes all Windows handles, and cleans up job dir', async () => {
    const basePath = path.join(tempDir, 'base_fin.stl');
    writeBinaryStl(basePath, [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }]);
    const baseModel = await client.importStl(basePath, 'job_fin_base');

    const gridPath = path.join(tempDir, 'fin_grid.stl');
    writeGridBinaryStl(gridPath, 180000);

    let cancelSent = false;
    const unsub = client.onProgress((evt) => {
      if (evt.jobId === 'job_fin_cancel' && evt.phase === 'finalizing' && !cancelSent) {
        cancelSent = true;
        void client.cancelImport('job_fin_cancel');
      }
    });

    await expect(client.importStl(gridPath, 'job_fin_cancel')).rejects.toThrow(/canceled/i);
    unsub();

    expect(cancelSent).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'cache', 'job_job_fin_cancel'))).toBe(false);
    const active = await client.getActiveModel();
    expect(active?.modelId).toBe(baseModel.modelId);
  });

  it('bounds spatial sub-batches for extremely skewed inputs and retains all face IDs', async () => {
    const skewedPath = path.join(tempDir, 'skewed.stl');
    const triCount = 150000;
    const buf = Buffer.alloc(84 + triCount * 50);
    buf.write('Skewed Fixture', 0, 'ascii');
    buf.writeUInt32LE(triCount, 80);

    // Put 149,999 triangles inside a tiny corner [0, 0.001] and 1 triangle at [100, 100, 0]
    for (let i = 0; i < triCount; i++) {
      const off = 84 + i * 50;
      const base = i === triCount - 1 ? 100.0 : 0.0;
      const z = (i % 100) * 0.00001;
      buf.writeFloatLE(0, off);
      buf.writeFloatLE(0, off + 4);
      buf.writeFloatLE(1, off + 8);
      buf.writeFloatLE(base, off + 12);
      buf.writeFloatLE(base, off + 16);
      buf.writeFloatLE(z, off + 20);
      buf.writeFloatLE(base + 0.001, off + 24);
      buf.writeFloatLE(base, off + 28);
      buf.writeFloatLE(z, off + 32);
      buf.writeFloatLE(base, off + 36);
      buf.writeFloatLE(base + 0.001, off + 40);
      buf.writeFloatLE(z, off + 44);
    }
    fs.writeFileSync(skewedPath, buf);

    const summary = await client.importStl(skewedPath, 'job_skewed');
    expect(summary.triangleCount).toBe(triCount);
    expect(summary.batches.length).toBeGreaterThanOrEqual(3);
    for (const b of summary.batches) {
      expect(b.triangleCount).toBeLessThanOrEqual(65536);
    }

    const pick = await client.pickFace(summary.modelId, [100.0002, 100.0002, 5], [0, 0, -1]);
    expect(pick.hit).toBe(true);
    expect(pick.originalFaceId).toBe(triCount - 1);
  });

  it('requires the x64 native worker binary during packaging and fails if missing', () => {
    expect(() => assertWorkerBinaryPresent()).not.toThrow();
    expect(() => assertWorkerBinaryPresent(path.join(tempDir, 'missing_worker.exe'))).toThrow(
      /Missing required x64 native worker binary/i,
    );
  });

  it('matches Three.js FrontSide culling by skipping a nearer hidden backface', async () => {
    const stlPath = path.join(tempDir, 'backface_in_front.stl');
    writeBinaryStl(stlPath, [
      // Face 0: z = 8, CW winding when viewed from +Z (normal -Z -> backface!)
      { v1: [0, 0, 8], v2: [0, 2, 8], v3: [2, 0, 8] },
      // Face 1: z = 2, CCW winding when viewed from +Z (normal +Z -> visible frontface!)
      { v1: [0, 0, 2], v2: [2, 0, 2], v3: [0, 2, 2] },
    ]);

    const summary = await client.importStl(stlPath, 'job_cull');
    const pick = await client.pickFace(summary.modelId, [0.25, 0.25, 10], [0, 0, -1]);
    expect(pick.hit).toBe(true);
    expect(pick.originalFaceId).toBe(1);
    expect(pick.distance).toBeCloseTo(8, 4);
  });
});
