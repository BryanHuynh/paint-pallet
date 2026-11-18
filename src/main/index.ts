import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { savePaintingGuide } from './paintingGuide';
import type { GuideExport } from '../shared/paintingGuide';
import { ANCHOR_ADDRESS, restoreKitAddresses } from '../shared/kit';
import type { OpenedProject, ProjectContents, ProjectSaveRequest } from '../shared/paintProject';
import { openProjectArchive, writeProjectArchive } from './projectArchive';
import path from 'node:path';
import { WorkerClient, readBatchBinary } from './workerClient';
import type { ConnectedFillRequest, ExposureRequest, RidgeBandRequest, KitImportResult, ModelSummary, Vec3 } from '../shared/workerProtocol';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const originalSources = new Map<string, { path: string; name: string; cleanup?: () => Promise<void> }>();
let loadedModelId: string | null = null;
let mainWindow: BrowserWindow | null = null;
let workerClient: WorkerClient | null = null;
const activeFillJobs = new Set<string>();
const activeLightingJobs = new Set<string>();
let activeImportJobId: string | null = null;
let activeKitImport: AbortController | null = null;
const kitModels = new Map<string, ModelSummary>();
const stagedKitsByAnchor = new Map<string, ModelSummary[]>();
const MAX_KIT_BYTES = 2 * 1024 * 1024 * 1024;
const authorizedImportPaths = new Set<string>();
let committedBatchPaths = new Set<string>();
const stagedBatchesByModelId = new Map<string, Set<string>>();

function isAuthorizedBatchPath(resolvedPath: string): boolean {
  if (committedBatchPaths.has(resolvedPath)) return true;
  for (const paths of stagedBatchesByModelId.values()) {
    if (paths.has(resolvedPath)) return true;
  }
  return false;
}

function collectBatchPaths(summary: ModelSummary): Set<string> {
  const paths = new Set<string>();
  if (summary.previewFilePath) {
    paths.add(path.resolve(summary.previewFilePath));
  }
  for (const b of summary.batches) {
    paths.add(path.resolve(b.filePath));
  }
  return paths;
}

function getWorkerClient(): WorkerClient {
  if (!workerClient) {
    workerClient = new WorkerClient({
      cacheDir: path.join(app.getPath('userData'), 'mesh-cache'),
    });
    workerClient.onProgress((evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('worker:import-progress', evt);
      }
    });
  }
  return workerClient;
}

function resolveAppIconPath(): string | undefined {
  const iconFileName =
    process.platform === 'win32'
      ? 'paint-pallet-logo.ico'
      : 'paint-pallet-logo.png';
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, iconFileName) : null,
    path.resolve(app.getAppPath(), 'assets', iconFileName),
    path.resolve(process.cwd(), 'assets', iconFileName),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function releaseOriginalSource(id: string) {
  const source = originalSources.get(id);
  originalSources.delete(id);
  await source?.cleanup?.().catch(() => {});
}

