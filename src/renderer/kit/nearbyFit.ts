import { Box3, Matrix4, Quaternion, Triangle, Vector3 } from 'three';
import type { PartPose } from '../../shared/kit';
import type { Vec3 } from '../../shared/workerProtocol';
import { matrixPose, poseMatrix } from './jointMath';

interface Sample { point: Vector3; normal: Vector3 }
interface Contact { hit: Vector3; normal: Vector3; distance: number }
export interface SnapInput {
  child: Float32Array;
  parent: Float32Array;
  current: PartPose;
  authored: PartPose;
  radius: number;
}
export interface NearbyFit { pose: PartPose; point: Vec3; quality: number; support: number }

class SurfaceGrid {
  private cells = new Map<string, number[]>();
  private surfaces: { face: Triangle; normal: Vector3 }[] = [];
  private origin: Vector3;
  constructor(positions: Float32Array, private size: number) {
    const vertex = new Vector3();
    const box = new Box3();
    for (let i = 0; i < positions.length; i += 3) box.expandByPoint(vertex.fromArray(positions, i));
    this.origin = box.min;
    const extent = box.getSize(new Vector3());
    this.size = Math.max(this.size, Math.max(extent.x, extent.y, extent.z) / 64);
    for (let i = 0; i < positions.length; i += 9) {
      const face = new Triangle(new Vector3().fromArray(positions, i),
        new Vector3().fromArray(positions, i + 3), new Vector3().fromArray(positions, i + 6));
      const normal = face.getNormal(new Vector3());
      if (normal.lengthSq() < 0.9) continue;
      const bounds = new Box3().setFromPoints([face.a, face.b, face.c]);
      const min = this.cell(bounds.min);
      const max = this.cell(bounds.max);
      const index = this.surfaces.push({ face, normal }) - 1;
      // A coarse grid index is sufficient even for low-poly triangles spanning many cells.
      for (let x = min[0]; x <= max[0]; x++) {
        for (let y = min[1]; y <= max[1]; y++) {
          for (let z = min[2]; z <= max[2]; z++) {
            const key = x + ',' + y + ',' + z;
            const list = this.cells.get(key);
            if (list) list.push(index);
            else this.cells.set(key, [index]);
          }
        }
      }
    }
  }
  private cell(point: Vector3) {
    return [Math.floor((point.x - this.origin.x) / this.size),
      Math.floor((point.y - this.origin.y) / this.size), Math.floor((point.z - this.origin.z) / this.size)];
  }
  closest(point: Vector3, normal: Vector3, maxDistance: number) {
    const [cx, cy, cz] = this.cell(point);
    let facingDistance = maxDistance * maxDistance;
    let nearestDistance = facingDistance;
    let facing: Contact | undefined;
    let nearest: Contact | undefined;
    const visited = new Set<number>();
    const match = new Vector3();
    const range = Math.ceil(maxDistance / this.size);
    for (let x = cx - range; x <= cx + range; x++) {
      for (let y = cy - range; y <= cy + range; y++) {
        for (let z = cz - range; z <= cz + range; z++) {
          const candidates = this.cells.get(x + ',' + y + ',' + z);
          if (!candidates) continue;
          for (const index of candidates) {
            if (visited.has(index)) continue;
            visited.add(index);
            const surface = this.surfaces[index];
            surface.face.closestPointToPoint(point, match);
            const distance = point.distanceToSquared(match);
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearest = { hit: match.clone(), normal: surface.normal, distance: Math.sqrt(distance) };
            }
            if (distance < facingDistance && normal.dot(surface.normal) < -0.65) {
              facingDistance = distance;
              facing = { hit: match.clone(), normal: surface.normal, distance: Math.sqrt(distance) };
            }
          }
        }
      }
    }
    return { facing, nearest };
  }
}

function childSamples(positions: Float32Array) {
  const sites: Sample[] = [];
  const perFace = positions.length < 3000 ? 3 : 1;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < positions.length; i += 9) {
    const face = new Triangle(a.fromArray(positions, i), b.fromArray(positions, i + 3), c.fromArray(positions, i + 6));
    const normal = face.getNormal(new Vector3());
    if (normal.lengthSq() < 0.9) continue;
    if (perFace === 3) {
      for (const vertex of [a, b, c]) {
        sites.push({ point: face.getMidpoint(new Vector3()).lerp(vertex, 0.5), normal });
      }
    } else {
      sites.push({ point: face.getMidpoint(new Vector3()), normal });
    }
  }
  return sites;
}

function solveLinear(system: number[][], tolerance: number) {
  const data = system.map((row) => [...row]);
  for (let column = 0; column < data.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < data.length; row++) {
      if (Math.abs(data[row][column]) > Math.abs(data[pivot][column])) pivot = row;
    }
    if (Math.abs(data[pivot][column]) < tolerance) return null;
    [data[column], data[pivot]] = [data[pivot], data[column]];
    const divisor = data[column][column];
    for (let j = column; j <= data.length; j++) data[column][j] /= divisor;
    for (let row = 0; row < data.length; row++) {
      if (row === column) continue;
      const scale = data[row][column];
      for (let j = column; j <= data.length; j++) data[row][j] -= scale * data[column][j];
    }
  }
  return data.map((row) => row.at(-1)!);
}

