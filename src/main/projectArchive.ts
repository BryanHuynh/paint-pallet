import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import { GUIDE_VIEWS } from '../shared/paintingGuide';
import type { ProjectContents, ProjectManifest, ProjectState } from '../shared/paintProject';

const MANIFEST = 'manifest.json';
const SHADOW = 'paint.bin';
const PROJECT_ENTRY: RegExp = /^(manifest\.json|paint\.bin|model\.(stl|obj)|reference\/\d+|tone\/\d+)$/;
const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024;
const AXIS = /^[+-][XYZ]$/;

function nonemptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validIdList<T extends { id: string }>(items: T[], active: unknown): boolean {
  const ids = new Set(items.map(({ id }) => id));
  return ids.size === items.length && (active === null || nonemptyId(active) && ids.has(active));
}

function validateState(value: unknown): asserts value is ProjectState {
  if (!isRecord(value) || !isRecord(value.orientation)) throw new Error('Invalid paint project settings.');
  const { upright, front } = value.orientation;
  if (typeof upright !== 'string' || typeof front !== 'string' ||
      !AXIS.test(upright) || !AXIS.test(front) || upright[1] === front[1]) {
    throw new Error('Invalid paint project orientation.');
  }

  const { recipes, references, regions, snapshots } = value;
  if (!Array.isArray(recipes) || !recipes.every((recipe) => isRecord(recipe) && nonemptyId(recipe.id) &&
      typeof recipe.name === 'string' && isRecord(recipe.swatches) &&
      ['shadow', 'midtone', 'highlight'].every((tone) => {
        const entry = (recipe.swatches as Record<string, unknown>)[tone];
        return isRecord(entry) && typeof entry.hex === 'string' && /^#[a-f0-9]{6}$/i.test(entry.hex) &&
          [entry.brand, entry.bottleName, entry.mixNotes].every((field) => typeof field === 'string');
      })) || !validIdList(recipes, value.activeRecipeId)) {
    throw new Error('Invalid paint project recipes.');
  }
  if (!Array.isArray(references) || !references.every((ref) => isRecord(ref) && nonemptyId(ref.id) &&
      typeof ref.name === 'string' && typeof ref.mimeType === 'string') ||
      !validIdList(references, value.activeReferenceId)) {
    throw new Error('Invalid paint project reference list.');
  }
  if (!Array.isArray(regions) || !regions.every((region) => isRecord(region) && nonemptyId(region.id) &&
      typeof region.name === 'string' && typeof region.recipeId === 'string') ||
      !validIdList(regions, value.activeRegionId)) {
    throw new Error('Invalid paint project regions.');
  }
  if (!Array.isArray(snapshots) || !snapshots.every((snapshot) => isRecord(snapshot) && nonemptyId(snapshot.id) &&
      typeof snapshot.name === 'string' && inRange(snapshot.azimuth, 0, 359) &&
      inRange(snapshot.elevation, -90, 90) && inRange(snapshot.midtone, 0, 100) &&
      inRange(snapshot.highlight, snapshot.midtone, 100) &&
      typeof snapshot.applied === 'boolean' && typeof snapshot.manual === 'boolean' &&
      (snapshot.appliedLightKey === undefined || typeof snapshot.appliedLightKey === 'string')) ||
      !nonemptyId(value.activeSnapshotId) || !validIdList(snapshots, value.activeSnapshotId)) {
    throw new Error('Invalid paint project lighting snapshots.');
  }
  if (value.guideCallouts !== undefined) {
    const ids = new Set(regions.map(({ id }) => id));
    if (!Array.isArray(value.guideCallouts) || !value.guideCallouts.every((callout) =>
      isRecord(callout) && ids.has(callout.regionId) && GUIDE_VIEWS.some((view) => view === callout.view) &&
      inRange(callout.x, 0, 1) && inRange(callout.y, 0, 1))) {
      throw new Error('Invalid paint project guide callouts.');
    }
  }
}

function parseManifest(raw: string): ProjectManifest {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported paint project version.');
  if (!nonemptyId(value.sourceName) || (value.sourceExtension !== '.stl' && value.sourceExtension !== '.obj')) {
    throw new Error('Invalid original model entry.');
  }
  const { sourceName, sourceExtension } = value;
  validateState(value);
  return { ...value, sourceName, sourceExtension, version: 1 };
}

function validatePayload(contents: ProjectContents) {
  validateState(contents.state);
  if (!Array.isArray(contents.referenceBytes) || contents.referenceBytes.length !== contents.state.references.length ||
      !contents.referenceBytes.every((reference) => ArrayBuffer.isView(reference) && reference.BYTES_PER_ELEMENT === 1) ||
      !(contents.paint instanceof Uint32Array) || contents.paint.length % 4 ||
      !Array.isArray(contents.tones) || contents.tones.length !== contents.state.snapshots.length ||
      !contents.tones.every((mask) => mask instanceof Uint32Array && mask.length % 4 === 0)) {
    throw new Error('Invalid paint project assets or masks.');
  }
}

