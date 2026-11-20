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
import { lightingConfigurationKey, type ProjectContents, type ProjectManifest, type ProjectState } from '../shared/paintProject';
import type { ModelOrientation } from '../shared/workerProtocol';

const MANIFEST = 'manifest.json';
const SHADOW = 'paint.bin';
const TONES = 'tone.bin';
const EDGES = 'edge.bin';
const PROJECT_ENTRY: RegExp = /^(manifest\.json|paint\.bin|tone\.bin|edge\.bin|model\.(stl|obj)|reference\/\d+|tone\/\d+|edge\/\d+|part\/\d+\.stl)$/;
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
      (part.placementConfirmed === undefined || (part.placementConfirmed === true && !part.staged)) &&
      [part.faceOffset, part.batchOffset].every((offset) => offset === undefined ||
        (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && offset <= 0xffffffff)) &&
      isRecord(part.pose) && finiteTuple(part.pose.translation, 3) && finiteTuple(part.pose.rotation, 4) &&
      Math.abs(1 - Math.hypot(...part.pose.rotation)) < 1e-5)) {
    throw new Error('Invalid kit part metadata.');
  }
  const parts = new Map(value.parts.map((part) => [part.id, part]));
  const anchor = value.parts[0];
  if (parts.size !== value.parts.length || anchor.staged || anchor.placementConfirmed ||
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
      parts.get(joint.childId)?.staged || parts.get(joint.childId)?.placementConfirmed || parts.get(joint.parentId)?.staged || parents.has(joint.childId)) {
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
    while (id && id !== anchor.id && !parts.get(id)?.placementConfirmed && !visited.has(id)) {
      visited.add(id);
      id = parents.get(id);
    }
    if (id !== anchor.id && !(id && parts.get(id)?.placementConfirmed)) {
      throw new Error('Kit attachments must lead back to the anchor or a confirmed placement.');
    }
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
  const { recipes, references, lighting } = value;
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
  if (!isRecord(lighting) || !Array.isArray(lighting.sources) || !lighting.sources.every((source) =>
      isRecord(source) && nonemptyId(source.id) && typeof source.name === 'string' &&
      inRange(source.azimuth, 0, 359) && inRange(source.elevation, -90, 90) && inRange(source.intensity, 0, 100)) ||
      !validIdList(lighting.sources, lighting.activeSourceId) || (lighting.sources.length > 0) !== (lighting.activeSourceId !== null) ||
      !inRange(lighting.midtone, 0, 100) || !Number.isInteger(lighting.midtone) ||
      !inRange(lighting.highlight, lighting.midtone, 100) || !Number.isInteger(lighting.highlight) ||
      typeof lighting.castShadowsBetweenParts !== 'boolean' || typeof lighting.applied !== 'boolean' ||
      typeof lighting.manual !== 'boolean' || (lighting.appliedLightKey !== undefined && typeof lighting.appliedLightKey !== 'string')) {
    throw new Error('Invalid paint project lighting.');
  }
  const recipeIds = new Set(recipes.map(({ id }) => id));
  const kitPartIds = new Set((value.kit as KitState | undefined)?.parts.map((part) => part.id));
  function validManualRecipe(value: unknown) {
    if (typeof value !== 'string') return false;
    if (recipeIds.has(value)) return true;
    const [partId, recipeId, extra] = value.split('/');
    return extra === undefined && kitPartIds.has(partId) && recipeIds.has(recipeId);
  }
  if (value.edgeManualRecipes !== undefined &&
      (!Array.isArray(value.edgeManualRecipes) || !value.edgeManualRecipes.every(validManualRecipe))) {
    throw new Error('Invalid manual edge recipes.');
  }
  if (value.guideCallouts !== undefined) {

    if (!Array.isArray(value.guideCallouts) || !value.guideCallouts.every((callout) =>
      isRecord(callout) && recipeIds.has(callout.recipeId) && GUIDE_VIEWS.some((view) => view === callout.view) &&
      inRange(callout.x, 0, 1) && inRange(callout.y, 0, 1))) {
      throw new Error('Invalid paint project guide callouts.');
    }
  }
}

