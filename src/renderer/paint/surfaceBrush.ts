import * as THREE from 'three';
import type { SurfaceFace } from './shadowPaint';

interface ScreenPoint {
  x: number;
  y: number;
}

interface FaceBatch {
  index: number;
  mesh: THREE.Mesh;
  faceIds: Uint32Array;
}

interface FaceRange {
  start: number;
  end: number;
  batch: FaceBatch;
}

const MAX_PICK_PIXELS = 8_000_000;
const MAX_FACE_KEY = 0xffffff;

export class SurfaceBrush {
  private target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  private material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { firstFace: { value: 0 } },
    vertexShader: `
      uniform uint firstFace;
      flat out uint faceKey;
      void main() {
        faceKey = firstFace == 0u ? 0u : firstFace + uint(gl_VertexID) / 3u;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      flat in uint faceKey;
      out vec4 faceColor;
      void main() {
        uvec3 bytes = (uvec3(faceKey) >> uvec3(0u, 8u, 16u)) & uvec3(255u);
        faceColor = vec4(vec3(bytes) / 255.0, 1.0);
      }
    `,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
  private ranges: FaceRange[] = [];
  private seen = new Set<number>();
  private pixels = new Uint8Array(0);
  private rect: DOMRect | null = null;

  capture(
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    rect: DOMRect,
    preview: readonly THREE.Object3D[],
    details: readonly FaceBatch[],
  ): boolean {
    if (!rect.width || !rect.height || details.length === 0) return false;

    const sizeLimit = renderer.capabilities.maxTextureSize;
    const scale = Math.min(
      2,
      Math.sqrt(MAX_PICK_PIXELS / (rect.width * rect.height)),
      sizeLimit / rect.width,
      sizeLimit / rect.height,
    );
    this.target.setSize(Math.max(1, Math.floor(rect.width * scale)), Math.max(1, Math.floor(rect.height * scale)));
    this.rect = rect;
    this.ranges = [];
    this.seen.clear();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0);
    const addProxy = (mesh: THREE.Mesh, firstFace: number) => {
      mesh.updateWorldMatrix(true, false);
      const proxy = new THREE.Mesh(mesh.geometry, this.material);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(mesh.matrixWorld);
      proxy.onBeforeRender = () => {
        this.material.uniforms.firstFace.value = firstFace;
        this.material.uniformsNeedUpdate = true;
      };
      scene.add(proxy);
    };

    for (const mesh of preview) {
      if (mesh instanceof THREE.Mesh) addProxy(mesh, 0);
    }

    let nextKey = 1;
    for (const batch of details) {
      if (!batch.faceIds.length) continue;
      const end = nextKey + batch.faceIds.length;
      if (end - 1 > MAX_FACE_KEY) {
        this.clear();
        return false;
      }
      this.ranges.push({ start: nextKey, end, batch });
      addProxy(batch.mesh, nextKey);
      nextKey = end;
    }
    if (!this.ranges.length) return false;

    const previousTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    return true;
  }

  sample(
    renderer: THREE.WebGLRenderer,
    from: ScreenPoint,
    to: ScreenPoint,
    diameter: number,
  ): SurfaceFace[] {
    const rect = this.rect;
    if (!rect || !this.ranges.length) return [];

    const width = this.target.width;
    const height = this.target.height;
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    const radius = Math.max(0.75, diameter / 2);
    const left = Math.max(0, Math.floor((Math.min(from.x, to.x) - radius - rect.left) * scaleX));
    const right = Math.min(width, Math.ceil((Math.max(from.x, to.x) + radius - rect.left) * scaleX));
    const top = Math.max(0, Math.floor((Math.min(from.y, to.y) - radius - rect.top) * scaleY));
    const bottom = Math.min(height, Math.ceil((Math.max(from.y, to.y) + radius - rect.top) * scaleY));
    if (left >= right || top >= bottom) return [];

    const sampleWidth = right - left;
    const sampleHeight = bottom - top;
    const bytes = sampleWidth * sampleHeight * 4;
    if (this.pixels.length < bytes) this.pixels = new Uint8Array(bytes);
    renderer.readRenderTargetPixels(this.target, left, height - bottom, sampleWidth, sampleHeight, this.pixels);

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const radiusSquared = radius * radius;
    const hits: SurfaceFace[] = [];

    for (let row = 0; row < sampleHeight; row++) {
      const y = rect.top + (bottom - row - 0.5) / scaleY - from.y;
      for (let column = 0; column < sampleWidth; column++) {
        const offset = (row * sampleWidth + column) * 4;
        const key = this.pixels[offset] | this.pixels[offset + 1] << 8 | this.pixels[offset + 2] << 16;
        if (!key || this.seen.has(key)) continue;
        const x = rect.left + (left + column + 0.5) / scaleX - from.x;
        const t = lengthSquared ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
        if ((x - dx * t) ** 2 + (y - dy * t) ** 2 > radiusSquared) continue;

        const range = this.findRange(key);
        if (!range) continue;
        this.seen.add(key);
        const triangleIndex = key - range.start;
        hits.push({
          faceId: range.batch.faceIds[triangleIndex],
          batchIndex: range.batch.index,
          triangleIndex,
        });
      }
    }

    return hits;
  }

  clear() {
    this.ranges = [];
    this.seen.clear();
    this.rect = null;
  }

  dispose() {
    this.clear();
    this.target.dispose();
    this.material.dispose();
  }

  private findRange(key: number): FaceRange | undefined {
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.ranges[middle].end <= key) low = middle + 1;
      else high = middle;
    }
    const range = this.ranges[low];
    return range && key >= range.start ? range : undefined;
  }
}
