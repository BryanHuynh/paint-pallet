import * as THREE from 'three';
import { GUIDE_PASSES, GUIDE_VIEWS, type GuideCallout, type GuideExport, type GuidePass } from '../../shared/paintingGuide';
import type { ModelOrientation, ModelSummary, PaintPalletApi, Vec3 } from '../../shared/workerProtocol';
import { ANCHOR_ADDRESS, type KitPart } from '../../shared/kit';
import { poseMatrix } from '../kit/jointMath';
import { computeOrientationQuaternion } from '../orientation';
import type { ToneAssignment, ToneMask } from '../paint/lightingState';
import type { ShadowCoverage, ShadowHit } from '../paint/shadowPaint';
import { frameGuideDetail, GUIDE_DIRECTIONS, measureGuideDetail } from './guideDetailFrame';

const DIRECTIONS = GUIDE_DIRECTIONS.slice(0, GUIDE_VIEWS.length);

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
  detailCallouts?: readonly GuideCallout[];
}

export function passIncludesFace(pass: GuidePass, hit?: ShadowHit, tone?: ToneAssignment, edge?: ShadowHit): boolean {
  if (!hit) return false;
  if (pass === 'shadow') return true;
  if (pass === 'edge') return edge?.regionId === hit.regionId;
  return tone?.regionId === hit.regionId && (pass === 'midtone' || tone.tone === 'highlight');
}

type GuideSource = { model: ModelSummary; address: typeof ANCHOR_ADDRESS; matrix: THREE.Matrix4 };

async function renderDetails(options: GuideRenderOptions, sources: GuideSource[], passes: GuidePass[],
  overview: THREE.OrthographicCamera[], render: (scene: THREE.Scene, camera: THREE.Camera, color: THREE.Color) => string) {
  const { rows, coverage, tones, edges, detailCallouts, readBatch, signal } = options;
  const details: NonNullable<GuideExport['details']> = {};
  if (!detailCallouts) return details;
  type RegionBatch = { filePath: string; matrix: THREE.Matrix4; faceOffset: number; batchIndex: number; hits: ShadowHit[] };
  const regions = new Map(rows.map((row) => [row.id, [] as RegionBatch[]]));
  for (const source of sources) {
    for (const batch of source.model.batches) {
      const batchIndex = batch.batchIndex + source.address.batchOffset;
      const batches = new Map<string, RegionBatch>();
      for (const hit of coverage.get(batchIndex)?.values() ?? []) {
        const region = regions.get(hit.regionId);
        if (!region) continue;
        let entry = batches.get(hit.regionId);
        if (!entry) {
          entry = { filePath: batch.filePath, matrix: source.matrix, faceOffset: source.address.faceOffset, batchIndex, hits: [] };
          batches.set(hit.regionId, entry);
          region.push(entry);
        }
        entry.hits.push(hit);
      }
    }
  }

  const vertex = new THREE.Vector3();
  for (const row of rows) {
    const batches = regions.get(row.id)!;
    if (!batches.length) continue;
    const chunks = [];
    for (const batch of batches) {
      signal.throwIfAborted();
      const data = await readBatch(batch.filePath);
      signal.throwIfAborted();
      const hits = batch.hits.filter(({ triangleIndex, faceId }) => data.faceIds[triangleIndex] + batch.faceOffset === faceId);
      const positions = new Float32Array(hits.length * 9);
      hits.forEach(({ triangleIndex }, i) => {
        for (let offset = 0; offset < 9; offset += 3) {
          vertex.fromArray(data.positions, triangleIndex * 9 + offset).applyMatrix4(batch.matrix).toArray(positions, i * 9 + offset);
        }
      });
      chunks.push({ hits, positions, shades: tones.get(batch.batchIndex), band: edges?.get(batch.batchIndex) });
    }

    const callouts = detailCallouts.filter((callout) => callout.regionId === row.id);
    for (const pass of passes) {
      const swatch = pass === 'edge' ? row.edgeSwatch : row.swatches?.[pass];
      const color = new THREE.Color(swatch?.hex ?? (pass === 'edge' ? 0x48a887 : 0xd6dbd7));
      const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false });
      const scene = new THREE.Scene();
      const geometries: THREE.BufferGeometry[] = [];
      try {
        for (const { hits, positions, shades, band } of chunks) {
          const selected: number[] = [];
          hits.forEach((hit, i) => {
            if (passIncludesFace(pass, hit, shades?.get(hit.faceId), band?.get(hit.faceId))) {
              selected.push(i * 3, i * 3 + 1, i * 3 + 2);
            }
          });
          if (!selected.length) continue;
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(selected), 1));
          geometries.push(geometry);
          const mesh = new THREE.Mesh(geometry, material);
          mesh.frustumCulled = false;
          scene.add(mesh);
        }
        if (!geometries.length) continue;
        const frame = measureGuideDetail(geometries);
        if (!frame.area.some((area) => area > 0)) continue;
        const cards = details[pass] ??= [];
        for (const callout of callouts.length ? callouts : [undefined]) {
          signal.throwIfAborted();
          const { camera, ...position } = frameGuideDetail(geometries, frame, overview, callout);
          cards.push({ ...position, regionId: row.id, image: render(scene, camera, color) });
        }
      } finally {
        for (const geometry of geometries) geometry.dispose();
        material.dispose();
      }
    }
  }
  return details;
}

