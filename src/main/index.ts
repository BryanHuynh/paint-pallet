import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { WorkerClient, readBatchBinary } from './workerClient';
import type { Vec3 } from '../shared/workerProtocol';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let workerClient: WorkerClient | null = null;

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
    return result.filePaths[0];
  });

  ipcMain.handle('worker:import-stl', async (_event, filePath: string, jobId: string) => {
    return getWorkerClient().importStl(filePath, jobId);
  });

  ipcMain.handle('worker:cancel-import', async (_event, jobId: string) => {
    return getWorkerClient().cancelImport(jobId);
  });

  ipcMain.handle('worker:get-active-model', async () => {
    return getWorkerClient().getActiveModel();
  });

  ipcMain.handle('worker:read-batch', async (_event, filePath: string) => {
    return readBatchBinary(filePath);
  });

  ipcMain.handle(
    'worker:pick-face',
    async (_event, modelId: string, origin: Vec3, direction: Vec3) => {
      return getWorkerClient().pickFace(modelId, origin, direction);
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