function asBuffer(bytes: Uint8Array | Uint32Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function writeProjectArchive(
  destination: string,
  sourcePath: string,
  sourceName: string,
  contents: ProjectContents,
) {
  validatePayload(contents);
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension !== '.stl' && extension !== '.obj') throw new Error('Project source must be an STL or OBJ.');
  const manifest: ProjectManifest = {
    ...contents.state,
    version: 1,
    sourceName,
    sourceExtension: extension,
  };
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  const zip = new yazl.ZipFile();
  const output = zip.outputStream as Readable;
  zip.on('error', (error) => output.destroy(error));

  try {
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), MANIFEST);
    zip.addFile(sourcePath, `model${extension}`, { compress: false });
    contents.referenceBytes.forEach((bytes, index) => zip.addBuffer(asBuffer(bytes), `reference/${index}`, { compress: false }));
    zip.addBuffer(asBuffer(contents.paint), SHADOW);
    contents.tones.forEach((tones, index) => zip.addBuffer(asBuffer(tones), `tone/${index}`));
    zip.end({ forceZip64Format: true, comment: '' });

    await pipeline(output, fs.createWriteStream(temp, { flags: 'wx' }));
    const written = await fs.promises.open(temp, 'r+');
    try {
      await written.sync();
    } finally {
      await written.close();
    }
    await fs.promises.rename(temp, destination);
  } finally {
    await fs.promises.unlink(temp).catch(() => {});
  }
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function extractEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, dir: string, seen: Set<string>) {
  const name = entry.fileName;
  if (!PROJECT_ENTRY.test(name) || seen.has(name)) throw new Error('The archive contains an unexpected project entry.');
  if (name.startsWith('model.') && (entry.uncompressedSize > MAX_MODEL_BYTES || entry.uncompressedSize <= 0)) {
    throw new Error('Original model entry exceeds the supported size.');
  }
  const destination = path.join(dir, name);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  let checksum = 0;
  const validate = new Transform({
    transform(chunk: Buffer, _encoding, next) {
      checksum = crc32(chunk, checksum);
      next(null, chunk);
    },
    flush(next) {
      next(checksum === entry.crc32 ? null : new Error(`Damaged project entry: ${name}`));
    },
  });
  await pipeline(await openEntry(zip, entry), validate, fs.createWriteStream(destination, { flags: 'wx' }));
  seen.add(name);
}

async function extractArchive(archive: string, dir: string): Promise<Set<string>> {
  const zip = await openZip(archive);
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        void extractEntry(zip, entry, dir, seen).then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
    return seen;
  } finally {
    zip.close();
  }
}

async function readPackedFile(file: string): Promise<Uint32Array> {
  const bytes = await fs.promises.readFile(file);
  if (bytes.byteLength % 16) throw new Error('Invalid project mask data.');
  return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export async function openProjectArchive(archive: string, cache: string) {
  await fs.promises.mkdir(cache, { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(cache, 'project-'));
  const cleanup = async () => {
    if (/^project-[a-zA-Z0-9]+$/.test(path.relative(cache, root))) {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  };
  try {
    const entries = await extractArchive(archive, root);
    const manifest = parseManifest(await fs.promises.readFile(path.join(root, MANIFEST), 'utf8'));
    const original = `model${manifest.sourceExtension}`;
    const expected = new Set([
      MANIFEST, SHADOW, original,
      ...manifest.references.map((_, index) => `reference/${index}`),
      ...manifest.snapshots.map((_, index) => `tone/${index}`),
    ]);

    if (entries.size !== expected.size || [...expected].some((entry) => !entries.has(entry))) {
      throw new Error('The archive is missing project assets or contains unexpected entries.');
    }

    const referenceBytes: Uint8Array[] = [];
    for (let i = 0; i < manifest.references.length; i++) {
      const bytes = await fs.promises.readFile(path.join(root, 'reference', String(i)));
      referenceBytes.push(Uint8Array.from(bytes));
    }
    const tones: Uint32Array[] = [];
    for (let i = 0; i < manifest.snapshots.length; i++) {
      tones.push(await readPackedFile(path.join(root, 'tone', String(i))));
    }
    const paint = await readPackedFile(path.join(root, SHADOW));
    return {
      originalPath: path.join(root, original), sourceName: manifest.sourceName,
      contents: { state: manifest, referenceBytes, paint, tones }, cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