function migrateLegacyLighting(value: Record<string, unknown>) {
  const { snapshots, activeSnapshotId, ...base } = value;
  if (!Array.isArray(snapshots) || !snapshots.every((item) => isRecord(item) && nonemptyId(item.id) &&
      typeof item.name === 'string' && inRange(item.azimuth, 0, 359) && inRange(item.elevation, -90, 90) &&
      inRange(item.midtone, 0, 100) && inRange(item.highlight, item.midtone, 100) &&
      typeof item.applied === 'boolean' && typeof item.manual === 'boolean') ||
      !nonemptyId(activeSnapshotId) || !validIdList(snapshots, activeSnapshotId)) {
    throw new Error('Invalid legacy project lighting.');
  }
  const index = snapshots.findIndex(({ id }) => id === activeSnapshotId);
  const old = snapshots[index];
  const sources = snapshots.map((item, i) => ({
    id: `light-${i + 1}`, name: /^Snapshot \d+$/i.test(item.name.trim()) ? `Light ${i + 1}` : item.name,
    azimuth: item.azimuth, elevation: item.elevation, intensity: i === index ? 100 : 0,
  }));
  const source = sources[index];
  const lighting: ProjectState['lighting'] = {
    sources, activeSourceId: source.id, midtone: Math.round(old.midtone),
    highlight: Math.round(old.highlight), castShadowsBetweenParts: old.castShadowsBetweenParts !== false,
    applied: old.applied, manual: old.manual,
  };
  if (typeof old.appliedLightKey === 'string') {
    try {
      const key: unknown = JSON.parse(old.appliedLightKey);
      if (Array.isArray(key) && key.length >= 6 && key.slice(0, 4).every(Number.isFinite) &&
          [key[4], key[5]].every((axis) => typeof axis === 'string' && AXIS.test(axis))) {
        lighting.appliedLightKey = lightingConfigurationKey({
          sources: [{ ...source, azimuth: key[0], elevation: key[1] }],
          midtone: Math.round(key[2]), highlight: Math.round(key[3]), castShadowsBetweenParts: key[7] !== 'self-only',
        }, { upright: key[4], front: key[5] } as ModelOrientation, typeof key[6] === 'string' ? key[6] : undefined);
      }
    } catch {
      // Older archives can omit the key. Their saved mask is still readable.
    }
  }
  const hasEdges = snapshots.some((item) => item.edgeManualRegions !== undefined);
  const maskEntries = snapshots.flatMap((_, i) => hasEdges ? [`tone/${i}`, `edge/${i}`] : [`tone/${i}`]);
  return {
    state: { ...base, lighting, ...(hasEdges ? { edgeManualRegions: old.edgeManualRegions ?? [] } : {}) },
    maskEntries, toneEntry: `tone/${index}`, edgeEntry: hasEdges ? `edge/${index}` : undefined,
  };
}

function migrateLegacyRecipes(value: Record<string, unknown>) {
  const { regions, activeRegionId, edgeManualRegions, guideCallouts, ...base } = value;
  if (!Array.isArray(regions) || !regions.every((region) => isRecord(region) && nonemptyId(region.id) &&
      typeof region.name === 'string' && typeof region.recipeId === 'string') ||
      !validIdList(regions, activeRegionId) || !Array.isArray(base.recipes) ||
      !base.recipes.every((recipe) => isRecord(recipe) && nonemptyId(recipe.id))) {
    throw new Error('Invalid legacy paint project assignments.');
  }
  const recipes = [...base.recipes];
  const indices = new Map(recipes.map(({ id }, index) => [id, index]));
  const legacyIds = new Map<string, string>();
  const swatch = { hex: '#2b303a', brand: '', bottleName: '', mixNotes: '' };
  const recipeIndices = regions.map((region, i) => {
    let id = region.recipeId;
    if (!indices.has(id)) {
      id = 'recovered-recipe-' + (i + 1);
      while (indices.has(id)) id += '-recovered';
      indices.set(id, recipes.length);
      recipes.push({ id, name: region.name.trim() || 'Recovered paint', swatches: {
        shadow: swatch, midtone: swatch, highlight: swatch,
      } });
    }
    legacyIds.set(region.id, id);
    return indices.get(id)!;
  });
  function migrateManualKey(key: unknown) {
    if (typeof key !== 'string') throw new Error('Invalid legacy edge assignment.');
    const direct = legacyIds.get(key);
    if (direct) return direct;
    const [part, region, extra] = key.split('/');
    const recipe = legacyIds.get(region);
    if (!part || !recipe || extra !== undefined) throw new Error('Invalid legacy edge assignment.');
    return part + '/' + recipe;
  }
  const positions = new Set<string>();
  const callouts = Array.isArray(guideCallouts) ? guideCallouts.flatMap((value) => {
    if (!isRecord(value) || typeof value.regionId !== 'string') throw new Error('Invalid legacy guide callout.');
    const { regionId, ...position } = value;
    const recipeId = legacyIds.get(regionId);
    if (!recipeId) throw new Error('Invalid legacy guide callout assignment.');
    const key = JSON.stringify([position.view, recipeId]);
    if (positions.has(key)) return [];
    positions.add(key);
    return [{ ...position, recipeId }];
  }) : guideCallouts;
  return {
    recipeIndices,
    state: { ...base, recipes, activeRecipeId: legacyIds.get(String(activeRegionId ?? '')) ?? base.activeRecipeId,
      guideCallouts: callouts,
      edgeManualRecipes: Array.isArray(edgeManualRegions) ? [...new Set(edgeManualRegions.map(migrateManualKey))] : edgeManualRegions },
  };
}

