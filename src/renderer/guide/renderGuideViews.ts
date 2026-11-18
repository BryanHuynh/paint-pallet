import * as THREE from 'three';
import { GUIDE_PASSES, GUIDE_VIEWS, type GuideExport, type GuidePass } from '../../shared/paintingGuide';
import type { ModelOrientation, ModelSummary, PaintPalletApi, Vec3 } from '../../shared/workerProtocol';
import { ANCHOR_ADDRESS, type KitPart } from '../../shared/kit';
import { poseMatrix } from '../kit/jointMath';
import { computeOrientationQuaternion } from '../orientation';
import type { ToneMask } from '../paint/lightingState';
import type { ShadowCoverage } from '../paint/shadowPaint';

const DIRECTIONS = [
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0),
];

function boundsOf(model: ModelSummary) {
  return new THREE.Box3(new THREE.Vector3(...model.bounds.min), new THREE.Vector3(...model.bounds.max));
}

function worldBounds(model: ModelSummary, rotation: THREE.Quaternion, parts?: readonly KitPart[]) {
  const oriented = new THREE.Matrix4().makeRotationFromQuaternion(rotation);
  if (!parts?.length) return boundsOf(model).applyMatrix4(oriented);
  const box = new THREE.Box3();
  for (const part of parts) {
    box.union(boundsOf(part.model).applyMatrix4(oriented.clone().multiply(poseMatrix(part.pose))));
  }
  return box;
}

function createCameras(box: THREE.Box3) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 1e-5);
  const half = extent * 0.56;
  return DIRECTIONS.map((direction) => {
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, extent * 0.01, extent * 4);
    camera.position.copy(center).addScaledVector(direction, extent * 2);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    return camera;
  });
}

export function locateJointOnGuide(model: ModelSummary, orientation: ModelOrientation, parts: readonly KitPart[], parent: KitPart, point: Vec3) {
  const rotation = computeOrientationQuaternion(orientation.upright, orientation.front);
  const cameras = createCameras(worldBounds(model, rotation, parts));
  const pose = poseMatrix(parent.pose);
  const center = boundsOf(parent.model).getCenter(new THREE.Vector3()).applyMatrix4(pose);
  const world = new THREE.Vector3(...point).applyMatrix4(pose);
  const outward = world.clone().sub(center).applyQuaternion(rotation);
  let view = 0;
  for (let i = 1; i < DIRECTIONS.length; i++) if (outward.dot(DIRECTIONS[i]) > outward.dot(DIRECTIONS[view])) view = i;
  const projected = world.applyQuaternion(rotation).project(cameras[view]);
  return {
    view: GUIDE_VIEWS[view],
    x: THREE.MathUtils.clamp((1 + projected.x) / 2, 0.04, 0.96),
    y: THREE.MathUtils.clamp((1 - projected.y) / 2, 0.04, 0.96),
  };
}

