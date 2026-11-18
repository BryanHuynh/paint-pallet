import { contextBridge, ipcRenderer } from 'electron';
import type {
  ImportProgressEvent,
  PaintPalletApi,
  Vec3,
} from '../shared/workerProtocol';

const api: PaintPalletApi = {
  selectStlFile: () => ipcRenderer.invoke('dialog:select-stl'),
  importStl: (filePath: string) =>
    ipcRenderer.invoke('worker:import-stl', filePath),
  commitModel: (modelId: string) =>
    ipcRenderer.invoke('worker:commit-model', modelId),
  discardModel: (modelId: string) =>
    ipcRenderer.invoke('worker:discard-model', modelId),
  cancelImport: () => ipcRenderer.invoke('worker:cancel-import'),
  getActiveModel: () => ipcRenderer.invoke('worker:get-active-model'),
  readBatch: (filePath: string) => ipcRenderer.invoke('worker:read-batch', filePath),
  pickFace: (modelId: string, origin: Vec3, direction: Vec3, batchIndices?: number[]) =>
    ipcRenderer.invoke('worker:pick-face', modelId, origin, direction, batchIndices),
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
