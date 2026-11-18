import * as THREE from 'three';
import type { ShadowHit } from './shadowPaint';

export interface ShadowOverlayContext {
  material: THREE.MeshBasicMaterial;
  hits?: ReadonlyMap<number, ShadowHit>;
  colors?: ReadonlyMap<string, string>;
  faceOffset?: number;
}

export function setShadowOverlay(
  mesh: THREE.Mesh,
  faceIds: Uint32Array,
  { material, hits, colors, faceOffset = 0 }: ShadowOverlayContext,
) {
  const previous = mesh.children[0] as THREE.Mesh | undefined;
  if (previous && previous.userData.hits === hits && previous.userData.colors === colors && previous.userData.faceOffset === faceOffset) return;
  if (previous) {
    mesh.remove(previous);
    previous.geometry.dispose();
  }
  if (!hits?.size || !colors) return;

  const source = mesh.geometry.getAttribute('position').array as Float32Array;
  const positions = new Float32Array(hits.size * 9);
  const vertexColors = new Float32Array(hits.size * 9);
  const color = new THREE.Color();
  let offset = 0;
  for (const hit of hits.values()) {
    if (faceIds[hit.triangleIndex] + faceOffset !== hit.faceId) continue;
    const start = hit.triangleIndex * 9;
    positions.set(source.subarray(start, start + 9), offset);
    color.set(colors.get(hit.regionId) ?? '#2b303a');
    for (let vertex = 0; vertex < 3; vertex++) {
      color.toArray(vertexColors, offset + vertex * 3);
    }
    offset += 9;
  }
  if (!offset) return;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, offset), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors.subarray(0, offset), 3));
  const overlay = new THREE.Mesh(geometry, material);
  overlay.userData = { hits, colors, faceOffset };
  overlay.renderOrder = 1;
  mesh.add(overlay);
}

export function disposeDetailMesh(mesh: THREE.Mesh) {
  for (const child of mesh.children) {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  }
  mesh.geometry.dispose();
}
