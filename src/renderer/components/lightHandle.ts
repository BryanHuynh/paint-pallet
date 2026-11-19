import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../../shared/workerProtocol';

export function dragLightDirection(
  direction: Vec3, cameraRotation: Quaternion, deltaX: number, deltaY: number, viewportHeight: number,
): Vec3 {
  const fromLight = new Vector3(...direction);
  const distance = Math.hypot(deltaX, deltaY);
  if (!distance) return direction;

  // Reverse the rotation on the far hemisphere so the ball still follows the pointer.
  const towardCamera = new Vector3(0, 0, 1).applyQuaternion(cameraRotation);
  const side = fromLight.dot(towardCamera) < -1e-6 ? -1 : 1;
  const axis = new Vector3(deltaY, deltaX, 0).divideScalar(distance).applyQuaternion(cameraRotation);
  const radians = side * distance * Math.PI / Math.max(180, viewportHeight);
  return fromLight.applyAxisAngle(axis, radians).toArray();
}
