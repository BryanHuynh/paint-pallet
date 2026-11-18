import { DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3, type BufferGeometry } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { BatchBinaryData, ModelSummary, PaintPalletApi, PickResult } from '../shared/workerProtocol';

export const BROWSER_STL_LIMIT_MIB = 32;
const HEADER_BYTES = 84;
const TRIANGLE_BYTES = 50;

interface BrowserModel {
  summary: ModelSummary;
  batch: BatchBinaryData;
  geometry: BufferGeometry;
}

const MISS: PickResult = {
  hit: false,
  partId: null,
  originalFaceId: null,
  distance: null,
  point: null,
  normal: null,
};

function readStl(reader: FileReader, file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onabort = () => reject(new Error('Import canceled.'));
    reader.readAsArrayBuffer(file);
  });
}

function parseStl(file: File, modelId: string, data: ArrayBuffer): BrowserModel {
  const triangleCount = data.byteLength >= HEADER_BYTES
    ? new DataView(data).getUint32(80, true)
    : 0;
  if (!triangleCount || HEADER_BYTES + triangleCount * TRIANGLE_BYTES !== data.byteLength) {
    throw new Error('Choose a valid binary STL file with at least one triangle.');
  }

  const geometry = new STLLoader().parse(data);
  const positions = geometry.getAttribute('position').array as Float32Array;
  if (!positions.every(Number.isFinite)) {
    geometry.dispose();
    throw new Error('The STL contains invalid vertex coordinates.');
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const bounds = { min: box.min.toArray(), max: box.max.toArray() };

  return {
    geometry,
    batch: {
      triangleCount,
      positions,
      normals: geometry.getAttribute('normal').array as Float32Array,
      faceIds: Uint32Array.from({ length: triangleCount }, (_, index) => index),
    },
    summary: {
      modelId,
      partId: 'part_0',
      fileName: file.name,
      fileSizeBytes: file.size,
      triangleCount,
      bounds,
      batches: [{ batchIndex: 0, filePath: modelId, triangleCount, bounds }],
      previewFilePath: null,
    },
  };
}

function chooseFile(): Promise<File | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.stl';
  input.hidden = true;
  document.body.append(input);
  return new Promise((resolve, reject) => {
    const finish = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    input.onchange = finish;
    input.oncancel = finish;
    try {
      input.click();
    } catch (error) {
      input.remove();
      reject(error);
    }
  });
}

export function createBrowserStlApi(): PaintPalletApi {
  const material = new MeshBasicMaterial({ side: DoubleSide });
  let nextId = 0;
  let selectedFile: File | null = null;
  let reader: FileReader | null = null;
  let active: BrowserModel | null = null;
  let staged: BrowserModel | null = null;

  async function importFile(file: File): Promise<ModelSummary> {
    if (file.size > BROWSER_STL_LIMIT_MIB * 1024 * 1024) {
      throw new Error(`For STL files larger than ${BROWSER_STL_LIMIT_MIB} MiB, open Paint Pallet in Electron.`);
    }
    if (reader || staged) throw new Error('An STL import is already in progress.');
    const fileReader = new FileReader();
    reader = fileReader;
    try {
      const data = await readStl(fileReader, file);
      staged = parseStl(file, `browser-model-${++nextId}`, data);
      return staged.summary;
    } finally {
      reader = null;
    }
  }

  return {
    async selectStlFile() {
      selectedFile = await chooseFile();
      return selectedFile?.name ?? null;
    },
    async importStl(fileName) {
      const file = selectedFile;
      selectedFile = null;
      if (!file || file.name !== fileName) throw new Error('Choose an STL file first.');
      return importFile(file);
    },
    importDroppedStl: importFile,
    async commitModel(modelId) {
      if (staged?.summary.modelId !== modelId) return { committed: false };
      active?.geometry.dispose();
      active = staged;
      staged = null;
      return { committed: true };
    },
    async discardModel(modelId) {
      if (staged?.summary.modelId !== modelId) return { discarded: false };
      staged.geometry.dispose();
      staged = null;
      return { discarded: true };
    },
    async cancelImport() {
      const canceled = reader?.readyState === FileReader.LOADING;
      if (canceled) reader?.abort();
      return { canceled };
    },
    async getActiveModel() {
      return active?.summary ?? null;
    },
    async readBatch(batchId) {
      const model = staged?.summary.modelId === batchId ? staged : active;
      if (!model || model.summary.modelId !== batchId) throw new Error('Model geometry is unavailable.');
      return model.batch;
    },
    async pickFace(modelId, origin, direction, batchIndices) {
      if (!active || active.summary.modelId !== modelId || (batchIndices && !batchIndices.includes(0))) {
        return MISS;
      }
      const ray = new Raycaster(new Vector3(...origin), new Vector3(...direction).normalize());
      const hit = ray.intersectObject(new Mesh(active.geometry, material))[0];
      if (!hit?.face || hit.faceIndex == null) return MISS;
      return {
        hit: true,
        partId: active.summary.partId,
        originalFaceId: hit.faceIndex,
        distance: hit.distance,
        point: hit.point.toArray(),
        normal: hit.face.normal.toArray(),
      };
    },
    onImportProgress: () => () => {},
  };
}
