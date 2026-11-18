import * as THREE from 'three';
import { GUIDE_PASSES, type GuideExport } from '../../shared/paintingGuide';
import type { ModelOrientation, ModelSummary, PaintPalletApi } from '../../shared/workerProtocol';
import { computeOrientationQuaternion } from '../orientation';
import type { ToneSlot } from '../palette/types';
import type { ToneMask } from '../paint/lightingState';
import type { ShadowCoverage } from '../paint/shadowPaint';

const DIRECTIONS = [
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0),
];

function createCameras(model: ModelSummary, rotation: THREE.Quaternion) {
  const box = new THREE.Box3(new THREE.Vector3(...model.bounds.min), new THREE.Vector3(...model.bounds.max));
  box.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(rotation));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 1e-5);
  const half = extent * 0.56;
  return DIRECTIONS.map((direction) => {
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, extent * 0.01, extent * 4);
    camera.position.copy(center).addScaledVector(direction, extent * 2);
    camera.lookAt(center);
    return camera;
  });
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
  orientation: ModelOrientation;
  coverage: ShadowCoverage;
  tones: ToneMask;
  rows: GuideExport['rows'];
  preview: boolean;
  signal: AbortSignal;
}

export async function renderGuideViews({ readBatch, model, orientation, coverage, tones, rows, preview, signal }: GuideRenderOptions) {
  const side = preview ? 384 : 1000;
  const passes = preview ? GUIDE_PASSES.slice(0, 1) : GUIDE_PASSES;
  const images: GuideExport['images'] = { shadow: [], midtone: [], highlight: [] };
  const rotation = computeOrientationQuaternion(orientation.upright, orientation.front);
  const cameras = createCameras(model, rotation);
  const output = document.createElement('canvas');
  output.width = output.height = side;
  const renderer = new THREE.WebGLRenderer({ powerPreference: 'high-performance', alpha: false });
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.quaternion.copy(rotation);
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
  const swatches = new Map(rows.filter((row) => row.swatches).map(({ id, swatches }) => [
    id, new Map(GUIDE_PASSES.map((pass) => [pass, new THREE.Color(swatches![pass].hex)])),
  ]));
  const neutral = new THREE.Color(0xd6dbd7);
  const colors = new Map<ToneSlot, THREE.Color>();
  try {
    for (const target of targets.flat()) {
      renderer.setRenderTarget(target);
      renderer.clear();
    }
    for (const batch of model.batches) {
      signal.throwIfAborted();
      const data = await readBatch(batch.filePath);
      signal.throwIfAborted();
      const geometry = new THREE.BufferGeometry();
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      const faceColors = passes.map(() => new Float32Array(data.positions.length));
      const faces = coverage.get(batch.batchIndex);
      const shades = tones.get(batch.batchIndex);
      for (let i = 0; i < data.faceIds.length; i++) {
        const id = data.faceIds[i];
        const hit = faces?.get(id);
        const shade = shades?.get(id);
        const palette = hit && swatches.get(hit.regionId);
        colors.clear();
        for (const pass of passes) {
          const covered = hit && (pass === 'shadow' || shade?.regionId === hit.regionId &&
            (pass === 'midtone' || shade?.tone === 'highlight'));
          colors.set(pass, covered && palette && palette.get(pass) || neutral);
        }
        const offset = i * 9;
        // A restrained grayscale normal response gives uncovered shapes readable contours.
        const relief = 0.8 + 0.2 * Math.abs(data.normals[offset + 1] * 0.6 + data.normals[offset + 2] * 0.8);
        passes.forEach((pass, index) => {
          const color = colors.get(pass)!;
          const strength = color === neutral ? relief : 1;
          const array = faceColors[index];
          for (let vertex = offset; vertex < offset + 9; vertex += 3) {
            array[vertex] = color.r * strength;
            array[vertex + 1] = color.g * strength;
            array[vertex + 2] = color.b * strength;
          }
        });
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