async function validateProjectFaces(model: ModelSummary, contents: ProjectContents, kitModels: ModelSummary[]) {
  const geometry = contents.state.kit ? restoreKitAddresses([model, ...kitModels], contents.state.kit)
    : [{ model, ...ANCHOR_ADDRESS, staged: false }];
  const batchMap = new Map<number, ModelSummary['batches'][number] & { faceOffset: number; faceEnd: number }>();
  const ends = geometry.map((part) => [part.faceOffset, part.faceOffset + part.model.triangleCount]).sort(([a], [b]) => a - b);
  if (ends.some(([start, end], index) => end > 0xffffffff || (index > 0 && ends[index - 1][1] > start))) {
    throw new Error('Paint project part face addresses overlap.');
  }
  const lookedUp = new Set<number>();
  for (const part of geometry) {
    for (const batch of part.model.batches) {
      const index = batch.batchIndex + part.batchOffset;
      if (index > 0xffffffff || lookedUp.has(index)) throw new Error('Paint project part batch addresses overlap.');
      lookedUp.add(index);
      if (!part.staged) batchMap.set(index, { ...batch, faceOffset: part.faceOffset, faceEnd: part.faceOffset + part.model.triangleCount });
    }
  }
  const checked = new Map<number, { faceId: number; ordinal: number }[]>();
  for (const mask of [contents.paint, ...(contents.edges ?? [])]) {
    for (let i = 0; i < mask.length; i += 4) {
      const [faceId, batchIndex, ordinal, regionIndex] = mask.subarray(i, i + 4);
      const batch = batchMap.get(batchIndex);
      if (!batch || faceId < batch.faceOffset || faceId >= batch.faceEnd || ordinal >= batch.triangleCount ||
        regionIndex >= contents.state.regions.length) throw new Error('Project paint refers to an invalid original face.');
      const list = checked.get(batchIndex) ?? [];
      list.push({ faceId, ordinal });
      checked.set(batchIndex, list);
    }
  }
  for (const [batchIndex, list] of checked) {
    const batch = batchMap.get(batchIndex)!;
    const file = await fs.promises.open(batch.filePath, 'r');
    try {
      const offset = 16 + batch.triangleCount * 72;
      const ids = Buffer.alloc(batch.triangleCount * 4);
      const { bytesRead } = await file.read(ids, 0, ids.length, offset);
      if (bytesRead !== ids.length || list.some(({ faceId, ordinal }) => ids.readUInt32LE(ordinal * 4) + batch.faceOffset !== faceId)) {
        throw new Error('Project paint does not match the rebuilt model.');
      }
    } finally {
      await file.close();
    }
  }
  for (const tone of contents.tones) {
    for (let i = 0; i < tone.length; i += 4) {
      const batch = batchMap.get(tone[i + 1]);
      if (!batch || tone[i] < batch.faceOffset || tone[i] >= batch.faceEnd ||
          tone[i + 2] >= contents.state.regions.length || (tone[i + 3] !== 1 && tone[i + 3] !== 2)) {
        throw new Error('Project lighting refers to an invalid original face.');
      }
    }
  }
}