export async function renderGuideViews(options: GuideRenderOptions) {
  const { readBatch, model, parts, orientation, coverage, tones, edges, rows, preview, signal, detailCallouts } = options;
  const side = preview ? 384 : 1000;
  const passes: GuidePass[] = preview ? ['shadow'] : [...GUIDE_PASSES];
  if (edges?.size && !preview && (!parts?.length || parts.some((part) =>
    part.model.batches.some((batch) => edges.has(batch.batchIndex + part.batchOffset))))) passes.push('edge');
  const images: GuideExport['images'] = { shadow: [], midtone: [], highlight: [] };
  const rotation = computeOrientationQuaternion(orientation.upright, orientation.front);
  const fullBounds = worldBounds(model, rotation, parts);
  const fullCameras = createCameras(fullBounds);
  const orientationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(rotation);
  const sources = parts?.length
    ? parts.map((part) => ({ model: part.model, address: part, matrix: orientationMatrix.clone().multiply(poseMatrix(part.pose)) }))
    : [{ model, address: ANCHOR_ADDRESS, matrix: orientationMatrix }];
  const output = document.createElement('canvas');
  output.width = output.height = side;
  const renderer = new THREE.WebGLRenderer({ powerPreference: 'high-performance', alpha: false });
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const makeTarget = () => {
    const target = new THREE.WebGLRenderTarget(side, side, { colorSpace: THREE.SRGBColorSpace });
    target.samples = Math.min(4, renderer.capabilities.maxSamples);
    return target;
  };
  const targets = passes.map(() => fullCameras.map(makeTarget));
  const detailTarget = detailCallouts ? makeTarget() : null;
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
    for (const source of sources) {
      mesh.matrix.copy(source.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      for (const batch of source.model.batches) {
        const batchIndex = batch.batchIndex + source.address.batchOffset;
        const faces = coverage.get(batchIndex);
        signal.throwIfAborted();
        const data = await readBatch(batch.filePath);
        signal.throwIfAborted();
        const geometry = new THREE.BufferGeometry();
        mesh.geometry.dispose();
        mesh.geometry = geometry;
        geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        const faceColors = passes.map(() => new Float32Array(data.positions.length));
        const shades = tones.get(batchIndex);
        const band = edges?.get(batchIndex);
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
            const covered = passIncludesFace(pass, hit, shade, band?.get(id));
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
          fullCameras.forEach((camera, viewIndex) => {
            renderer.setRenderTarget(targets[passIndex][viewIndex]);
            renderer.render(scene, camera);
          });
        });
      }
    }
    passes.forEach((pass, index) => {
      images[pass] = targets[index].map((target) => toPng(renderer, target, output));
    });
    renderer.setRenderTarget(null);
    for (const target of targets.flat()) target.dispose();
    targets.length = 0;
    mesh.geometry.dispose();
    const details = detailTarget ? await renderDetails(options, sources, passes, fullCameras, (detail, camera, color) => {
      renderer.setRenderTarget(detailTarget);
      // Choose a background that keeps pale and dark swatches visible in print.
      renderer.setClearColor(color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 > 0.4 ? 0x889891 : 0xf1f4f2);
      renderer.clear();
      renderer.render(detail, camera);
      return toPng(renderer, detailTarget, output);
    }) : undefined;
    return { images, details };
  } finally {
    renderer.setRenderTarget(null);
    mesh.geometry.dispose();
    material.dispose();
    for (const target of targets.flat()) target.dispose();
    detailTarget?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