function toPng(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, canvas: HTMLCanvasElement): string {
  const size = target.width;
  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(size, size);
  const stride = size * 4;
  for (let row = 0; row < size; row++) {
    const source = (size - row - 1) * stride;
    image.data.set(pixels.subarray(source, source + stride), row * stride);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

interface GuideRenderOptions {
  readBatch: PaintPalletApi['readBatch'];
  model: ModelSummary;
  parts?: readonly KitPart[];
  orientation: ModelOrientation;
  coverage: ShadowCoverage;
  tones: ToneMask;
  edges?: ShadowCoverage;
  rows: GuideExport['rows'];
  preview: boolean;
  signal: AbortSignal;
}

export async function renderGuideViews({ readBatch, model, parts, orientation, coverage, tones, edges, rows, preview, signal }: GuideRenderOptions) {
  const side = preview ? 384 : 1000;
  const passes: GuidePass[] = preview ? ['shadow'] : [...GUIDE_PASSES];
  if (edges?.size && !preview && (!parts?.length || parts.some((part) =>
    part.model.batches.some((batch) => edges.has(batch.batchIndex + part.batchOffset))))) passes.push('edge');
  const images: GuideExport['images'] = { shadow: [], midtone: [], highlight: [] };
  const rotation = computeOrientationQuaternion(orientation.upright, orientation.front);
  const cameras = createCameras(worldBounds(model, rotation, parts));
  const output = document.createElement('canvas');
  output.width = output.height = side;
  const renderer = new THREE.WebGLRenderer({ powerPreference: 'high-performance', alpha: false });
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.matrixAutoUpdate = false;
  const orientationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(rotation);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const targets = passes.map(() => cameras.map(() => {
    const target = new THREE.WebGLRenderTarget(side, side, { colorSpace: THREE.SRGBColorSpace });
    target.samples = Math.min(4, renderer.capabilities.maxSamples);
    return target;
  }));
  renderer.setClearColor(0xffffff, 1);
  renderer.autoClear = false;
  const swatches = new Map(rows.map(({ id, swatches, edgeSwatch }) => {
    const palette = new Map<GuidePass, THREE.Color>();
    if (swatches) for (const pass of GUIDE_PASSES) palette.set(pass, new THREE.Color(swatches[pass].hex));
    if (edgeSwatch) palette.set('edge', new THREE.Color(edgeSwatch.hex));
    return [id, palette];
  }));
  const neutral = new THREE.Color(0xd6dbd7);
  const missingEdgeSwatch = new THREE.Color(0x48a887);
  try {
    for (const target of targets.flat()) {
      renderer.setRenderTarget(target);
      renderer.clear();
    }
    const sources = parts?.length
      ? parts.map((part) => ({ model: part.model, address: part, matrix: orientationMatrix.clone().multiply(poseMatrix(part.pose)) }))
      : [{ model, address: ANCHOR_ADDRESS, matrix: orientationMatrix }];
    for (const source of sources) {
      mesh.matrix.copy(source.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      for (const batch of source.model.batches) {
        signal.throwIfAborted();
        const data = await readBatch(batch.filePath);
        signal.throwIfAborted();
        const geometry = new THREE.BufferGeometry();
        mesh.geometry.dispose();
        mesh.geometry = geometry;
        geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        const faceColors = passes.map(() => new Float32Array(data.positions.length));
        const faces = coverage.get(batch.batchIndex + source.address.batchOffset);
        const shades = tones.get(batch.batchIndex + source.address.batchOffset);
        const band = edges?.get(batch.batchIndex + source.address.batchOffset);
        for (let i = 0; i < data.faceIds.length; i++) {
          const id = data.faceIds[i] + source.address.faceOffset;
          const hit = faces?.get(id);
          const shade = shades?.get(id);
          const palette = hit && swatches.get(hit.regionId);
          const offset = i * 9;
          // A restrained grayscale normal response gives uncovered shapes readable contours.
          const relief = 0.8 + 0.2 * Math.abs(data.normals[offset + 1] * 0.6 + data.normals[offset + 2] * 0.8);
          for (let index = 0; index < passes.length; index++) {
            const pass = passes[index];
            const covered = hit && (pass === 'edge' ? band?.get(id)?.regionId === hit.regionId
              : pass === 'shadow' || shade?.regionId === hit.regionId &&
                (pass === 'midtone' || shade?.tone === 'highlight'));
            const color = covered ? palette?.get(pass) ?? (pass === 'edge' ? missingEdgeSwatch : neutral) : neutral;
            const strength = color === neutral ? relief : 1;
            const array = faceColors[index];
            for (let vertex = offset; vertex < offset + 9; vertex += 3) {
              array[vertex] = color.r * strength;
              array[vertex + 1] = color.g * strength;
              array[vertex + 2] = color.b * strength;
            }
          }
        }
        const colorAttribute = new THREE.BufferAttribute(new Float32Array(data.positions.length), 3).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('color', colorAttribute);
        passes.forEach((_pass, passIndex) => {
          colorAttribute.array.set(faceColors[passIndex]);
          colorAttribute.needsUpdate = true;
          cameras.forEach((camera, viewIndex) => {
            renderer.setRenderTarget(targets[passIndex][viewIndex]);
            renderer.render(scene, camera);
          });
        });
      }
    }
    passes.forEach((pass, index) => {
      images[pass] = targets[index].map((target) => toPng(renderer, target, output));
    });
    return images;
  } finally {
    renderer.setRenderTarget(null);
    mesh.geometry.dispose();
    material.dispose();
    for (const target of targets.flat()) target.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

