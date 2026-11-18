export type Vec3 = [number, number, number];

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export interface BatchDescriptor {
  batchIndex: number;
  filePath: string;
  triangleCount: number;
  bounds: Bounds3;
}

export interface ModelSummary {
  modelId: string;
  partId: string;
  fileName: string;
  fileSizeBytes: number;
  triangleCount: number;
  bounds: Bounds3;
  batches: BatchDescriptor[];
  previewFilePath: string | null;
}

export interface ImportProgressEvent {
  type: 'progress';
  jobId: string;
  phase: 'reading' | 'batching' | 'finalizing' | 'indexing';
  bytesRead: number;
  totalBytes: number;
  trianglesRead: number;
  totalTriangles: number;
}

export interface PickResult {
  hit: boolean;
  partId: string | null;
  originalFaceId: number | null;
  batchIndex?: number;
  triangleIndex?: number;
  distance: number | null;
  point: Vec3 | null;
  normal: Vec3 | null;
}

export type AxisDirection = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface ModelOrientation {
  upright: AxisDirection;
  front: AxisDirection;
}

export interface BatchBinaryData {
  triangleCount: number;
  positions: Float32Array;
  normals: Float32Array;
  faceIds: Uint32Array;
}

export interface ConnectedFillRequest {
  modelId: string;
  jobId: string;
  faceId: number;
  maxCreaseDegrees: number;
  blockedFaces: number[];
}

export interface PaintPalletApi {
  selectStlFile: () => Promise<string | null>;
  importDroppedStl?: (file: File) => Promise<ModelSummary>;
  importStl: (filePath: string) => Promise<ModelSummary>;
  commitModel?: (modelId: string) => Promise<{ committed: boolean }>;
  discardModel?: (modelId: string) => Promise<{ discarded: boolean }>;
  cancelImport: () => Promise<{ canceled: boolean }>;
  getActiveModel: () => Promise<ModelSummary | null>;
  readBatch: (filePath: string) => Promise<BatchBinaryData>;
  pickFace: (
    modelId: string,
    origin: Vec3,
    direction: Vec3,
    batchIndices?: number[],
  ) => Promise<PickResult>;
  previewConnectedFill?: (request: ConnectedFillRequest) => Promise<Uint32Array>;
  cancelConnectedFill?: (jobId: string) => Promise<{ canceled: boolean }>;
  onImportProgress: (listener: (event: ImportProgressEvent) => void) => () => void;
}
