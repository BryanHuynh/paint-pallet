import { Matrix4, Quaternion, Vector3 } from 'three';
import type { KitJoint, KitPart, PartPose } from '../../shared/kit';
import type { Vec3 } from '../../shared/workerProtocol';

export interface PlanePick {
  point: Vec3;
  normal: Vec3;
}

type ThreePlanes = readonly [PlanePick, PlanePick, PlanePick];

const unitScale = new Vector3(1, 1, 1);

export function poseMatrix(pose: PartPose) {
  return new Matrix4().compose(new Vector3(...pose.translation), new Quaternion(...pose.rotation), unitScale);
}

export function matrixPose(matrix: Matrix4): PartPose {
  const position = new Vector3();
  const rotation = new Quaternion();
  matrix.decompose(position, rotation, new Vector3());
  return { translation: position.toArray(), rotation: rotation.normalize().toArray() };
}

function connectorBasis(a: Vector3, b: Vector3, c: Vector3) {
  const tip = a.clone().normalize();
  const perpendicular = b.clone().addScaledVector(tip, -b.dot(tip));
  const volume = Math.abs(c.dot(tip.clone().cross(b)));
  if (volume < 0.2 || perpendicular.lengthSq() < 0.08) {
    throw new Error('Pick the tip and two adjacent walls with distinct facing directions.');
  }
  const side = perpendicular.normalize();
  return new Matrix4().makeBasis(tip, side, new Vector3().crossVectors(tip, side));
}

export function fitSixFaces(peg: ThreePlanes, socket: ThreePlanes, parentPose: PartPose, adjustment: Vec3 = [0, 0, 0]) {
  const pegNormals = peg.map(({ normal }) => new Vector3(...normal).normalize());
  const socketNormals = socket.map(({ normal }) => new Vector3(...normal).normalize());
  const align = connectorBasis(...[0, 1, 2].map((i) => socketNormals[i].clone().negate()) as [Vector3, Vector3, Vector3])
    .multiply(connectorBasis(pegNormals[0], pegNormals[1], pegNormals[2]).invert());
  if (pegNormals.some((normal, i) => normal.clone().transformDirection(align).dot(socketNormals[i]) > -0.95)) {
    throw new Error('The face directions do not match. Check wall order and select opposing mating surfaces.');
  }

  const system = new Matrix4().makeBasis(socketNormals[0], socketNormals[1], socketNormals[2]).transpose();
  const target = new Vector3(...socket.map(({ point }, i) => {
    const n = socketNormals[i];
    return n.dot(new Vector3(...point)) - n.dot(new Vector3(...peg[i].point).applyMatrix4(align)) + adjustment[i];
  }) as Vec3);
  align.setPosition(target.applyMatrix4(system.clone().invert()));
  const intersection = new Vector3(...socket.map(({ point }, i) => socketNormals[i].dot(new Vector3(...point))) as Vec3)
    .applyMatrix4(system.invert()).toArray();
  return { pose: matrixPose(poseMatrix(parentPose).multiply(align)), point: intersection };
}

export function moveKitPart(parts: KitPart[], joints: KitJoint[], partId: string, pose: PartPose) {
  const current = parts.find((part) => part.id === partId);
  if (!current || partId === parts[0]?.id) return parts;
  const delta = poseMatrix(pose).multiply(poseMatrix(current.pose).invert());
  const moved = new Set([partId]);
  const queue = [partId];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const joint of joints) {
      if (joint.parentId !== queue[cursor] || moved.has(joint.childId)) continue;
      moved.add(joint.childId);
      queue.push(joint.childId);
    }
  }
  return parts.map((part) => moved.has(part.id)
    ? { ...part, pose: part.id === partId ? pose : matrixPose(delta.clone().multiply(poseMatrix(part.pose))) }
    : part);
}

export function canAttach(parts: KitPart[], joints: KitJoint[], childId: string, parentId: string): boolean {
  if (!parts.find((part) => part.id === childId) || childId === parts[0]?.id) return false;
  if (!parts.find((part) => part.id === parentId && !part.staged)) return false;
  const ancestors = new Set<string>();
  let current: string | undefined = parentId;
  while (current) {
    if (current === childId || ancestors.has(current)) return false;
    ancestors.add(current);
    current = joints.find((joint) => joint.childId === current)?.parentId;
  }
  return true;
}
