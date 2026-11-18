import { contextBridge, ipcRenderer } from 'electron';
import type {
  ImportProgressEvent,
  PaintPalletApi,
  Vec3,
} from '../shared/workerProtocol';

const api: PaintPalletApi = {
  selectStlFile: () => ipcRenderer.invoke('dialog:select-stl'),
  importStl: (filePath: string, jobId: string) =>
    ipcRenderer.invoke('worker:import-stl', filePath, jobId),
  cancelImport: (jobId: string) => ipcRenderer.invoke('worker:cancel-import', jobId),
  getActiveModel: () => ipcRenderer.invoke('worker:get-active-model'),
  readBatch: (filePath: string) => ipcRenderer.invoke('worker:read-batch', filePath),
  pickFace: (modelId: string, origin: Vec3, direction: Vec3) =>
    ipcRenderer.invoke('worker:pick-face', modelId, origin, direction),
  onImportProgress: (listener: (event: ImportProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ImportProgressEvent) => {
      listener(payload);
    };
    ipcRenderer.on('worker:import-progress', handler);
    return () => {
      ipcRenderer.removeListener('worker:import-progress', handler);
    };
  },
};

contextBridge.exposeInMainWorld('paintPallet', api);