function createWindow(): void {
  const iconPath = resolveAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1f10',
    title: 'Paint Pallet',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

app.whenReady().then(() => {
  ipcMain.handle('dialog:select-stl', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open STL or OBJ',
      properties: ['openFile'],
      filters: [{ name: 'STL and OBJ meshes', extensions: ['stl', 'obj'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const resolved = path.resolve(result.filePaths[0]);
    authorizedImportPaths.add(resolved);
    return resolved;
  });

  async function importStl(
    resolved: string,
    original?: { name: string; cleanup?: () => Promise<void> },
  ): Promise<ModelSummary> {
    if (activeImportJobId) {
      throw new Error('An STL import is already in progress');
    }
    const jobId = crypto.randomUUID().replace(/-/g, '');
    activeImportJobId = jobId;
    try {
      const summary = await getWorkerClient().importStl(resolved, jobId, { staged: true, displayName: original?.name });
      stagedBatchesByModelId.set(summary.modelId, collectBatchPaths(summary));
      originalSources.set(summary.modelId, { path: resolved, name: original?.name ?? summary.fileName, cleanup: original?.cleanup });
      return summary;
    } finally {
      if (activeImportJobId === jobId) {
        activeImportJobId = null;
      }
    }
  }

  ipcMain.handle('worker:import-stl', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('Unauthorized or invalid STL path');
    }
    const resolved = path.resolve(filePath);
    if (!authorizedImportPaths.has(resolved)) {
      throw new Error('STL path must be selected through the file dialog');
    }
    return importStl(resolved);
  });

  // The preload derives this path from a disk-backed File before invoking IPC.
  ipcMain.handle('worker:import-dropped-stl', async (event, filePath: string) => {
    if (
      !mainWindow ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      typeof filePath !== 'string' ||
      !path.isAbsolute(filePath) ||
      !['.stl', '.obj'].includes(path.extname(filePath).toLowerCase())
    ) {
      throw new Error('Drop an STL or OBJ file from your computer.');
    }
    return importStl(path.resolve(filePath));
  });

  ipcMain.handle('kit:import-parts', async (): Promise<KitImportResult | null> => {
    if (!mainWindow || !loadedModelId || activeKitImport || activeImportJobId) return null;
    const controller = new AbortController();
    activeKitImport = controller;
    const models: ModelSummary[] = [];
    const errors: string[] = [];
    try {
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: 'Add binary STL kit parts',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Binary STL kit parts', extensions: ['stl'] }],
      });
      if (selection.canceled) return null;
      const anchor = await getWorkerClient().getActiveModel();
      if (!anchor) throw new Error('Open the kit anchor before adding parts.');
      let total = anchor.fileSizeBytes;
      for (const part of kitModels.values()) total += part.fileSizeBytes;
      const loadedSources = new Set([...originalSources.values()].map((source) => source.path.toLowerCase()));
      for (const file of selection.filePaths) {
        if (controller.signal.aborted) break;
        const source = path.resolve(file);
        const name = path.basename(source);
        const key = source.toLowerCase();
        if (loadedSources.has(key)) {
          errors.push(`${name} is already loaded.`);
          continue;
        }
        try {
          if (path.extname(source).toLowerCase() !== '.stl') throw new Error('Choose a binary STL.');
          const handle = await fs.promises.open(source, 'r');
          let bytes: number;
          try {
            bytes = (await handle.stat()).size;
            const header = Buffer.alloc(84);
            const { bytesRead } = await handle.read(header, 0, header.length, 0);
            if (bytesRead !== header.length || header.readUInt32LE(80) === 0 || bytes !== 84 + header.readUInt32LE(80) * 50) {
              throw new Error('Kit parts must be full binary STL files.');
            }
            if (total + bytes > MAX_KIT_BYTES) throw new Error('Adding this part would exceed the 2 GiB kit limit.');
          } finally {
            await handle.close();
          }
          controller.signal.throwIfAborted();
          const part = await importStl(source);
          if (controller.signal.aborted || total + part.fileSizeBytes > MAX_KIT_BYTES) {
            await getWorkerClient().discardModel(part.modelId);
            stagedBatchesByModelId.delete(part.modelId);
            await releaseOriginalSource(part.modelId);
            controller.signal.throwIfAborted();
            throw new Error('Adding this part would exceed the 2 GiB kit limit.');
          }
          kitModels.set(part.modelId, part);
          models.push(part);
          loadedSources.add(key);
          total += part.fileSizeBytes;
        } catch (error) {
          if (!controller.signal.aborted) errors.push(`${name} · ${error instanceof Error ? error.message : 'Import failed.'}`);
        }
      }
      return { models, errors, canceled: controller.signal.aborted };
    } finally {
      activeKitImport = null;
    }
  });

  ipcMain.handle('worker:commit-model', async (_event, modelId: string) => {
    if (typeof modelId !== 'string' || !modelId) {
      return { committed: false };
    }
    const replacement = stagedKitsByAnchor.get(modelId) ?? [];
    const res = await getWorkerClient().commitModel(modelId, replacement.map((part) => part.modelId));
    if (res.committed) {
      const previous = loadedModelId;
      loadedModelId = modelId;
      if (previous && previous !== modelId) await releaseOriginalSource(previous);
      for (const partId of kitModels.keys()) {
        stagedBatchesByModelId.delete(partId);
        await releaseOriginalSource(partId);
      }
      kitModels.clear();
      stagedKitsByAnchor.delete(modelId);
      for (const part of replacement) kitModels.set(part.modelId, part);
      const promoted = stagedBatchesByModelId.get(modelId);
      if (promoted) {
        committedBatchPaths = promoted;
      }
      stagedBatchesByModelId.delete(modelId);
    }
    return res;
  });

  async function discardStagedPart(modelId: string) {
    const result = await getWorkerClient().discardModel(modelId);
    if (result.discarded) {
      kitModels.delete(modelId);
      stagedBatchesByModelId.delete(modelId);
      await releaseOriginalSource(modelId);
    }
    return result;
  }

  ipcMain.handle('worker:discard-model', async (_event, modelId: string) => {
    if (typeof modelId !== 'string' || !modelId) {
      return { discarded: false };
    }
    const stagedParts = stagedKitsByAnchor.get(modelId);
    if (stagedParts) {
      stagedKitsByAnchor.delete(modelId);
      for (const part of stagedParts) await discardStagedPart(part.modelId);
    }
    return discardStagedPart(modelId);
  });

  ipcMain.handle('worker:cancel-import', async () => {
    activeKitImport?.abort();
    if (!activeImportJobId) {
      return { canceled: Boolean(activeKitImport?.signal.aborted) };
    }
    return getWorkerClient().cancelImport(activeImportJobId);
  });

  ipcMain.handle('worker:get-active-model', async () => {
    return getWorkerClient().getActiveModel();
  });

  ipcMain.handle('worker:read-batch', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('Invalid batch path');
    }
    const resolved = path.resolve(filePath);
    if (!isAuthorizedBatchPath(resolved)) {
      throw new Error('Unauthorized batch file path');
    }
    return readBatchBinary(resolved);
  });

  ipcMain.handle(
    'worker:pick-face',
    async (_event, modelId: string, origin: Vec3, direction: Vec3, batchIndices?: number[]) => {
      return getWorkerClient().pickFace(modelId, origin, direction, batchIndices);
    },
  );

  ipcMain.handle('worker:connected-fill', async (_event, request: ConnectedFillRequest) => {
    if (!request || typeof request.modelId !== 'string' ||
      (request.modelId !== loadedModelId && !kitModels.has(request.modelId)) ||
      typeof request.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.jobId) ||
      !Number.isSafeInteger(request.faceId) || request.faceId < 0 ||
      !Number.isFinite(request.maxCreaseDegrees) || request.maxCreaseDegrees < 0 || request.maxCreaseDegrees > 180 ||
      !Array.isArray(request.blockedFaces) ||
      request.blockedFaces.some((face) => !Number.isSafeInteger(face) || face < 0 || face > 0xffffffff) ||
      activeFillJobs.has(request.jobId)) {
      throw new Error('Invalid connected fill request.');
    }

    activeFillJobs.add(request.jobId);
    try {
      return await getWorkerClient().previewConnectedFill(request);
    } finally {
      activeFillJobs.delete(request.jobId);
    }
  });

  ipcMain.handle('worker:ridge-band', async (_event, request: RidgeBandRequest) => {
    if (!request || (request.modelId !== loadedModelId && !kitModels.has(request.modelId)) ||
      typeof request.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.jobId) ||
      !(request.crease >= 1 && request.crease <= 180) || !(request.widthPercent > 0 && request.widthPercent <= 100) ||
      !(request.regionFaces instanceof Uint32Array) || activeFillJobs.has(request.jobId)) {
      throw new Error('Invalid edge highlight request.');
    }
    activeFillJobs.add(request.jobId);
    try {
      return await getWorkerClient().previewRidgeBand(request);
    } finally {
      activeFillJobs.delete(request.jobId);
    }
  });

  ipcMain.handle('worker:cancel-fill', async (_event, jobId: string) => {
    if (!activeFillJobs.has(jobId)) return { canceled: false };
    return getWorkerClient().cancelImport(jobId);
  });

  ipcMain.handle('worker:light-exposure', async (_event, request: ExposureRequest) => {
    if (!request || request.modelId !== loadedModelId ||
      typeof request.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.jobId) ||
      !Array.isArray(request.direction) || request.direction.length !== 3 ||
      !request.direction.every(Number.isFinite) || activeLightingJobs.has(request.jobId)) {
      throw new Error('Invalid lighting request.');
    }
    const parts = request.parts;
    if (parts !== undefined && (!Array.isArray(parts) || !parts.length || parts[0]?.modelId !== loadedModelId ||
      new Set(parts.map((part) => part?.modelId)).size !== parts.length ||
      !parts.every((part, index) => part && (index === 0 || kitModels.has(part.modelId)) &&
        Number.isSafeInteger(part.faceOffset) && part.faceOffset >= 0 && part.pose &&
        Array.isArray(part.pose.translation) && part.pose.translation.length === 3 &&
        part.pose.translation.every((axis: number) => Number.isFinite(Math.fround(axis))) &&
        Array.isArray(part.pose.rotation) && part.pose.rotation.length === 4 &&
        part.pose.rotation.every(Number.isFinite) && Math.abs(1 - Math.hypot(...part.pose.rotation)) < 1e-5))) {
      throw new Error('Invalid assembled lighting parts.');
    }
    activeLightingJobs.add(request.jobId);
    try {
      return await getWorkerClient().computeLightExposure(request);
    } finally {
      activeLightingJobs.delete(request.jobId);
    }
  });

  ipcMain.handle('worker:cancel-light', async (_event, jobId: string) => {
    if (!activeLightingJobs.has(jobId)) return { canceled: false };
    return getWorkerClient().cancelImport(jobId);
  });

  ipcMain.handle('guide:export', (_event, guide: GuideExport) => {
    if (!mainWindow || !loadedModelId) throw new Error('Open a model before exporting a painting guide.');
    return savePaintingGuide(mainWindow, guide);
  });

  ipcMain.handle('project:save', async (_event, request: ProjectSaveRequest) => {
    const source = request && originalSources.get(request.modelId);
    if (!mainWindow || !source || request.modelId !== loadedModelId) {
      throw new Error('Open a model before saving a paint project.');
    }
    const target = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Paint Pallet project',
      defaultPath: path.parse(source.name).name + '.paintproject',
      filters: [{ name: 'Paint Pallet projects', extensions: ['paintproject'] }],
    });
    if (target.canceled || !target.filePath) return false;
    const ids = request.kitModelIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== kitModels.size ||
        ids.some((id) => !kitModels.has(id) || !originalSources.has(id))) {
      throw new Error('The saved part list does not match the open kit.');
    }
    await writeProjectArchive(target.filePath, source.path, source.name, request, ids.map((id) => originalSources.get(id)!.path));
    return true;
  });

  ipcMain.handle('project:open', async (): Promise<OpenedProject | null> => {
    if (!mainWindow) return null;
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Paint Pallet project',
      properties: ['openFile'],
      filters: [{ name: 'Paint Pallet projects', extensions: ['paintproject'] }],
    });
    if (selection.canceled || !selection.filePaths.length) return null;
    if (activeImportJobId) throw new Error('Wait for the current model import.');
    const archive = await openProjectArchive(selection.filePaths[0], path.join(app.getPath('userData'), 'project-cache'));
    let model: ModelSummary | undefined;
    const kitParts: ModelSummary[] = [];
    try {
      model = await importStl(archive.originalPath, { name: archive.sourceName, cleanup: archive.cleanup });

      for (const part of archive.kitParts) {
        kitParts.push(await importStl(part.originalPath, { name: part.sourceName }));
      }
      await validateProjectFaces(model, archive.contents, kitParts);
      if (kitParts.length) stagedKitsByAnchor.set(model.modelId, kitParts);
      return { model, kitModels: kitParts, ...archive.contents };
    } catch (error) {
      for (const part of kitParts) await discardStagedPart(part.modelId);
      if (model) {
        await discardStagedPart(model.modelId);
      } else {
        await archive.cleanup();
      }
      throw error;
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  for (const id of originalSources.keys()) void releaseOriginalSource(id);
  if (workerClient) {
    void workerClient.dispose();
    workerClient = null;
  }
});
