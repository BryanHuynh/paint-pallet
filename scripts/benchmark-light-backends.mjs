import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-dxr-bench-'));
const binary = path.resolve('native/build/paint_pallet_worker.exe');
const directions = [[0.1, 0.15, 1], [0.56, 0.41, 0.72]];
let sequence = 0;

function worker(cacheDir) {
  const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line);
    if (reply.type === 'progress') return;
    const pending = replies.get(reply.reqId);
    if (!pending) return;
    replies.delete(reply.reqId);
    if (reply.type.endsWith('_error') || reply.type.endsWith('_canceled')) pending.reject(new Error(reply.error ?? reply.type));
    else pending.resolve(reply);
  });
  const ended = new Promise((resolve) => child.on('exit', (code) => {
    for (const request of replies.values()) request.reject(new Error('Worker exited with code ' + code));
    resolve(code);
  }));
  return {
    request(payload) {
      const reqId = 'bench-' + (++sequence);
      return new Promise((resolve, reject) => {
        replies.set(reqId, { resolve, reject });
        child.stdin.write(JSON.stringify({ cacheDir, ...payload, reqId }) + '\n');
      });
    },
    async close() {
      child.stdin.end('{"cmd":"shutdown"}\n');
      await ended;
    },
  };
}

async function makeFixture(file, padding) {
  const faces = [
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    [[0, 0, 100], [1, 0, 100], [0, 1, 100]],
    [[3, 0, 0], [4, 0, 0], [3, 1, 0]],
    [[5, 0, 0], [6, 0, 0], [5, 1, 1]],
  ];
  // For an oblique ray, this second overhang covers the shutter from both light directions.
  faces[1] = [[-1, -1, 3], [2, -1, 3], [-1, 2, 3]];
  if (padding) {
    faces.push([[0, 0, 100], [1, 0, 100], [0, 1, 100]]);
    for (let i = 0; i < 2200; i++) {
      const x = 10 + (i % 50) * 0.1;
      const y = 10 + Math.floor(i / 50) * 0.1;
      faces.push([[x, y, 0], [x + 0.05, y, 0], [x, y + 0.05, 0]]);
    }
  }
  const bytes = Buffer.alloc(84 + 50 * faces.length);
  bytes.writeUInt32LE(faces.length, 80);
  for (const [id, face] of faces.entries()) {
    face.flat().forEach((value, index) => bytes.writeFloatLE(value, 96 + 50 * id + index * 4));
  }
  await fs.writeFile(file, bytes);
  return file;
}

function compare(cpu, gpu) {
  if (cpu.length !== gpu.length) throw new Error('Exposure result size differs');
  let maxError = 0, errors = 0, maskDifferences = 0, visibleDifferences = 0;
  const cutoffDelta = new Int32Array(102);
  const mask = (score) => score >= 0.75 ? 2 : score >= 0.35 ? 1 : 0;
  for (let i = 0; i < cpu.length; i++) {
    if (!Number.isFinite(gpu[i])) throw new Error('DXR returned a nonfinite score');
    const delta = Math.abs(cpu[i] - gpu[i]);
    maxError = Math.max(maxError, delta);
    if (delta > 0.002) errors++;
    if (mask(cpu[i]) !== mask(gpu[i])) maskDifferences++;
    if ((cpu[i] > 0) !== (gpu[i] > 0)) visibleDifferences++;
    const a = Math.floor(cpu[i] * 100), b = Math.floor(gpu[i] * 100);
    if (a !== b) {
      cutoffDelta[Math.min(a, b) + 1]++;
      cutoffDelta[Math.max(a, b) + 1]--;
    }
  }
  let running = 0, worstCutoff = 0, worstCutoffDifferences = 0;
  for (let cutoff = 1; cutoff <= 100; cutoff++) {
    running += cutoffDelta[cutoff];
    if (running > worstCutoffDifferences) {
      worstCutoff = cutoff;
      worstCutoffDifferences = running;
    }
  }
  return { maxError, errors, maskDifferences, visibleDifferences, worstCutoff, worstCutoffDifferences };
}

async function exposure(service, modelId, backend, direction, layout = {}) {
  const start = performance.now();
  const jobId = 'light-' + (++sequence);
  const result = await service.request({ cmd: 'light_exposure', modelId, jobId, direction, exposureBackend: backend, ...layout });
  const bytes = await fs.readFile(result.filePath);
  await fs.unlink(result.filePath);
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const { nativeMs, setupMs, dispatchMs, readbackMs, peakDedicatedBytes, budget, fallback } = result;
  return { values, metrics: { backend: result.backend, nativeMs, totalMs: performance.now() - start,
    setupMs, dispatchMs, readbackMs, peakDedicatedBytes, budget, fallback } };
}

