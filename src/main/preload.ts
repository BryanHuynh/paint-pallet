import type { ProjectSaveRequest } from '../shared/paintProject';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ConnectedFillRequest,
  ExposureRequest,
  ImportProgressEvent,
  PaintPalletApi,
  Vec3,
} from '../shared/workerProtocol';

const api: PaintPalletApi = {
  selectStlFile: () => ipcRenderer.invoke('dialog:select-stl'),
  importDroppedStl: async (file: File) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) throw new Error('Drop an STL or OBJ file from your computer.');
    return ipcRenderer.invoke('worker:import-dropped-stl', filePath);
  },
  importStl: (filePath: string) =>
    ipcRenderer.invoke('worker:import-stl', filePath),
  importPracticeModel: () => ipcRenderer.invoke('worker:import-practice-model'),
  commitModel: (modelId: string) =>
    ipcRenderer.invoke('worker:commit-model', modelId),
  discardModel: (modelId: string) =>
    ipcRenderer.invoke('worker:discard-model', modelId),
  importKitParts: () => ipcRenderer.invoke('kit:import-parts'),
  cancelImport: () => ipcRenderer.invoke('worker:cancel-import'),
  getActiveModel: () => ipcRenderer.invoke('worker:get-active-model'),
  readBatch: (filePath: string) => ipcRenderer.invoke('worker:read-batch', filePath),
  pickFace: (modelId: string, origin: Vec3, direction: Vec3, batchIndices?: number[]) =>
    ipcRenderer.invoke('worker:pick-face', modelId, origin, direction, batchIndices),
  previewConnectedFill: (request: ConnectedFillRequest) => ipcRenderer.invoke('worker:connected-fill', request),
  previewRidgeBand: (request) => ipcRenderer.invoke('worker:ridge-band', request),
  cancelConnectedFill: (jobId: string) => ipcRenderer.invoke('worker:cancel-fill', jobId),
  computeLightExposure: (request: ExposureRequest) => ipcRenderer.invoke('worker:light-exposure', request),
  cancelLightExposure: (jobId: string) => ipcRenderer.invoke('worker:cancel-light', jobId),
  generateVisionRecipes: (request) => ipcRenderer.invoke('palette:generate-vision-recipes', request),
  saveProject: (request: ProjectSaveRequest) => ipcRenderer.invoke('project:save', request),
  exportPaintingGuide: (guide) => ipcRenderer.invoke('guide:export', guide),
  openProject: (recentPath) => ipcRenderer.invoke('project:open', recentPath),
  listRecentProjects: () => ipcRenderer.invoke('project:recents'),
  confirmProjectReplacement: () => ipcRenderer.invoke('project:confirm-replacement'),
  openDroppedProject: (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) return Promise.reject(new Error('Drop a Paint Pallet project from your computer.'));
    return ipcRenderer.invoke('project:open-dropped', filePath);
  },
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
