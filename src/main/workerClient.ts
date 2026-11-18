import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  BatchBinaryData,
  ImportProgressEvent,
  ModelSummary,
  PickResult,
  Vec3,
} from '../shared/workerProtocol';

export interface WorkerClientOptions {
  workerPath?: string;
  cacheDir?: string;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

const BATCH_MAGIC = 0x31425050; // 'PPB1'

export function resolveDefaultWorkerPath(): string {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'paint_pallet_worker.exe');
    if (fs.existsSync(packaged)) {
      return packaged;
    }
  }
  return path.resolve(process.cwd(), 'native/build/paint_pallet_worker.exe');
}

export async function readBatchBinary(filePath: string): Promise<BatchBinaryData> {
  const buf = await fs.promises.readFile(filePath);
  if (buf.byteLength < 16) {
    throw new Error(`Batch file too small: ${filePath}`);
  }
  const magic = buf.readUInt32LE(0);
  if (magic !== BATCH_MAGIC) {
    throw new Error(`Invalid batch magic in ${filePath}: 0x${magic.toString(16)}`);
  }
  const triangleCount = buf.readUInt32LE(8);
  const posBytes = triangleCount * 9 * 4;
  const normBytes = triangleCount * 9 * 4;
  const idBytes = triangleCount * 4;
  const expected = 16 + posBytes + normBytes + idBytes;
  if (buf.byteLength !== expected) {
    throw new Error(`Batch size mismatch in ${filePath}: expected ${expected}, got ${buf.byteLength}`);
  }

  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const positions = new Float32Array(ab, 16, triangleCount * 9);
  const normals = new Float32Array(ab, 16 + posBytes, triangleCount * 9);
  const faceIds = new Uint32Array(ab, 16 + posBytes + normBytes, triangleCount);

  return { triangleCount, positions, normals, faceIds };
}

export class WorkerClient {
  private readonly workerPath: string;
  private readonly cacheDir: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private reqCounter = 0;
  private pending = new Map<string, PendingRequest<unknown>>();
  private progressListeners = new Set<(event: ImportProgressEvent) => void>();

  constructor(options: WorkerClientOptions = {}) {
    this.workerPath = options.workerPath ?? resolveDefaultWorkerPath();
    this.cacheDir = options.cacheDir ?? path.join(os.tmpdir(), 'paint-pallet-cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) {
      return this.proc;
    }
    if (!fs.existsSync(this.workerPath)) {
      throw new Error(`Native worker executable not found at: ${this.workerPath}`);
    }

    const proc = spawn(this.workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === 'progress') {
        const evt = msg as unknown as ImportProgressEvent;
        for (const listener of this.progressListeners) {
          listener(evt);
        }
        return;
      }

      const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
      const entry = this.pending.get(reqId);
      if (!entry) return;
      this.pending.delete(reqId);

      if (msg.type === 'import_complete') {
        entry.resolve(msg.model as ModelSummary);
      } else if (msg.type === 'import_error') {
        entry.reject(new Error(String(msg.error ?? 'Import failed')));
      } else if (msg.type === 'import_canceled') {
        const err = new Error('Import canceled');
        err.name = 'ImportCanceledError';
        entry.reject(err);
      } else if (msg.type === 'cancel_ack') {
        entry.resolve({ canceled: Boolean(msg.canceled) });
      } else if (msg.type === 'pick_result') {
        entry.resolve({
          hit: Boolean(msg.hit),
          partId: (msg.partId as string | null) ?? null,
          originalFaceId: typeof msg.originalFaceId === 'number' ? msg.originalFaceId : null,
          distance: typeof msg.distance === 'number' ? msg.distance : null,
          point: (msg.point as Vec3 | null) ?? null,
          normal: (msg.normal as Vec3 | null) ?? null,
        } satisfies PickResult);
      } else if (msg.type === 'active_model') {
        entry.resolve((msg.model as ModelSummary | null) ?? null);
      }
    });

    proc.on('exit', (code) => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`Native worker exited unexpectedly with code ${code ?? 'null'}`));
      }
      this.pending.clear();
      this.proc = null;
      this.rl = null;
    });

    this.proc = proc;
    this.rl = rl;
    return proc;
  }

  private sendRequest<T>(payload: Record<string, unknown>): Promise<T> {
    const proc = this.ensureStarted();
    const reqId = `req_${++this.reqCounter}`;
    const line = JSON.stringify({ ...payload, reqId }) + '\n';
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      proc.stdin.write(line);
    });
  }

  onProgress(listener: (event: ImportProgressEvent) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  async importStl(filePath: string, jobId: string): Promise<ModelSummary> {
    return this.sendRequest<ModelSummary>({
      cmd: 'import',
      jobId,
      filePath,
      cacheDir: this.cacheDir,
    });
  }

  async cancelImport(jobId: string): Promise<{ canceled: boolean }> {
    return this.sendRequest<{ canceled: boolean }>({
      cmd: 'cancel',
      jobId,
    });
  }

  async getActiveModel(): Promise<ModelSummary | null> {
    return this.sendRequest<ModelSummary | null>({
      cmd: 'get_active_model',
    });
  }

  async pickFace(modelId: string, origin: Vec3, direction: Vec3): Promise<PickResult> {
    return this.sendRequest<PickResult>({
      cmd: 'pick',
      modelId,
      origin,
      direction,
    });
  }

  async dispose(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.rl?.close();
    this.rl = null;
    try {
      proc.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
      proc.stdin.end();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        resolve();
      }, 1500);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
