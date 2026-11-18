import * as THREE from 'three';
import type { AxisDirection } from '../shared/workerProtocol';

export const ALL_AXES: AxisDirection[] = ['+Y', '-Y', '+Z', '-Z', '+X', '-X'];

export function axisToVector(axis: AxisDirection): THREE.Vector3 {
  switch (axis) {
    case '+X':
      return new THREE.Vector3(1, 0, 0);
    case '-X':
      return new THREE.Vector3(-1, 0, 0);
    case '+Y':
      return new THREE.Vector3(0, 1, 0);
    case '-Y':
      return new THREE.Vector3(0, -1, 0);
    case '+Z':
      return new THREE.Vector3(0, 0, 1);
    case '-Z':
      return new THREE.Vector3(0, 0, -1);
  }
}

export function getOrthogonalFrontOptions(upright: AxisDirection): AxisDirection[] {
  const upVec = axisToVector(upright);
  return ALL_AXES.filter((axis) => Math.abs(axisToVector(axis).dot(upVec)) < 0.1);
}

/**
 * Computes a rotation quaternion that maps the model's local `upright` axis to world +Y
 * and its local `front` axis to world +Z.
 */
export function computeOrientationQuaternion(
  upright: AxisDirection,
  front: AxisDirection,
): THREE.Quaternion {
  const localUp = axisToVector(upright).normalize();
  let localFront = axisToVector(front).normalize();
  if (Math.abs(localUp.dot(localFront)) > 0.9) {
    localFront = axisToVector(getOrthogonalFrontOptions(upright)[0]).normalize();
  }
  const localRight = new THREE.Vector3().crossVectors(localUp, localFront).normalize();
  const orthoFront = new THREE.Vector3().crossVectors(localRight, localUp).normalize();

  // Basis matrix whose columns are (localRight, localUp, orthoFront) in model space
  // maps world (X, Y, Z) -> model; its transpose maps model -> world (X, Y, Z).
  const modelToWorld = new THREE.Matrix4().makeBasis(localRight, localUp, orthoFront).transpose();
  return new THREE.Quaternion().setFromRotationMatrix(modelToWorld);
}
