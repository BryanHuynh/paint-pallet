import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { WorkerClient, readBatchBinary } from './workerClient';
import type { ModelSummary, Vec3 } from '../shared/workerProtocol';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let workerClient: WorkerClient | null = null;
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1f10',
    title: 'Paint Pallet',
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
      title: 'Open Binary STL',
      properties: ['openFile'],
      filters: [{ name: 'STL Meshes', extensions: ['stl'] }],
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
      path.extname(filePath).toLowerCase() !== '.stl'
    ) {
      throw new Error('Drop an STL file from your computer.');
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