export function solveNearbyFit({ child, parent, current, authored, radius }: SnapInput): NearbyFit | null {
  if (!child.length || !parent.length) return null;
  const samples = childSamples(child);
  if (samples.length < 6) return null;
  const origin = samples.reduce((sum, sample) => sum.add(sample.point), new Vector3()).multiplyScalar(1 / samples.length);
  const grid = new SurfaceGrid(parent, Math.max(radius * 0.6, 1e-8));
  const original = poseMatrix(current);
  const tolerance = radius * 0.18;
  const minimumContacts = Math.ceil(Math.max(6, samples.length * 0.065));
  const evaluate = (transform: Matrix4, search: number, refine: boolean) => {
    const center = origin.clone().applyMatrix4(transform);
    const system = Array.from({ length: 6 }, () => Array<number>(7).fill(0));
    const joint = new Vector3();
    let count = 0, penetrating = 0, error = 0;
    const offset = new Vector3(), transformed = new Vector3(), normal = new Vector3();
    for (const sample of samples) {
      transformed.copy(sample.point).applyMatrix4(transform);
      normal.copy(sample.normal).transformDirection(transform);
      const { facing, nearest } = grid.closest(transformed, normal, Math.max(search, tolerance * 3));
      if (nearest && offset.copy(transformed).sub(nearest.hit).dot(nearest.normal) < -tolerance) penetrating++;
      if (!facing || facing.distance > search) continue;
      count++;
      joint.add(facing.hit);
      error += facing.distance;
      const plane = facing.normal;
      const residual = offset.copy(facing.hit).sub(transformed).dot(plane) / radius;
      const torque = offset.copy(transformed).sub(center).multiplyScalar(1 / radius).cross(plane);
      const row = [torque.x, torque.y, torque.z, plane.x, plane.y, plane.z];
      for (let i = 0; i < row.length; i++) {
        for (let j = 0; j < row.length; j++) system[i][j] += row[i] * row[j];
        system[i][6] += row[i] * residual;
      }
    }

    if (refine) {
      // Damping stabilizes tentative fits before contacts fully constrain all degrees of freedom.
      for (let i = 0; i < 6; i++) system[i][i] += 0.02 * Math.max(1, count);
      return { update: count >= 6 ? solveLinear(system, 1e-8) : null, center, score: 0, count, joint };
    }
    const determinate = count >= minimumContacts && solveLinear(system, count * 0.00005) !== null;
    const safe = penetrating <= Math.max(2, Math.min(samples.length * 0.05, count * 0.18));
    const score = determinate && safe ? count / samples.length * (1 - (error / count) / search * 0.65) : 0;
    return { update: null, center, score, count, joint };
  };

  const valid: NearbyFit[] = [];
  function consider(matrix: Matrix4) {
    const { score, count, joint, center } = evaluate(matrix, tolerance, false);
    if (!score || center.distanceTo(origin.clone().applyMatrix4(original)) > radius * 1.2) return;
    const pose = matrixPose(matrix);
    if (Math.abs(new Quaternion(...pose.rotation).dot(new Quaternion(...current.rotation))) < 0.97) return;
    const fit = { pose, point: joint.multiplyScalar(1 / count).toArray(), quality: score, support: count };
    const equivalent = valid.findIndex((other) => new Vector3(...pose.translation).distanceTo(new Vector3(...other.pose.translation)) < tolerance &&
      Math.abs(new Quaternion(...pose.rotation).dot(new Quaternion(...other.pose.rotation))) > 0.998);
    if (equivalent < 0) valid.push(fit);
    else if (valid[equivalent].quality < score) valid[equivalent] = fit;
  }

  for (const start of [original, poseMatrix(authored)]) {
    const estimate = start.clone();
    consider(estimate);
    for (let iteration = 0; iteration < 8; iteration++) {
      const { update, center } = evaluate(estimate, iteration < 3 ? radius : radius * 0.6, true);
      if (!update) break;
      const spin = new Vector3(update[0], update[1], update[2]);
      const angle = Math.min(0.13, spin.length());
      spin.normalize();
      const translation = new Vector3(update[3], update[4], update[5]).multiplyScalar(radius).clampLength(0, radius * 0.35);
      if (angle < 0.0002 && translation.length() < radius * 0.0005) break;
      const rotation = new Matrix4().makeRotationAxis(spin, angle);
      const delta = rotation.setPosition(center.clone().sub(center.clone().applyMatrix4(rotation)).add(translation));
      estimate.premultiply(delta);
      consider(estimate);
    }
  }

  valid.sort((a, b) => b.quality - a.quality);
  const first = valid[0], second = valid[1];
  return first && (!second || second.quality < first.quality * 0.88) ? first : null;
}
