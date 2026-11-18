import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import type { KitState } from '../shared/kit';
import { GUIDE_VIEWS } from '../shared/paintingGuide';
import type { ProjectContents, ProjectManifest, ProjectState } from '../shared/paintProject';

const MANIFEST = 'manifest.json';
const SHADOW = 'paint.bin';
const PROJECT_ENTRY: RegExp = /^(manifest\.json|paint\.bin|model\.(stl|obj)|reference\/\d+|tone\/\d+|edge\/\d+|part\/\d+\.stl)$/;
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

function validSwatch(entry: unknown) {
  return isRecord(entry) && typeof entry.hex === 'string' && /^#[a-f0-9]{6}$/i.test(entry.hex) &&
    [entry.brand, entry.bottleName, entry.mixNotes].every((field) => typeof field === 'string');
}

function finiteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function validateKit(value: unknown): asserts value is KitState {
  if (!isRecord(value) || !Array.isArray(value.parts) || !value.parts.length || !Array.isArray(value.joints) ||
    !value.parts.every((part) => isRecord(part) && nonemptyId(part.id) && typeof part.name === 'string' &&
      nonemptyId(part.sourceName) && typeof part.staged === 'boolean' && typeof part.hidden === 'boolean' &&
      [part.faceOffset, part.batchOffset].every((offset) => offset === undefined ||
        (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && offset <= 0xffffffff)) &&
      isRecord(part.pose) && finiteTuple(part.pose.translation, 3) && finiteTuple(part.pose.rotation, 4) &&
      Math.abs(1 - Math.hypot(...part.pose.rotation)) < 1e-5)) {
    throw new Error('Invalid kit part metadata.');
  }
  const parts = new Map(value.parts.map((part) => [part.id, part]));
  const anchor = value.parts[0];
  if (parts.size !== value.parts.length || anchor.staged ||
    (anchor.faceOffset ?? 0) !== 0 || (anchor.batchOffset ?? 0) !== 0 ||
    anchor.pose.translation.some((axis: number) => axis !== 0) ||
    anchor.pose.rotation.some((axis: number, index: number) => axis !== (index === 3 ? 1 : 0))) {
    throw new Error('Invalid kit anchor or part IDs.');
  }

  const parents = new Map<string, string>();
  for (const joint of value.joints) {
    if (!isRecord(joint) || !nonemptyId(joint.childId) || !nonemptyId(joint.parentId) || !finiteTuple(joint.point, 3) ||
      !['authored', 'six-face', 'manual', 'nearby'].some((method) => method === joint.method) ||
      joint.childId === anchor.id || !parts.has(joint.childId) || !parts.has(joint.parentId) ||
      parts.get(joint.childId)?.staged || parts.get(joint.parentId)?.staged || parents.has(joint.childId)) {
      throw new Error('Invalid kit attachment.');
    }
    parents.set(joint.childId, joint.parentId);
  }
  if (value.installation !== undefined) {
    const plan = value.installation;
    if (!isRecord(plan) || !Array.isArray(plan.order) || !Array.isArray(plan.isolatedViews) || !isRecord(plan.notes) ||
        plan.order.length !== parents.size || new Set(plan.order).size !== plan.order.length ||
        !plan.order.every((id) => nonemptyId(id) && parents.has(id)) ||
        !Object.entries(plan.notes).every(([id, note]) => parents.has(id) && typeof note === 'string') ||
        new Set(plan.isolatedViews).size !== plan.isolatedViews.length ||
        !plan.isolatedViews.every((id) => nonemptyId(id) && parts.has(id) && !parts.get(id).staged)) {
      throw new Error('Invalid installation order or selected part views.');
    }
  }
  for (const part of value.parts) {
    if (part.staged || part.id === anchor.id) continue;
    const visited = new Set<string>();
    let id: string | undefined = part.id;
    while (id && id !== anchor.id && !visited.has(id)) {
      visited.add(id);
      id = parents.get(id);
    }
    if (id !== anchor.id) throw new Error('Kit attachments must lead back to the anchor.');
  }
}

