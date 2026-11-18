import { Box3, Matrix4, Vector3 } from 'three';
import type { KitPart } from '../../shared/kit';
import type { Bounds3, PaintPalletApi, Vec3 } from '../../shared/workerProtocol';
import { poseMatrix } from './jointMath';
import type { NearbyFit, SnapInput } from './nearbyFit';

interface Candidate extends NearbyFit { parentId: string }

function asBox(bounds: Bounds3) {
  return new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max));
}

async function sampleOriginal(
  part: KitPart, matrix: Matrix4, site: Box3, readBatch: PaintPalletApi['readBatch'],
  limit: number, worldOutput: boolean, signal: AbortSignal,
) {
  const sampled = new Float32Array(limit * 9);
  const vertices = [new Vector3(), new Vector3(), new Vector3()];
  const box = new Box3();
  let seen = 0;
  let random = 0x2a73e5;
  for (const batch of part.model.batches) {
    signal.throwIfAborted();
    if (!asBox(batch.bounds).applyMatrix4(matrix).intersectsBox(site)) continue;
    const { positions } = await readBatch(batch.filePath);
    signal.throwIfAborted();
    for (let i = 0; i < positions.length; i += 9) {
      box.makeEmpty();
      for (let vertex = 0; vertex < 3; vertex++) {
        box.expandByPoint(vertices[vertex].fromArray(positions, i + vertex * 3).applyMatrix4(matrix));
      }
      if (!box.intersectsBox(site)) continue;
      seen++;
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const slot = seen <= limit ? seen - 1 : Math.floor(random / 0x1_0000_0000 * seen);
      if (slot >= limit) continue;
      if (worldOutput) {
        vertices.forEach((vertex, corner) => vertex.toArray(sampled, slot * 9 + corner * 3));
      } else {
        for (let value = 0; value < 9; value++) sampled[slot * 9 + value] = positions[i + value];
      }
    }
  }
  return sampled.slice(0, Math.min(seen, limit) * 9);
}

function runFit(input: SnapInput, signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./nearby.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<NearbyFit | null>((resolve, reject) => {
    const finish = () => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { finish(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<NearbyFit | null>) => { finish(); resolve(event.data); };
    worker.onerror = (event) => { finish(); reject(new Error(event.message || 'Nearby geometry search failed.')); };
    worker.postMessage(input, [input.child.buffer, input.parent.buffer] as Transferable[]);
  });
}

export function selectNearbyCandidate(candidates: Candidate[]) {
  const [best, other] = candidates.slice().sort((a, b) => b.quality - a.quality);
  if (!best) return { kind: 'none' as const };
  if (other && other.quality >= best.quality * 0.88) return { kind: 'ambiguous' as const };
  return { kind: 'fit' as const, best };
}

export async function findNearbyFit(child: KitPart, parents: KitPart[], readBatch: PaintPalletApi['readBatch'], signal: AbortSignal) {
  const extent = asBox(child.model.bounds).getSize(new Vector3());
  const radius = Math.max(extent.x, extent.y, extent.z) * 0.15;
  if (!(radius > 0)) return { kind: 'none' as const };
  const childMatrix = poseMatrix(child.pose);
  const childBounds = asBox(child.model.bounds).applyMatrix4(childMatrix);
  const candidates: Candidate[] = [];
  for (const parent of parents) {
    signal.throwIfAborted();
    const parentMatrix = poseMatrix(parent.pose);
    const parentBounds = asBox(parent.model.bounds).applyMatrix4(parentMatrix);
    if (!childBounds.clone().expandByScalar(radius).intersectsBox(parentBounds)) continue;
    const site = childBounds.clone().expandByScalar(radius).intersect(parentBounds.clone().expandByScalar(radius));
    const [childTriangles, parentTriangles] = await Promise.all([
      sampleOriginal(child, childMatrix, site, readBatch, 2200, false, signal),
      sampleOriginal(parent, parentMatrix, site, readBatch, 8000, true, signal),
    ]);
    if (!childTriangles.length || !parentTriangles.length) continue;
    const fit = await runFit({ child: childTriangles, parent: parentTriangles, current: child.pose, authored: parent.pose, radius }, signal);
    if (!fit) continue;
    const point: Vec3 = new Vector3(...fit.point).applyMatrix4(parentMatrix.invert()).toArray();
    candidates.push({ ...fit, point, parentId: parent.id });
  }
  return selectNearbyCandidate(candidates);
}
