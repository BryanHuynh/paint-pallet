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
    const pickedBatch = summary.batches.find((batch) => batch.batchIndex === hitFront.batchIndex);
    expect(pickedBatch).toBeDefined();
    const pickedData = await readBatchBinary(pickedBatch!.filePath);
    expect(pickedData.faceIds[hitFront.triangleIndex!]).toBe(hitFront.originalFaceId);
    expect(hitFront.distance).toBeCloseTo(5, 4);

    const hitOffset = await client.pickFace(summary.modelId, [10.25, 0.25, 10], [0, 0, -1]);
    expect(hitOffset.hit).toBe(true);
    expect(hitOffset.originalFaceId).toBe(2);

    const miss = await client.pickFace(summary.modelId, [50, 50, 10], [0, 0, -1]);
    expect(miss.hit).toBe(false);
    expect(miss.originalFaceId).toBeNull();
  });

  it('imports an ASCII STL with its original name and pickable face order', async () => {
    const fixture = path.join(tempDir, 'faceted-ascii.stl');
    const ascii = [
      'solid ascii-model', ' facet normal 0 0 1', '  outer loop',
      '   vertex 0 0 0', '   vertex 2 0 0', '   vertex 0 2 0',
      '  endloop', ' endfacet', 'endsolid ascii-model', '',
    ].join('\n');
    fs.writeFileSync(fixture, ascii);
    const model = await client.importStl(fixture, 'ascii-fixture');
    expect(model.fileName).toBe('faceted-ascii.stl');
    expect(model.fileSizeBytes).toBe(Buffer.byteLength(ascii));
    expect(model.triangleCount).toBe(1);
    const pick = await client.pickFace(model.modelId, [0.25, 0.25, 2], [0, 0, -1]);
    expect(pick.originalFaceId).toBe(0);
  });

  it('keeps OBJ group boundaries across shared edges and ignores external material files', async () => {
    const fixture = path.join(tempDir, 'grouped.obj');
    fs.writeFileSync(fixture, [
      'mtllib inaccessible.mtl', 'o Miniature kit', 'v 0 0 0', 'v 2 0 0', 'v 2 2 0', 'v 0 2 0', 'v 4 0 0',
      'g cloak', 'usemtl unwanted', 'f 1 2 3 4', 'g armor', 'f -4 -1 -3', '',
    ].join('\n'));
    const model = await client.importStl(fixture, 'obj-fixture');
    expect(model.fileName).toBe('grouped.obj');
    expect(model.triangleCount).toBe(3);
    expect((await client.getActiveModel())?.fileName).toBe(model.fileName);

    const armor = await client.pickFace(model.modelId, [2.8, 0.25, 5], [0, 0, -1]);
    expect(armor.originalFaceId).toBe(2);
    const packed = await client.previewConnectedFill({
      modelId: model.modelId, jobId: 'obj-fill', faceId: 0, maxCreaseDegrees: 180, blockedFaces: [],
    });
    expect(Array.from(packed).filter((_, i) => i % 3 === 0).sort()).toEqual([0, 1]);

    const groupNames = fs.readFileSync(path.join(path.dirname(model.batches[0].filePath), 'group-names.json'), 'utf8');
    expect(JSON.parse(groupNames)).toEqual([
      { object: 'Miniature kit', groups: ['cloak'] },
      { object: 'Miniature kit', groups: ['armor'] },
    ]);
  });

  it('reports the line of a malformed text mesh and preserves the active model', async () => {
    const activePath = path.join(tempDir, 'previous.stl');
    writeBinaryStl(activePath, [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }]);
    const active = await client.importStl(activePath, 'previous');

    const obj = path.join(tempDir, 'invalid.obj');
    fs.writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 8\n');
    await expect(client.importStl(obj, 'bad-obj')).rejects.toThrow(/Line 4.*invalid vertex/);

    const ascii = path.join(tempDir, 'bad-ascii.stl');
    fs.writeFileSync(ascii, 'solid broken\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\n');
    await expect(client.importStl(ascii, 'bad-ascii')).rejects.toThrow(/ended before "endsolid"/);
    expect((await client.getActiveModel())?.modelId).toBe(active.modelId);
    expect(fs.readdirSync(path.join(tempDir, 'cache')).some((name) => name.startsWith('source-'))).toBe(false);
  });

  it('grows a fill only across shared edges allowed by crease and ownership', async () => {
    const stlPath = path.join(tempDir, 'fill-hinge.stl');
    writeBinaryStl(stlPath, [
      { v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] },
      { v1: [1, 0, 0], v2: [1, 1, 0], v3: [0, 1, 0] },
      { v1: [1, 1, 0], v2: [1, 0, 0], v3: [1, 0, 1] },
      { v1: [5, 0, 0], v2: [6, 0, 0], v3: [5, 1, 0] },
    ]);
    const { modelId } = await client.importStl(stlPath, 'fill-hinge');

    const fill = async (maxCreaseDegrees: number, blockedFaces: number[]) => {
      const packed = await client.previewConnectedFill({
        modelId, jobId: 'fill-hinge-preview', faceId: 0, maxCreaseDegrees, blockedFaces,
      });
      return Array.from(packed).filter((_, index) => index % 3 === 0).sort((a, b) => a - b);
    };

    expect(await fill(35, [])).toEqual([0, 1]);
    expect(await fill(95, [])).toEqual([0, 1, 2]);
    expect(await fill(95, [1])).toEqual([0]);
    expect(await fill(95, [0])).toEqual([]);
  });

  it('follows original edges across all spatial batches of a connected surface', async () => {
    const stlPath = path.join(tempDir, 'fill-grid.stl');
    const cols = 182;
    const rows = 181;
    const triangles = [];
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        triangles.push(
          { v1: [x, y, 0], v2: [x + 1, y, 0], v3: [x, y + 1, 0] },
          { v1: [x + 1, y, 0], v2: [x + 1, y + 1, 0], v3: [x, y + 1, 0] },
        );
      }
    }
    writeBinaryStl(stlPath, triangles as Parameters<typeof writeBinaryStl>[1]);
    const model = await client.importStl(stlPath, 'fill-grid');
    expect(model.batches.length).toBeGreaterThan(1);

    const packed = await client.previewConnectedFill({
      modelId: model.modelId, jobId: 'fill-grid-preview', faceId: 0, maxCreaseDegrees: 0, blockedFaces: [],
    });
    const ids = new Set<number>();
    const batches = new Set<number>();
    for (let i = 0; i < packed.length; i += 3) {
      ids.add(packed[i]);
      batches.add(packed[i + 1]);
    }
    expect(ids.size).toBe(triangles.length);
    expect(batches.size).toBe(model.batches.length);
  });

  it('finds convex ridges across mesh batches and widens the band without crossing region boundaries', async () => {
    const source = path.join(tempDir, 'ridge-and-seam.stl');
    const triangles: Parameters<typeof writeBinaryStl>[1] = [
      { v1: [0, 0, 0], v2: [1, 0, 0], v3: [1, 1, 0] },
      { v1: [0, 0, 0], v2: [1, 1, 0], v3: [0, 1, 0] },
      { v1: [1, 1, 0], v2: [1, 0, 0], v3: [1, 0, -1] },
      { v1: [0, 2, 0], v2: [1, 2, 0], v3: [1, 3, 0] },
      { v1: [1, 3, 0], v2: [1, 2, 0], v3: [1, 2, 1] },
    ];
    for (let i = 0; i < 2050; i++) {
      const x = 1.5 + i % 50 * 0.012;
      const y = Math.floor(i / 50) * 0.08;
      triangles.push({ v1: [x, y, 0], v2: [x + 0.005, y, 0], v3: [x, y + 0.005, 0] });
    }
    writeBinaryStl(source, triangles);
    const model = await client.importStl(source, 'ridge-model');
    const suggest = (widthPercent: number, region: number[], crease = 60) => client.previewRidgeBand({
      modelId: model.modelId, jobId: 'ridge-preview', crease, widthPercent, regionFaces: Uint32Array.from(region),
    });
    const faceIds = (hits: Uint32Array) => Array.from(hits).filter((_, i) => i % 3 === 0).sort((a, b) => a - b);
    const region = [0, 1, 2, 3, 4];

    const narrow = await suggest(0.05, region);
    expect(faceIds(narrow)).toEqual([0, 2]);
    expect(narrow[1]).not.toBe(narrow[4]);
    expect(faceIds(await suggest(60, region))).toEqual([0, 1, 2]);
    expect(faceIds(await suggest(60, [0, 1, 3, 4]))).toEqual([]);
    expect(faceIds(await suggest(60, region, 100))).toEqual([]);
    expect(fs.readdirSync(path.join(tempDir, 'cache')).some((name) => name.endsWith('-region.bin'))).toBe(false);
  });

  it('traces full-resolution shadows across spatial partitions with Embree', async () => {
    const stlPath = path.join(tempDir, 'lighting-overhang.stl');
    const triangles: Parameters<typeof writeBinaryStl>[1] = [
      { v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] },
      { v1: [0, 0, 100], v2: [1, 0, 100], v3: [0, 1, 100] },
      { v1: [3, 0, 0], v2: [4, 0, 0], v3: [3, 1, 0] },
      { v1: [5, 0, 0], v2: [6, 0, 0], v3: [5, 1, 1] },
    ];
    for (let i = 0; i < 2050; i++) {
      const x = 10 + (i % 50) * 0.1;
      const y = 10 + Math.floor(i / 50) * 0.1;
      triangles.push({ v1: [x, y, 0], v2: [x + 0.05, y, 0], v3: [x, y + 0.05, 0] });
    }
    writeBinaryStl(stlPath, triangles);
    const model = await client.importStl(stlPath, 'lighting-overhang');
    const batches = new Map<number, number>();
    for (const batch of model.batches) {
      const binary = await readBatchBinary(batch.filePath);
      for (const faceId of binary.faceIds) if (faceId <= 1) batches.set(faceId, batch.batchIndex);
    }
    expect(batches.size).toBe(2);
    expect(batches.get(0)).not.toBe(batches.get(1));

    const first = await client.computeLightExposure({
      modelId: model.modelId, jobId: 'first-light', direction: [0, 0, 1],
    });
    expect(first).toHaveLength(triangles.length);
    expect(first[0]).toBe(0);
    expect(first[1]).toBeCloseTo(1);
    expect(first[2]).toBeCloseTo(1);
    expect(first[3]).toBeCloseTo(Math.SQRT1_2);

    const cached = await client.computeLightExposure({
      modelId: model.modelId, jobId: 'same-light', direction: [0, 0, 1],
    });
    expect(cached).toEqual(first);
    const reversed = await client.computeLightExposure({
      modelId: model.modelId, jobId: 'reversed-light', direction: [0, 0, -1],
    });
    expect(reversed[1]).toBe(0);
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

  it('preserves active model on staged replacement discard and releases discarded job dir', async () => {
    const firstPath = path.join(tempDir, 'first_staged.stl');
    writeBinaryStl(firstPath, [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }]);
    const first = await client.importStl(firstPath, 'job_active_1');

    const secondPath = path.join(tempDir, 'second_staged.stl');
    writeBinaryStl(secondPath, [{ v1: [5, 0, 0], v2: [6, 0, 0], v3: [5, 1, 0] }]);
    const second = await client.importStl(secondPath, 'job_staged_2', { staged: true });

    // Active model must still be first until commitModel is called
    expect((await client.getActiveModel())?.modelId).toBe(first.modelId);
    const activePick = await client.pickFace(first.modelId, [0.2, 0.2, 5], [0, 0, -1]);
    expect(activePick.hit).toBe(true);
    expect(activePick.originalFaceId).toBe(0);

    // Discard staged replacement -> removes second's job dir, keeps first active
    const disc = await client.discardModel(second.modelId);
    expect(disc.discarded).toBe(true);
    expect(fs.existsSync(path.dirname(second.batches[0].filePath))).toBe(false);
    expect((await client.getActiveModel())?.modelId).toBe(first.modelId);

    // Commit a third staged replacement -> promotes third and cleans up first's job dir
    const third = await client.importStl(secondPath, 'job_staged_3', { staged: true });
    const comm = await client.commitModel(third.modelId);
    expect(comm.committed).toBe(true);
    expect((await client.getActiveModel())?.modelId).toBe(third.modelId);
    expect(fs.existsSync(path.dirname(first.batches[0].filePath))).toBe(false);

    // Committing an already-discarded or unknown modelId returns committed:false and preserves active model
    const rejected = await client.commitModel(second.modelId);
    expect(rejected.committed).toBe(false);
    expect((await client.getActiveModel())?.modelId).toBe(third.modelId);
  });

  it('restricts pickFace to rendered batchIndices when provided', async () => {
    const stlPath = path.join(tempDir, 'two_regions.stl');
    const tris = [];
    for (let i = 0; i < 3000; i++) {
      const base = i < 1500 ? 0 : 100;
      tris.push({
        v1: [base, 0, 0] as [number, number, number],
        v2: [base + 1, 0, 0] as [number, number, number],
        v3: [base, 1, 0] as [number, number, number],
      });
    }
    writeBinaryStl(stlPath, tris);
    const summary = await client.importStl(stlPath, 'job_batch_filter');
    expect(summary.batches.length).toBeGreaterThanOrEqual(2);

    const farBatch = summary.batches.find((b) => b.bounds.min[0] > 50)!;
    const nearBatch = summary.batches.find((b) => b.bounds.max[0] < 50)!;

    // Ray aimed at far region [100.2, 0.2, 5] only hits when farBatch is included
    const missUnrendered = await client.pickFace(
      summary.modelId,
      [100.2, 0.2, 5],
      [0, 0, -1],
      [nearBatch.batchIndex],
    );
    expect(missUnrendered.hit).toBe(false);

    const hitRendered = await client.pickFace(
      summary.modelId,
      [100.2, 0.2, 5],
      [0, 0, -1],
      [farBatch.batchIndex],
    );
    expect(hitRendered.hit).toBe(true);
    expect(hitRendered.originalFaceId).toBeGreaterThanOrEqual(1500);
  });
});
