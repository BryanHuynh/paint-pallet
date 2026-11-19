import * as THREE from 'three';
import { GUIDE_VIEWS, type GuideCallout, type GuideDetail } from '../../shared/paintingGuide';

const views: GuideDetail['view'][] = [...GUIDE_VIEWS, 'Top', 'Bottom'];
export const GUIDE_DIRECTIONS = [
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
];

function forEachTriangle(geometries: THREE.BufferGeometry[], visit: (vertices: THREE.Vector3[]) => void) {
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const geometry of geometries) {
    const positions = geometry.getAttribute('position');
    const index = geometry.getIndex()!;
    for (let i = 0; i < index.count; i += 3) {
      for (let j = 0; j < 3; j++) vertices[j].fromBufferAttribute(positions, index.getX(i + j));
      visit(vertices);
    }
  }
}

export function measureGuideDetail(geometries: THREE.BufferGeometry[]) {
  const bounds = new THREE.Box3();
  const normal = new THREE.Vector3();
  const area = GUIDE_DIRECTIONS.map(() => 0);
  forEachTriangle(geometries, ([a, b, c]) => {
    bounds.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    normal.subVectors(b, a).cross(c.sub(a));
    for (const [i, direction] of GUIDE_DIRECTIONS.entries()) area[i] += Math.abs(normal.dot(direction));
  });
  return { bounds, area };
}

function closestSurfacePoint(geometries: THREE.BufferGeometry[], camera: THREE.Camera, x: number, y: number) {
  const pin = new THREE.Vector3(x * 2 - 1, 1 - y * 2, 0).unproject(camera).applyMatrix4(camera.matrixWorldInverse);
  pin.z = 0;
  const projected = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const barycentric = new THREE.Vector3();
  const edge = new THREE.Vector3(), offset = new THREE.Vector3(), candidate = new THREE.Vector3();
  const best = new THREE.Vector3();
  let bestDistance = Infinity;
  forEachTriangle(geometries, (vertices) => {
    for (let i = 0; i < 3; i++) {
      projected[i].copy(vertices[i]).applyMatrix4(camera.matrixWorldInverse).setZ(0);
    }
    const weights = THREE.Triangle.getBarycoord(pin, projected[0], projected[1], projected[2], barycentric);
    if (weights && weights.x >= 0 && weights.y >= 0 && weights.z >= 0) {
      candidate.set(0, 0, 0).addScaledVector(vertices[0], weights.x).addScaledVector(vertices[1], weights.y)
        .addScaledVector(vertices[2], weights.z);
      if (bestDistance > 0 || candidate.distanceToSquared(camera.position) < best.distanceToSquared(camera.position)) {
        best.copy(candidate);
      }
      bestDistance = 0;
    }
    if (bestDistance === 0) return;
    for (let i = 0; i < 3; i++) {
      const next = (i + 1) % 3;
      edge.subVectors(projected[next], projected[i]);
      const length = edge.lengthSq();
      const t = length ? THREE.MathUtils.clamp(offset.subVectors(pin, projected[i]).dot(edge) / length, 0, 1) : 0;
      const distance = candidate.copy(projected[i]).addScaledVector(edge, t).distanceToSquared(pin);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best.copy(vertices[i]).lerp(vertices[next], t);
    }
  });
  return best;
}

export function frameGuideDetail(geometries: THREE.BufferGeometry[], { bounds, area }: ReturnType<typeof measureGuideDetail>,
  overview: THREE.OrthographicCamera[], callout?: GuideCallout) {
  const requested = callout ? GUIDE_VIEWS.indexOf(callout.view) : -1;
  const largest = area.indexOf(Math.max(...area));
  // A profile view of an edge-on surface produces no readable detail.
  const view = requested >= 0 && area[requested] > area[largest] * 0.01 ? requested : largest;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const direction = GUIDE_DIRECTIONS[view];
  const extent = Math.max(size.x, size.y, size.z, 1e-5);
  const half = 0.65 * Math.max(size.x * (1 - Math.abs(direction.x)), size.y * (1 - Math.abs(direction.y)),
    size.z * (1 - Math.abs(direction.z)), 1e-5);
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, extent * 0.01, extent * 4);
  camera.position.copy(center).addScaledVector(direction, extent * 2);
  if (direction.y) camera.up.set(0, 0, -direction.y);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const marker = (callout && requested >= 0
    ? closestSurfacePoint(geometries, overview[requested], callout.x, callout.y)
    : closestSurfacePoint(geometries, camera, 0.5, 0.5)).project(camera);
  return { view: views[view], camera, x: (1 + marker.x) / 2, y: (1 - marker.y) / 2 };
}