function migrateLegacyMasks(recipeIndices: number[], paint: Uint32Array, tone: Uint32Array, edge?: Uint32Array) {
  const seen = new Set<number>();
  const merged = new Set<number>();
  for (const index of recipeIndices) {
    if (seen.has(index)) merged.add(index);
    seen.add(index);
  }
  const legacyOwners = new Map<number, number>();
  const lookup = (index: number) => {
    const recipe = recipeIndices[index];
    if (recipe === undefined) throw new Error('Invalid legacy paint mask assignment.');
    return recipe;
  };
  for (let i = 0; i < paint.length; i += 4) {
    const oldIndex = paint[i + 3];
    const recipe = lookup(oldIndex);
    if (merged.has(recipe)) legacyOwners.set(paint[i], oldIndex);
    paint[i + 3] = recipe;
  }
  function migrateMask(mask: Uint32Array, indexOffset: number) {
    let length = 0;
    for (let i = 0; i < mask.length; i += 4) {
      const oldIndex = mask[i + indexOffset];
      const recipe = lookup(oldIndex);
      // Merging old assignments must not revive masks from an earlier coat.
      if (merged.has(recipe) && legacyOwners.get(mask[i]) !== oldIndex) continue;
      if (length !== i) mask.copyWithin(length, i, i + 4);
      mask[length + indexOffset] = recipe;
      length += 4;
    }
    return mask.subarray(0, length);
  }
  return { toneMask: migrateMask(tone, 2), edgeMask: edge && migrateMask(edge, 3) };
}

function parseManifest(raw: string) {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) throw new Error('Unsupported paint project version.');
  if (!nonemptyId(value.sourceName) || (value.sourceExtension !== '.stl' && value.sourceExtension !== '.obj')) {
    throw new Error('Invalid original model entry.');
  }
  const { sourceName, sourceExtension } = value;
  const edgeEntry = (value.version === 3 ? value.edgeManualRecipes : value.edgeManualRegions) !== undefined ? EDGES : undefined;
  const data = value.version === 1 ? migrateLegacyLighting(value) : {
    state: value, maskEntries: edgeEntry ? [TONES, edgeEntry] : [TONES], toneEntry: TONES, edgeEntry,
  };
  const legacy = value.version < 3 ? migrateLegacyRecipes(data.state) : undefined;
  const state = legacy?.state ?? data.state;
  validateState(state);
  const manifest: ProjectManifest = { ...state, sourceName, sourceExtension, version: 3 };
  return { ...data, manifest, recipeIndices: legacy?.recipeIndices };
}

function validatePayload(contents: ProjectContents) {
  validateState(contents.state);
  if ((contents.state.edgeManualRecipes !== undefined) !== Boolean(contents.edgeMask) ||
      (contents.edgeMask && (!(contents.edgeMask instanceof Uint32Array) || contents.edgeMask.length % 4))) {
    throw new Error('Invalid edge highlight mask.');
  }
  if (!Array.isArray(contents.referenceBytes) || contents.referenceBytes.length !== contents.state.references.length ||
      !contents.referenceBytes.every((reference) => ArrayBuffer.isView(reference) && reference.BYTES_PER_ELEMENT === 1) ||
      !(contents.paint instanceof Uint32Array) || contents.paint.length % 4 ||
      !(contents.toneMask instanceof Uint32Array) || contents.toneMask.length % 4) {
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
  verifyDestination?: () => Promise<void>,
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
    version: 3,
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
    zip.addBuffer(asBuffer(contents.toneMask), TONES);
    if (contents.edgeMask) zip.addBuffer(asBuffer(contents.edgeMask), EDGES);
    zip.end({ forceZip64Format: true, comment: '' });

    await pipeline(output, fs.createWriteStream(temp, { flags: 'wx' }));
    const written = await fs.promises.open(temp, 'r+');
    try {
      await written.sync();
    } finally {
      await written.close();
    }
    await verifyDestination?.();
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
    const { manifest, maskEntries, toneEntry, edgeEntry, recipeIndices } = parseManifest(await fs.promises.readFile(path.join(root, MANIFEST), 'utf8'));
    const original = `model${manifest.sourceExtension}`;
    const partEntries = manifest.kit?.parts.slice(1).map((_, index) => 'part/' + index + '.stl') ?? [];
    const expected = new Set([
      MANIFEST, SHADOW, original, ...partEntries,
      ...manifest.references.map((_, index) => `reference/${index}`),
      ...maskEntries,
    ]);

    if (entries.size !== expected.size || [...expected].some((entry) => !entries.has(entry))) {
      throw new Error('The archive is missing project assets or contains unexpected entries.');
    }

    const referenceBytes: Uint8Array[] = [];
    for (let i = 0; i < manifest.references.length; i++) {
      const bytes = await fs.promises.readFile(path.join(root, 'reference', String(i)));
      referenceBytes.push(Uint8Array.from(bytes));
    }
    const toneMask = await readPackedFile(path.join(root, toneEntry));
    const edgeMask = edgeEntry ? await readPackedFile(path.join(root, edgeEntry)) : undefined;
    const paint = await readPackedFile(path.join(root, SHADOW));
    const masks = recipeIndices ? migrateLegacyMasks(recipeIndices, paint, toneMask, edgeMask) : { toneMask, edgeMask };
    return {
      originalPath: path.join(root, original), sourceName: manifest.sourceName,
      kitParts: partEntries.map((entry, index) => ({
        originalPath: path.join(root, entry), sourceName: manifest.kit!.parts[index + 1].sourceName,
      })),
      contents: { state: manifest, referenceBytes, paint, ...masks }, cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
