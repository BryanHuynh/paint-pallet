import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkerClient, readBatchBinary } from './workerClient';
import type { ConnectedFillRequest, ExposureRequest, ModelSummary, Vec3 } from '../shared/workerProtocol';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let workerClient: WorkerClient | null = null;
const activeFillJobs = new Set<string>();
const activeLightingJobs = new Set<string>();
let activeImportJobId: string | null = null;
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

  async function importStl(resolved: string): Promise<ModelSummary> {
    if (activeImportJobId) {
      throw new Error('An STL import is already in progress');
    }
    const jobId = crypto.randomUUID().replace(/-/g, '');
    activeImportJobId = jobId;
    try {
      const summary = await getWorkerClient().importStl(resolved, jobId, { staged: true });
      stagedBatchesByModelId.set(summary.modelId, collectBatchPaths(summary));
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

  ipcMain.handle('worker:commit-model', async (_event, modelId: string) => {
    if (typeof modelId !== 'string' || !modelId) {
      return { committed: false };
    }
    const res = await getWorkerClient().commitModel(modelId);
    if (res.committed) {
      const promoted = stagedBatchesByModelId.get(modelId);
      if (promoted) {
        committedBatchPaths = promoted;
      }
      stagedBatchesByModelId.delete(modelId);
    }
    return res;
  });

  ipcMain.handle('worker:discard-model', async (_event, modelId: string) => {
    if (typeof modelId !== 'string' || !modelId) {
      return { discarded: false };
    }
    const res = await getWorkerClient().discardModel(modelId);
    if (res.discarded) {
      stagedBatchesByModelId.delete(modelId);
    }
    return res;
  });

  ipcMain.handle('worker:cancel-import', async () => {
    if (!activeImportJobId) {
      return { canceled: false };
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

  ipcMain.handle('worker:cancel-fill', async (_event, jobId: string) => {
    if (!activeFillJobs.has(jobId)) return { canceled: false };
    return getWorkerClient().cancelImport(jobId);
  });

  ipcMain.handle('worker:light-exposure', async (_event, request: ExposureRequest) => {
    if (!request || typeof request.modelId !== 'string' ||
      typeof request.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.jobId) ||
      !Array.isArray(request.direction) || request.direction.length !== 3 ||
      !request.direction.every(Number.isFinite) || activeLightingJobs.has(request.jobId)) {
      throw new Error('Invalid lighting request.');
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
  if (workerClient) {
    void workerClient.dispose();
    workerClient = null;
  }
});