function validateState(value: unknown): asserts value is ProjectState {
  if (!isRecord(value) || !isRecord(value.orientation)) throw new Error('Invalid paint project settings.');
  const { upright, front } = value.orientation;
  if (typeof upright !== 'string' || typeof front !== 'string' ||
      !AXIS.test(upright) || !AXIS.test(front) || upright[1] === front[1]) {
    throw new Error('Invalid paint project orientation.');
  }

  if (value.kit !== undefined) validateKit(value.kit);
  const { recipes, references, regions, snapshots } = value;
  if (!Array.isArray(recipes) || !recipes.every((recipe) => isRecord(recipe) && nonemptyId(recipe.id) &&
      typeof recipe.name === 'string' && isRecord(recipe.swatches) &&
      (recipe.edgeSwatch === undefined || validSwatch(recipe.edgeSwatch)) &&
      ['shadow', 'midtone', 'highlight'].every((tone) =>
        validSwatch((recipe.swatches as Record<string, unknown>)[tone]))) || !validIdList(recipes, value.activeRecipeId)) {
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
  const regionIds = new Set(regions.map(({ id }) => id));
  const kitPartIds = new Set((value.kit as KitState | undefined)?.parts.map((part) => part.id));
  function validManualRegion(value: unknown) {
    if (typeof value !== 'string') return false;
    if (regionIds.has(value)) return true;
    const [partId, regionId, extra] = value.split('/');
    return extra === undefined && kitPartIds.has(partId) && regionIds.has(regionId);
  }
  if (snapshots.some((snapshot) => snapshot.edgeManualRegions !== undefined &&
      (!Array.isArray(snapshot.edgeManualRegions) || !snapshot.edgeManualRegions.every(validManualRegion)))) {
    throw new Error('Invalid manual edge regions.');
  }
  if (value.guideCallouts !== undefined) {

    if (!Array.isArray(value.guideCallouts) || !value.guideCallouts.every((callout) =>
      isRecord(callout) && regionIds.has(callout.regionId) && GUIDE_VIEWS.some((view) => view === callout.view) &&
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
  if (contents.state.snapshots.some((snapshot) => snapshot.edgeManualRegions !== undefined) !== Boolean(contents.edges) ||
      (contents.edges && (!Array.isArray(contents.edges) || contents.edges.length !== contents.state.snapshots.length ||
        !contents.edges.every((mask) => mask instanceof Uint32Array && mask.length % 4 === 0)))) {
    throw new Error('Invalid edge highlight masks.');
  }
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
  partSources: readonly string[] = [],
) {
  validatePayload(contents);
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension !== '.stl' && extension !== '.obj') throw new Error('Project source must be an STL or OBJ.');
  if (partSources.length !== (contents.state.kit ? contents.state.kit.parts.length - 1 : 0) ||
    partSources.some((file) => path.extname(file).toLowerCase() !== '.stl')) {
    throw new Error('One or more original kit files are missing.');
  }
  const stats = await Promise.all([sourcePath, ...partSources].map((file) => fs.promises.stat(file)));
  if (stats.some((file) => !file.isFile() || file.size <= 0) ||
      stats.reduce((total, file) => total + file.size, 0) > MAX_MODEL_BYTES) {
    throw new Error('Original kit files exceed the 2 GiB project limit.');
  }
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
    partSources.forEach((file, index) => zip.addFile(file, `part/${index}.stl`, { compress: false }));
    contents.referenceBytes.forEach((bytes, index) => zip.addBuffer(asBuffer(bytes), `reference/${index}`, { compress: false }));
    zip.addBuffer(asBuffer(contents.paint), SHADOW);
    contents.tones.forEach((tones, index) => zip.addBuffer(asBuffer(tones), `tone/${index}`));
    contents.edges?.forEach((mask, index) => zip.addBuffer(asBuffer(mask), `edge/${index}`));
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
  if ((name.startsWith('model.') || name.startsWith('part/')) &&
    (entry.uncompressedSize > MAX_MODEL_BYTES || entry.uncompressedSize <= 0)) {
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
  let totalModelBytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.startsWith('model.') || entry.fileName.startsWith('part/')) {
          totalModelBytes += entry.uncompressedSize;
          if (totalModelBytes > MAX_MODEL_BYTES) {
            reject(new Error('The archive exceeds the 2 GiB limit for original geometry.'));
            return;
          }
        }
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
    const partEntries = manifest.kit?.parts.slice(1).map((_, index) => 'part/' + index + '.stl') ?? [];
    const hasEdges = manifest.snapshots.some((snapshot) => snapshot.edgeManualRegions !== undefined);
    const expected = new Set([
      MANIFEST, SHADOW, original, ...partEntries,
      ...manifest.references.map((_, index) => `reference/${index}`),
      ...manifest.snapshots.map((_, index) => `tone/${index}`),
      ...(hasEdges ? manifest.snapshots.map((_, index) => `edge/${index}`) : []),
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
    const edges = hasEdges ? [] as Uint32Array[] : undefined;
    if (edges) {
      for (let i = 0; i < manifest.snapshots.length; i++) {
        edges.push(await readPackedFile(path.join(root, 'edge', String(i))));
      }
    }
    const paint = await readPackedFile(path.join(root, SHADOW));
    return {
      originalPath: path.join(root, original), sourceName: manifest.sourceName,
      kitParts: partEntries.map((entry, index) => ({
        originalPath: path.join(root, entry), sourceName: manifest.kit!.parts[index + 1].sourceName,
      })),
      contents: { state: manifest, referenceBytes, paint, tones, edges }, cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
