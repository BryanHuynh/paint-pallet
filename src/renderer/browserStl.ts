import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { BatchBinaryData, ConnectedFillRequest, ModelSummary, PaintPalletApi, PickResult } from '../shared/workerProtocol';
import { createTextMeshParser, looksLikeAsciiStl, type TextMeshFormat } from '../shared/textMesh';
import type { BrowserFillMessage, BrowserFillResponse } from './browserFill.worker';

export const BROWSER_STL_LIMIT_MIB = 32;
const HEADER_BYTES = 84;
const TRIANGLE_BYTES = 50;

interface BrowserModel {
  summary: ModelSummary;
  batch: BatchBinaryData;
  geometry: BufferGeometry;
  groupIds?: Uint32Array;
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

function readTextGeometry(data: ArrayBuffer, format: TextMeshFormat) {
  const decoder = new TextDecoder();
  const positions: number[] = [];
  const groups: number[] = [];
  const parser = createTextMeshParser(format, (triangle, group) => {
    if (HEADER_BYTES + (positions.length / 9 + 1) * TRIANGLE_BYTES > BROWSER_STL_LIMIT_MIB * 1024 * 1024) {
      throw new Error('The converted mesh is too large for the browser preview. Open it in Electron.');
    }
    for (const vertex of triangle) positions.push(...vertex);
    if (format === 'obj') groups.push(group);
  });
  for (const line of decoder.decode(data).split(/\r?\n/)) parser.push(line);
  parser.finish();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  return { geometry, groupIds: format === 'obj' ? Uint32Array.from(groups) : undefined };
}

function parseModel(file: File, modelId: string, data: ArrayBuffer): BrowserModel {
  let geometry: BufferGeometry;
  let groupIds: Uint32Array | undefined;
  const stlFaces = data.byteLength >= HEADER_BYTES ? new DataView(data).getUint32(80, true) : 0;
  if (/\.obj$/i.test(file.name)) {
    ({ geometry, groupIds } = readTextGeometry(data, 'obj'));
  } else if (stlFaces && HEADER_BYTES + stlFaces * TRIANGLE_BYTES === data.byteLength) {
    geometry = new STLLoader().parse(data);
  } else if (looksLikeAsciiStl(new TextDecoder().decode(data.slice(0, 512)))) {
    ({ geometry } = readTextGeometry(data, 'ascii-stl'));
  } else {
    throw new Error('Choose a valid binary or ASCII STL file with at least one triangle.');
  }

  const positions = geometry.getAttribute('position').array as Float32Array;
  if (!positions.every(Number.isFinite)) {
    geometry.dispose();
    throw new Error('The STL contains invalid vertex coordinates.');
  }
  const triangleCount = positions.length / 9;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const bounds = { min: box.min.toArray(), max: box.max.toArray() };

  return {
    geometry,
    groupIds,
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
  input.accept = '.stl,.obj';
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

  let fillWorker: Worker | null = null;
  const fillRequests = new Map<string, {
    resolve: (faces: Uint32Array) => void;
    reject: (error: Error) => void;
  }>();

  function closeFillWorker(error: Error) {
    fillWorker?.terminate();
    fillWorker = null;
    for (const pending of fillRequests.values()) pending.reject(error);
    fillRequests.clear();
  }

  function prepareFill(request: ConnectedFillRequest): Promise<Uint32Array> {
    if (!active || request.modelId !== active.summary.modelId) {
      return Promise.reject(new Error('The fill model is unavailable.'));
    }
    if (!fillWorker) {
      fillWorker = new Worker(new URL('./browserFill.worker.ts', import.meta.url), { type: 'module' });
      fillWorker.onmessage = ({ data }: MessageEvent<BrowserFillResponse>) => {
        const pending = fillRequests.get(data.jobId);
        if (!pending) return;
        fillRequests.delete(data.jobId);
        if ('faces' in data) pending.resolve(data.faces);
        else pending.reject(new Error(data.error));
      };
      fillWorker.onerror = () => closeFillWorker(new Error('Browser fill worker stopped.'));
      const positions = active.batch.positions.slice();
      const normals = active.batch.normals.slice();
      const groups = active.groupIds?.slice();
      const transfer = groups ? [positions.buffer, normals.buffer, groups.buffer] : [positions.buffer, normals.buffer];
      fillWorker.postMessage({ type: 'mesh', positions, normals, groups } satisfies BrowserFillMessage, transfer);
    }

    return new Promise((resolve, reject) => {
      fillRequests.set(request.jobId, { resolve, reject });
      fillWorker!.postMessage({ type: 'fill', request } satisfies BrowserFillMessage);
    });
  }

  async function importFile(file: File): Promise<ModelSummary> {
    if (file.size > BROWSER_STL_LIMIT_MIB * 1024 * 1024) {
      throw new Error(`For model files larger than ${BROWSER_STL_LIMIT_MIB} MiB, open Paint Pallet in Electron.`);
    }
    if (reader || staged) throw new Error('An STL import is already in progress.');
    const fileReader = new FileReader();
    reader = fileReader;
    try {
      const data = await readStl(fileReader, file);
      staged = parseModel(file, `browser-model-${++nextId}`, data);
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
      if (!file || file.name !== fileName) throw new Error('Choose an STL or OBJ file first.');
      return importFile(file);
    },
    importDroppedStl: importFile,
    async commitModel(modelId) {
      if (staged?.summary.modelId !== modelId) return { committed: false };
      closeFillWorker(new Error('Fill model replaced.'));
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
        batchIndex: 0,
        triangleIndex: hit.faceIndex,
        distance: hit.distance,
        point: hit.point.toArray(),
        normal: hit.face.normal.toArray(),
      };
    },
    previewConnectedFill: prepareFill,
    async cancelConnectedFill(jobId) {
      const pending = fillRequests.get(jobId);
      if (!pending) return { canceled: false };
      fillRequests.delete(jobId);
      pending.reject(new Error('Fill canceled'));
      return { canceled: true };
    },
    onImportProgress: () => () => {},
  };
}