async function benchmark(label, file, simulations) {
  const service = worker(path.join(root, label));
  try {
    const imported = await service.request({ cmd: 'import', filePath: file, jobId: 'import-' + label });
    const { modelId, triangleCount, batches } = imported.model;
    const cpu = [];
    for (const direction of directions) cpu.push(await exposure(service, modelId, 'cpu', direction));
    const comparison = [];
    for (const [index, direction] of directions.entries()) {
      const gpu = await exposure(service, modelId, 'dxr', direction);
      comparison.push({ direction, cpu: cpu[index].metrics, dxr: gpu.metrics, ...compare(cpu[index].values, gpu.values) });
    }
    const fallback = [];
    if (simulations) {
      for (const scenario of ['simulate-unsupported', 'simulate-low-memory', 'simulate-failure']) {
        const result = await exposure(service, modelId, scenario, directions[0]);
        const delta = compare(cpu[0].values, result.values);
        if (result.metrics.backend !== 'cpu' || !result.metrics.fallback || delta.maskDifferences) {
          throw new Error('Expected CPU fallback for ' + scenario);
        }
        fallback.push({ scenario, reason: result.metrics.fallback });
      }
    }
    console.log(JSON.stringify({ label, triangleCount, batches: batches.length, comparison, fallback }));
  } finally {
    await service.close();
  }
}

async function benchmarkAssembly(file) {
  const service = worker(path.join(root, 'kit'));
  try {
    const { model: anchor } = await service.request({ cmd: 'import', filePath: file, jobId: 'kit-anchor' });
    const { model: child } = await service.request({ cmd: 'import', filePath: file, jobId: 'kit-child', staged: true });
    const faceOffset = anchor.triangleCount + 3;
    const direction = [0, 0, 1];
    let previous;
    let foundCrossPartShadow = false;
    for (const x of [3, -8]) {
      const layout = {
        exposureModels: [anchor.modelId, child.modelId].join(','),
        exposurePoses: [0, 0, 0, 0, 0, 0, 0, 1, faceOffset, x, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2],
      };
      const cpu = await exposure(service, anchor.modelId, 'cpu', direction, layout);
      const gpu = await exposure(service, anchor.modelId, 'dxr', direction, layout);
      const delta = compare(cpu.values, gpu.values);
      if (cpu.values.length !== faceOffset + child.triangleCount ||
          gpu.values.subarray(anchor.triangleCount, faceOffset).some((score) => score !== 0) ||
          delta.errors || delta.maskDifferences || delta.visibleDifferences) {
        throw new Error('The posed kit lighting differs between CPU and DXR: ' + JSON.stringify(delta));
      }
      if (previous && previous.every((score, index) => score === cpu.values[index])) {
        throw new Error('The kit pose fixture did not change light exposure');
      }
      previous = cpu.values;
      console.log(JSON.stringify({ label: 'posed kit', x, cpu: cpu.metrics, dxr: gpu.metrics, ...delta }));
      const selfOnly = { ...layout, castShadowsBetweenParts: false };
      const selfCpu = await exposure(service, anchor.modelId, 'cpu', direction, selfOnly);
      const selfGpu = await exposure(service, anchor.modelId, 'dxr', direction, selfOnly);
      const selfDelta = compare(selfCpu.values, selfGpu.values);
      if (selfCpu.values[0] !== 0 || selfGpu.values[0] !== 0 ||
          selfDelta.errors || selfDelta.maskDifferences || selfDelta.visibleDifferences) {
        throw new Error('Self shadows differ between CPU and DXR: ' + JSON.stringify(selfDelta));
      }
      const unshadowed = selfCpu.values.reduce((count, score, index) => count + (score > 0 && cpu.values[index] === 0 ? 1 : 0), 0);
      foundCrossPartShadow ||= unshadowed > 0;
      console.log(JSON.stringify({ label: 'self shadows only', x, unshadowed, dxr: selfGpu.metrics.backend, ...selfDelta }));
    }
    if (!foundCrossPartShadow) throw new Error('The kit fixture did not cast any shadows between parts');
  } finally {
    await service.close();
  }
}

try {
  const overhang = await makeFixture(path.join(root, 'overhang.stl'), false);
  await benchmark('overhang', overhang, true);
  await benchmark('partition', await makeFixture(path.join(root, 'partition.stl'), true), false);
  await benchmarkAssembly(overhang);
  const [reference, nearLimit] = process.argv.slice(2);
  if (reference) await benchmark('reference', reference, false);
  if (nearLimit) await benchmark('near-2-gib', nearLimit, false);
} finally {
  if (/^pp-dxr-bench-[a-zA-Z0-9]+$/.test(path.relative(os.tmpdir(), root))) {
    await fs.rm(root, { recursive: true, force: true });
  }
}
