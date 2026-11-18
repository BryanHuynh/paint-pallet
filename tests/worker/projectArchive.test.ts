import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openProjectArchive, writeProjectArchive } from '../../src/main/projectArchive';
import { WorkerClient, readBatchBinary } from '../../src/main/workerClient';
import type { ProjectContents } from '../../src/shared/paintProject';
import { writeBinaryStl } from '../fixtures/stlFixture';

const swatch = (hex: string) => ({ hex, brand: 'Studio', bottleName: '', mixNotes: 'Thin with water' });
const fixture: ProjectContents = {
  state: {
    orientation: { upright: '+Y', front: '+Z' },
    recipes: [{ id: 'recipe-1', name: 'Coat', swatches: {
      shadow: swatch('#325487'), midtone: swatch('#b11023'), highlight: swatch('#eed8c3'),
    } }],
    activeRecipeId: 'recipe-1',
    references: [
      { id: 'ref-1', name: 'Blue.svg', mimeType: 'image/svg+xml' },
      { id: 'ref-2', name: 'Red.svg', mimeType: 'image/svg+xml' },
    ],
    activeReferenceId: 'ref-2',
    regions: [{ id: 'region-1', name: 'Coat', recipeId: 'recipe-1' }],
    activeRegionId: 'region-1',
    snapshots: [{ id: 'snapshot-1', name: 'Studio light', azimuth: 40, elevation: 30,
      midtone: 35, highlight: 75, applied: true, manual: true }],
    activeSnapshotId: 'snapshot-1',
    guideCallouts: [{ regionId: 'region-1', view: 'Front', x: 0.32, y: 0.79 }],
  },
  referenceBytes: ['#325487', '#b11023'].map((fill) => new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="' + fill + '"/></svg>',
  )),
  paint: Uint32Array.of(0, 0, 0, 0),
  tones: [Uint32Array.of(0, 0, 0, 2)],
};

describe('portable paint projects', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-project-test-'));
  });

  afterEach(async () => {
    if (/^pp-project-test-[a-zA-Z0-9]+$/.test(path.relative(os.tmpdir(), root))) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reopens a moved ZIP64 archive, restoring references, swatches, and original face IDs', async () => {
    const original = path.join(root, 'miniature.stl');
    const saved = path.join(root, 'guide.paintproject');
    const movedDir = path.join(root, 'moved');
    const cache = path.join(root, 'fresh-cache');
    writeBinaryStl(original, [
      { v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] },
      { v1: [1, 0, 0], v2: [1, 1, 0], v3: [0, 1, 0] },
    ]);
    const modelBytes = await fs.readFile(original);
    await writeProjectArchive(saved, original, 'miniature.stl', fixture);
    expect((await fs.readFile(saved)).indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBeGreaterThan(0);
    await fs.unlink(original);
    await fs.mkdir(movedDir);
    const moved = path.join(movedDir, 'guide.paintproject');
    await fs.rename(saved, moved);

    const reopened = await openProjectArchive(moved, cache);
    const worker = new WorkerClient({ cacheDir: path.join(cache, 'geometry') });
    try {
      expect(reopened.sourceName).toBe('miniature.stl');
      expect(await fs.readFile(reopened.originalPath)).toEqual(modelBytes);
      expect(reopened.contents.state).toMatchObject(fixture.state);
      expect(reopened.contents.referenceBytes).toEqual(fixture.referenceBytes);
      expect(reopened.contents.paint).toEqual(fixture.paint);
      expect(reopened.contents.tones).toEqual(fixture.tones);
      const model = await worker.importStl(reopened.originalPath, 'project-import');
      const batch = await readBatchBinary(model.batches[0].filePath);
      const [faceId, , triangleIndex] = reopened.contents.paint;
      expect(batch.faceIds[triangleIndex]).toBe(faceId);
      expect([...batch.faceIds]).toEqual([0, 1]);
    } finally {
      await worker.dispose();
      await reopened.cleanup();
    }
  });

  it('keeps the existing destination on a failed save and cleans its failed open staging', async () => {
    const destination = path.join(root, 'existing.paintproject');
    const original = path.join(root, 'missing.stl');
    const existingContents = Buffer.from('Preserve the previous file');
    await fs.writeFile(destination, existingContents);

    await expect(writeProjectArchive(destination, original, 'missing.stl', fixture)).rejects.toThrow();
    expect(await fs.readFile(destination)).toEqual(existingContents);
    expect(await fs.readdir(root)).toEqual(['existing.paintproject']);

    const cache = path.join(root, 'cache');
    await expect(openProjectArchive(destination, cache)).rejects.toThrow();
    expect(await fs.readdir(cache)).toEqual([]);
  });
});
