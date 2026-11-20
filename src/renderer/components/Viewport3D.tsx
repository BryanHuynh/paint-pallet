import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  BatchDescriptor,
  Bounds3,
  ModelOrientation,
  ModelSummary,
  PaintPalletApi,
  Vec3,
} from '../../shared/workerProtocol';
import { ANCHOR_ADDRESS, IDENTITY_PART_POSE, type PartAddress, type KitPart, type PartPose } from '../../shared/kit';
import { computeOrientationQuaternion } from '../orientation';
import { disposeDetailMesh, PaintOverlayStyle, setShadowOverlay } from '../paint/shadowOverlay';
import type { LightTonePreview } from '../paint/lightingState';
import type { ShadowCoverage, SurfaceFace } from '../paint/shadowPaint';
import { SurfaceBrush } from '../paint/surfaceBrush';
import { SurfaceBrushPreview } from '../paint/surfaceBrushPreview';
import { dragLightDirection } from './lightHandle';

export type CameraPreset = 'reset' | 'focus' | 'front' | 'back' | 'top' | 'bottom' | 'right' | 'left';

export interface PickGenerationToken {
  modelId: string;
  modelGen: number;
  viewGen: number;
}

export interface Viewport3DProps {
  api?: PaintPalletApi;
  model: ModelSummary | null;
  pendingModel: ModelSummary | null;
  companionParts?: readonly KitPart[];
  focusPose?: PartPose;
  fitBounds?: Bounds3;
  hideFocused?: boolean;
  ghostModelId?: string;
  jointMarker?: Vec3;
  highlightPickFace?: boolean;
  fillPick?: boolean;
  showLighting?: boolean;
  lightPlacement?: { active: boolean; direction: Vec3; cameraRequest: number | null; onDirection: (direction: Vec3) => void };
  orientation: ModelOrientation;
  cameraPresetRequest: { preset: CameraPreset; seq: number } | null;
  onSurfacePick: (
    origin: Vec3,
    direction: Vec3,
    batchIndices: number[],
    token: PickGenerationToken,
  ) => void;
  shadowPaint?: {
    enabled: boolean;
    coverage: ShadowCoverage;
    baseCoverage?: ShadowCoverage;
    companionCoverage?: ShadowCoverage;
    lightPreview?: LightTonePreview | null;
    colors: ReadonlyMap<string, string>;
    address?: PartAddress;
    diameter: number;
    onFaces: (faces: SurfaceFace[]) => void;
    onStart: () => boolean;
    onEnd: (commit: boolean) => void;
  };
  onPickNeedsDetail?: (message: string) => void;
  onViewChange?: () => void;
  onPendingModelCommit: (committed: ModelSummary) => Promise<boolean> | boolean;
  onPendingModelError: (error: Error) => void;
  disableWebGL?: boolean;
  active?: boolean;
}

export const MAX_DETAIL_BATCHES = 256;
export const MAX_DETAIL_TRIANGLES = 14_000_000;
export const INITIAL_STAGE_BATCHES = 16;
const DETAIL_STREAM_CONCURRENCY = 4;
const MAX_COMPANION_DETAIL_TRIANGLES = MAX_DETAIL_TRIANGLES / 2;

interface CompanionLayer {
  group: THREE.Group;
  ghost: boolean;
  preview: THREE.Mesh | null;
  maskedMaterials?: { detail: THREE.MeshStandardMaterial; preview: THREE.MeshStandardMaterial };
  batches: Map<number, { mesh: THREE.Mesh; faceIds: Uint32Array }>;
}

export function visiblePartBatches(camera: THREE.PerspectiveCamera, layer: THREE.Group, model: ModelSummary) {
  // Keep a little detail beyond the viewport edge during damped camera movement.
  const clipFromPart = camera.projectionMatrix.clone();
  clipFromPart.elements[0] *= 0.94;
  clipFromPart.elements[5] *= 0.94;
  clipFromPart.multiply(camera.matrixWorldInverse).multiply(layer.matrixWorld);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(clipFromPart);
  const bounds = new THREE.Box3();
  const intersects = ({ min, max }: Bounds3) => {
    bounds.min.fromArray(min);
    bounds.max.fromArray(max);
    return frustum.intersectsBox(bounds);
  };
  return intersects(model.bounds) ? model.batches.filter((batch) => intersects(batch.bounds)) : [];
}

function markExactSurface(material: THREE.MeshStandardMaterial, id: number) {
  material.stencilWrite = true;
  material.stencilRef = id;
  material.stencilZPass = THREE.ReplaceStencilOp;
}

function maskPreviewSurface(material: THREE.MeshStandardMaterial, id: number) {
  material.stencilWrite = true;
  material.stencilWriteMask = 0;
  material.stencilRef = id;
  material.stencilFunc = THREE.NotEqualStencilFunc;
}

function attachSurfaceDetail(material: THREE.Material, strength: { value: number }) {
  const compile = material.onBeforeCompile;
  const cacheKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => cacheKey + ':surface-detail';
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    shader.uniforms.surfaceDetailStrength = strength;
    shader.vertexShader = 'varying vec3 detailViewPosition;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n detailViewPosition = mvPosition.xyz;',
    );
    shader.fragmentShader = 'uniform float surfaceDetailStrength;\n varying vec3 detailViewPosition;\n' +
      shader.fragmentShader.replace('#include <opaque_fragment>', `
        if (surfaceDetailStrength > 0.0) {
          vec3 viewNormal = normalize(cross(dFdx(detailViewPosition), dFdy(detailViewPosition)));
          float slope = length(viewNormal.xy);
          float bevel = dot(viewNormal.xy, vec2(-0.55, 0.83));
          float rim = smoothstep(0.72, 1.0, slope);
          outgoingLight = mix(outgoingLight, vec3(0.0), surfaceDetailStrength * (max(0.0, -bevel) * 0.28 + rim * 0.22));
          outgoingLight = mix(outgoingLight, vec3(1.0), surfaceDetailStrength * max(0.0, bevel) * 0.19);
        }
        #include <opaque_fragment>
      `);
  };
}

function disposeCompanion(layer: CompanionLayer) {
  disposeGroupMeshes(layer.group);
  layer.maskedMaterials?.detail.dispose();
  layer.maskedMaterials?.preview.dispose();
}

function distanceSqToBounds(p: THREE.Vector3, b: BatchDescriptor['bounds']): number {
  const dx = Math.max(b.min[0] - p.x, 0, p.x - b.max[0]);
  const dy = Math.max(b.min[1] - p.y, 0, p.y - b.max[1]);
  const dz = Math.max(b.min[2] - p.z, 0, p.z - b.max[2]);
  return dx * dx + dy * dy + dz * dz;
}

export function selectCameraVisibleBatchIndices(
  batches: BatchDescriptor[],
  cameraLocalPos: Vec3,
  targetLocalPos: Vec3,
  maxBatches = MAX_DETAIL_BATCHES,
): number[] {
  if (batches.length <= maxBatches) {
    return batches.map((b) => b.batchIndex);
  }
  const cam = new THREE.Vector3(...cameraLocalPos);
  const tgt = new THREE.Vector3(...targetLocalPos);
  const viewDir = new THREE.Vector3().subVectors(tgt, cam).normalize();

  return [...batches]
    .sort((a, b) => {
      const ac = new THREE.Vector3(
        (a.bounds.min[0] + a.bounds.max[0]) * 0.5,
        (a.bounds.min[1] + a.bounds.max[1]) * 0.5,
        (a.bounds.min[2] + a.bounds.max[2]) * 0.5,
      );
      const bc = new THREE.Vector3(
        (b.bounds.min[0] + b.bounds.max[0]) * 0.5,
        (b.bounds.min[1] + b.bounds.max[1]) * 0.5,
        (b.bounds.min[2] + b.bounds.max[2]) * 0.5,
      );
      const aFront = new THREE.Vector3().subVectors(ac, cam).dot(viewDir) >= 0 ? 0 : 1;
      const bFront = new THREE.Vector3().subVectors(bc, cam).dot(viewDir) >= 0 ? 0 : 1;
      if (aFront !== bFront) return aFront - bFront;
      return distanceSqToBounds(tgt, a.bounds) + distanceSqToBounds(cam, a.bounds) * 0.25 -
             (distanceSqToBounds(tgt, b.bounds) + distanceSqToBounds(cam, b.bounds) * 0.25);
    })
    .slice(0, maxBatches)
    .map((b) => b.batchIndex);
}

export function findRayIntersectingBatchIndices(
  batches: BatchDescriptor[],
  origin: Vec3,
  direction: Vec3,
): number[] {
  const hits: { batchIndex: number; tMin: number }[] = [];
  const invDir: Vec3 = [
    Math.abs(direction[0]) > 1e-12 ? 1 / direction[0] : 1e30,
    Math.abs(direction[1]) > 1e-12 ? 1 / direction[1] : 1e30,
    Math.abs(direction[2]) > 1e-12 ? 1 / direction[2] : 1e30,
  ];
  for (const b of batches) {
    let tmin = 0;
    let tmax = Infinity;
    let hit = true;
    for (let i = 0; i < 3; i++) {
      let t1 = (b.bounds.min[i] - origin[i]) * invDir[i];
      let t2 = (b.bounds.max[i] - origin[i]) * invDir[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) {
        hit = false;
        break;
      }
    }
    if (hit) {
      hits.push({ batchIndex: b.batchIndex, tMin: tmin });
    }
  }
  hits.sort((a, b) => a.tMin - b.tMin);
  return hits.map((h) => h.batchIndex);
}

export type ClickResolution =
  | { kind: 'preview-only' }
  | { kind: 'needs-detail'; targetBatches: number[] }
  | { kind: 'pick'; visibleBatchIds: number[] };

/**
 * Pure click-time decision: resolves only against original-detail batches visible
 * at click time; rejects preview-only clicks and requests a second click when more
 * detail must be streamed.
 */
export function resolveClickAgainstVisibleDetail(
  detailVisible: boolean,
  visibleBatchSet: ReadonlySet<number>,
  rayIntersectingBatches: number[],
): ClickResolution {
  if (!detailVisible || visibleBatchSet.size === 0) {
    return { kind: 'preview-only' };
  }
  if (rayIntersectingBatches.length > 0 && !visibleBatchSet.has(rayIntersectingBatches[0])) {
    return {
      kind: 'needs-detail',
      targetBatches: rayIntersectingBatches.slice(0, MAX_DETAIL_BATCHES),
    };
  }
  return {
    kind: 'pick',
    visibleBatchIds: Array.from(visibleBatchSet),
  };
}

export function disposeGroupMeshes(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0] as THREE.Mesh;
    group.remove(child);
    disposeDetailMesh(child);
  }
}

export interface OrbitDetailCallbacks {
  onCameraMoved: () => void;
  onCameraSettled: () => void;
  settleDelayMs?: number;
}

/**
 * Coordinates Three.js OrbitControls events with exact-detail vs moving-preview
 * visibility. OrbitControls emits 'start' immediately on stationary pointerdown;
 * this keeps exact detail visible until actual camera movement occurs on 'change'.
 */
export function attachOrbitDetailLifecycle(
  controls: OrbitControls,
  camera: THREE.Camera,
  previewGroup: THREE.Group,
  detailGroup: THREE.Group,
  callbacks: OrbitDetailCallbacks,
) {
  let settleTimer: number | null = null;
  let interacting = false;
  let movedThisGesture = false;
  const startCamPos = new THREE.Vector3();
  const startTarget = new THREE.Vector3();
  const settleDelayMs = callbacks.settleDelayMs ?? 120;

  const syncRestSnapshot = () => {
    startCamPos.copy(camera.position);
    startTarget.copy(controls.target);
  };
  syncRestSnapshot();

  const onStart = () => {
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    interacting = true;
    movedThisGesture = false;
    syncRestSnapshot();
  };

  const scheduleSettled = () => {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      if (!interacting) callbacks.onCameraSettled();
    }, settleDelayMs);
  };

  const onChange = () => {
    const radius = camera.position.distanceTo(controls.target);
    const tolerance = Math.max(1e-6, radius * (interacting ? 0.0003 : 0.00002));
    const moved = camera.position.distanceToSquared(startCamPos) > tolerance ** 2 ||
      controls.target.distanceToSquared(startTarget) > tolerance ** 2;

    if (interacting) {
      if (!moved) return;
      if (!movedThisGesture) {
        movedThisGesture = true;
        callbacks.onCameraMoved();
        if (previewGroup.children.length > 0) {
          previewGroup.visible = true;
          detailGroup.visible = false;
        }
      }
    } else if (moved && settleTimer !== null) {
      // Orbit damping can continue after release. Restore original batches once
      // the remaining frame-to-frame motion is below the settling tolerance.
      scheduleSettled();
    }
    syncRestSnapshot();
  };

  const onEnd = () => {
    interacting = false;
    if (movedThisGesture || !detailGroup.visible) scheduleSettled();
  };

  controls.addEventListener('start', onStart);
  controls.addEventListener('change', onChange);
  controls.addEventListener('end', onEnd);

  return {
    syncRestSnapshot,
    dispose: () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('change', onChange);
      controls.removeEventListener('end', onEnd);
    },
  };
}

export function Viewport3D({
  api,
  model,
  pendingModel,
  companionParts,
  focusPose = IDENTITY_PART_POSE,
  fitBounds,
  hideFocused = false,
  ghostModelId,
  jointMarker,
  highlightPickFace = false,
  lightPlacement,
  orientation,
  cameraPresetRequest,
  onSurfacePick,
  fillPick,
  showLighting = true,
  shadowPaint,
  active = true,
  onPickNeedsDetail,
  onViewChange,
  onPendingModelCommit,
  onPendingModelError,
  disableWebGL = false,
}: Viewport3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previewPickRef = useRef(highlightPickFace);
  previewPickRef.current = highlightPickFace;
  const lightPlacementRef = useRef(lightPlacement);
  lightPlacementRef.current = lightPlacement;
  const handledCameraRequest = useRef<number | null>(null);
  const onPickRef = useRef(onSurfacePick);
  onPickRef.current = onSurfacePick;
  const fillPickRef = useRef(fillPick);
  fillPickRef.current = fillPick;
  const shadowPaintRef = useRef(shadowPaint);
  shadowPaintRef.current = shadowPaint;
  const activeRef = useRef(active);
  activeRef.current = active;
  const previewScores = shadowPaint?.lightPreview?.scores;
  const companionCoverage = shadowPaint?.companionCoverage;
  const paintedCompanionBatches = useMemo(() => {
    const batches: number[] = [];
    for (const [index, hits] of companionCoverage ?? []) if (hits.size) batches.push(index);
    return batches.sort((a, b) => a - b).join(',');
  }, [companionCoverage]);
  const onPickNeedsDetailRef = useRef(onPickNeedsDetail);
  onPickNeedsDetailRef.current = onPickNeedsDetail;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const onCommitRef = useRef(onPendingModelCommit);
  onCommitRef.current = onPendingModelCommit;
  const onErrorRef = useRef(onPendingModelError);
  onErrorRef.current = onPendingModelError;
  const activeModelRef = useRef<ModelSummary | null>(model);
  activeModelRef.current = model;
  const apiRef = useRef<PaintPalletApi | undefined>(api);
  apiRef.current = api;

  const detailCacheRef = useRef<Map<number, { mesh: THREE.Mesh; triangleCount: number; faceIds: Uint32Array; lastUsed: number }>>(new Map());
  const detailTrianglesRef = useRef(0);
  const lruTickRef = useRef(0);
  const streamGenerationRef = useRef(0);
  const modelGenRef = useRef(0);
  const viewGenRef = useRef(0);
  const [companionView, setCompanionView] = useState({ moving: false });

  const sceneRefs = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    orbitLifecycle: ReturnType<typeof attachOrbitDetailLifecycle>;
    renderer: THREE.WebGLRenderer;
    grid: THREE.GridHelper;
    modelGroup: THREE.Group;
    surfaceGroup: THREE.Group;
    companionMaterial: THREE.MeshStandardMaterial;
    stagedMaterial: THREE.MeshStandardMaterial;
    companions: Map<string, CompanionLayer>;
    marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    previewGroup: THREE.Group;
    detailGroup: THREE.Group;
    material: THREE.MeshStandardMaterial;
    previewMaterial: THREE.MeshStandardMaterial;
    shadowMaterial: THREE.MeshBasicMaterial;
    paintStyle: PaintOverlayStyle;
    surfaceDetail: { value: number };
    setLightingVisible: (visible: boolean) => void;
    radius: number;
  } | null>(null);

  function applyShadow(mesh: THREE.Mesh, batchIndex: number, faceIds: Uint32Array,
    companion?: PartAddress, showCompanionPaint = true) {
    const refs = sceneRefs.current;
    const paint = shadowPaintRef.current;
    if (refs && paint) {
      const address = companion ?? paint.address ?? ANCHOR_ADDRESS;
      const coverage = companion ? (showCompanionPaint ? paint.companionCoverage : undefined) : paint.coverage;
      setShadowOverlay(mesh, faceIds, {
        material: refs.shadowMaterial,
        style: refs.paintStyle,
        hits: coverage?.get(batchIndex + address.batchOffset),
        baseHits: paint.baseCoverage?.get(batchIndex + address.batchOffset),
        scores: paint.lightPreview?.scores,
        faceOffset: address.faceOffset,
      });
    }
  }

  useEffect(() => {
    for (const [index, entry] of detailCacheRef.current) {
      applyShadow(entry.mesh, index, entry.faceIds);
    }
  }, [shadowPaint?.coverage, shadowPaint?.baseCoverage, shadowPaint?.address, previewScores]);

  useEffect(() => {
    if (shadowPaint?.colors) sceneRefs.current?.paintStyle.setColors(shadowPaint.colors);
  }, [shadowPaint?.colors]);

  useEffect(() => {
    sceneRefs.current?.paintStyle.setPreview(shadowPaint?.lightPreview);
  }, [shadowPaint?.lightPreview]);

  const updateSettledLayerVisibility = (
    refs: NonNullable<typeof sceneRefs.current>,
    targetModel: ModelSummary,
  ) => {
    refs.previewGroup.visible =
      refs.previewGroup.children.length > 0 &&
      visiblePartBatches(refs.camera, refs.surfaceGroup, targetModel).some(({ batchIndex }) => !detailCacheRef.current.has(batchIndex));
    refs.detailGroup.visible = refs.detailGroup.children.length > 0;
  };

  const ensureDetailBatchesLoaded = async (
    targetModel: ModelSummary,
    desiredIndices: number[],
    generation: number,
  ): Promise<void> => {
    const refs = sceneRefs.current;
    const currentApi = apiRef.current;
    if (!refs || !currentApi) return;

    const batchByIndex = new Map(targetModel.batches.map((b) => [b.batchIndex, b]));
    const cache = detailCacheRef.current;
    const desiredSet = new Set(desiredIndices);
    const paint = shadowPaintRef.current;
    const batchOffset = paint?.address?.batchOffset ?? 0;
    const protectedBatches = new Set(visiblePartBatches(refs.camera, refs.surfaceGroup, targetModel)
      .filter(({ batchIndex }) => paint?.coverage.get(batchIndex + batchOffset)?.size)
      .map(({ batchIndex }) => batchIndex));

    for (const idx of desiredIndices) {
      const existing = cache.get(idx);
      if (existing) {
        existing.lastUsed = ++lruTickRef.current;
      }
    }

    const missingIndices = desiredIndices.filter((idx) => !cache.has(idx) && batchByIndex.has(idx));
    for (let offset = 0; offset < missingIndices.length; offset += DETAIL_STREAM_CONCURRENCY) {
      if (streamGenerationRef.current !== generation) return;
      const chunk = missingIndices.slice(offset, offset + DETAIL_STREAM_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (idx) => {
          const desc = batchByIndex.get(idx)!;
          const bin = await currentApi.readBatch(desc.filePath);
          return { idx, bin };
        }),
      );
      if (streamGenerationRef.current !== generation) return;

      for (const { idx, bin } of results) {
        if (streamGenerationRef.current !== generation) return;
        if (cache.has(idx)) continue;

        while (
          cache.size >= MAX_DETAIL_BATCHES ||
          (detailTrianglesRef.current + bin.triangleCount > MAX_DETAIL_TRIANGLES && cache.size > 0)
        ) {
          let victimKey: number | null = null;
          let oldestTick = Infinity;
          for (const [k, entry] of cache.entries()) {
            if (protectedBatches.has(k) || desiredSet.has(k)) continue;
            if (entry.lastUsed < oldestTick) {
              oldestTick = entry.lastUsed;
              victimKey = k;
            }
          }
          if (victimKey === null) {
            for (const [k, entry] of cache.entries()) {
              if (protectedBatches.has(k)) continue;
              if (entry.lastUsed < oldestTick) {
                oldestTick = entry.lastUsed;
                victimKey = k;
              }
            }
          }
          if (victimKey === null) break;
          const victim = cache.get(victimKey)!;
          refs.detailGroup.remove(victim.mesh);
          disposeDetailMesh(victim.mesh);
          detailTrianglesRef.current = Math.max(0, detailTrianglesRef.current - victim.triangleCount);
          cache.delete(victimKey);
        }
        if (!protectedBatches.has(idx) && (cache.size >= MAX_DETAIL_BATCHES ||
            (detailTrianglesRef.current + bin.triangleCount > MAX_DETAIL_TRIANGLES && cache.size > 0))) continue;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(bin.positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(bin.normals, 3));
        const mesh = new THREE.Mesh(geo, refs.material);
        refs.detailGroup.add(mesh);
        detailTrianglesRef.current += bin.triangleCount;
        cache.set(idx, {
          mesh,
          triangleCount: bin.triangleCount,
          faceIds: bin.faceIds,
          lastUsed: ++lruTickRef.current,
        });
        applyShadow(mesh, idx, bin.faceIds);
      }

      updateSettledLayerVisibility(refs, targetModel);
    }
  };

  const streamForCurrentCamera = async (targetModel: ModelSummary) => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const gen = ++streamGenerationRef.current;
    refs.camera.updateMatrixWorld(true);
    refs.modelGroup.updateMatrixWorld(true);
    const invMat = new THREE.Matrix4().copy(refs.surfaceGroup.matrixWorld).invert();
    const camLocal = refs.camera.position.clone().applyMatrix4(invMat);
    const tgtLocal = refs.controls.target.clone().applyMatrix4(invMat);

    const visible = visiblePartBatches(refs.camera, refs.surfaceGroup, targetModel);
    const paint = shadowPaintRef.current;
    const batchOffset = paint?.address?.batchOffset ?? 0;
    const painted = visible.filter(({ batchIndex }) => paint?.coverage.get(batchIndex + batchOffset)?.size);
    const desired = new Set(painted.map(({ batchIndex }) => batchIndex));
    let triangles = painted.reduce((sum, batch) => sum + batch.triangleCount, 0);
    const byIndex = new Map(visible.map((batch) => [batch.batchIndex, batch]));
    for (const index of selectCameraVisibleBatchIndices(
      visible,
      [camLocal.x, camLocal.y, camLocal.z],
      [tgtLocal.x, tgtLocal.y, tgtLocal.z],
      MAX_DETAIL_BATCHES,
    )) {
      if (desired.has(index)) continue;
      const batch = byIndex.get(index)!;
      if (desired.size >= MAX_DETAIL_BATCHES || triangles + batch.triangleCount > MAX_DETAIL_TRIANGLES) continue;
      triangles += batch.triangleCount;
      desired.add(index);
    }
    await ensureDetailBatchesLoaded(targetModel, [...desired], gen);
    if (streamGenerationRef.current === gen && refs.detailGroup.children.length > 0) {
      updateSettledLayerVisibility(refs, targetModel);
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || disableWebGL) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
    renderer.setClearColor(0x101611, 1);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      42,
      (container.clientWidth || 800) / (container.clientHeight || 600),
      0.05,
      5000,
    );
    camera.position.set(0, 1.2, 3.2);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.enableZoom = true;

    const hemi = new THREE.HemisphereLight(0xf3f7f0, 0x1a281b, 0.85);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
    keyLight.position.set(2.5, 4, 3);

    const rimLight = new THREE.DirectionalLight(0xc6f19d, 0.45);
    rimLight.position.set(-3, 2, -2.5);
    scene.add(hemi, keyLight, rimLight);
    const sceneLights = [hemi, keyLight, rimLight].map((light) => ({ light, intensity: light.intensity }));

    const grid = new THREE.GridHelper(4, 16, 0x39463c, 0x26322a);
    scene.add(grid);

    const material = new THREE.MeshStandardMaterial({
      color: 0xd4d9d2,
      roughness: 0.62,
      metalness: 0.08,
    });

    const shadowMaterial = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const previewMaterial = material.clone();
    markExactSurface(material, 1);
    maskPreviewSurface(previewMaterial, 1);
    const brushPreview = new SurfaceBrushPreview();
    brushPreview.attach(material);
    brushPreview.attach(shadowMaterial);
    const paintStyle = new PaintOverlayStyle();
    paintStyle.attach(shadowMaterial);
    if (shadowPaintRef.current?.colors) paintStyle.setColors(shadowPaintRef.current.colors);
    paintStyle.setPreview(shadowPaintRef.current?.lightPreview);

    const modelGroup = new THREE.Group();
    const surfaceGroup = new THREE.Group();
    const previewGroup = new THREE.Group();
    const detailGroup = new THREE.Group();
    surfaceGroup.add(previewGroup, detailGroup);
    modelGroup.add(surfaceGroup);
    const companionMaterial = new THREE.MeshStandardMaterial({ color: '#aaaeb2', roughness: 0.84, side: THREE.DoubleSide });
    markExactSurface(companionMaterial, 0);
    const stagedMaterial = new THREE.MeshStandardMaterial({ color: '#83b4a5', roughness: 0.8,
      opacity: 0.38, transparent: true, depthWrite: false, side: THREE.FrontSide });
    const surfaceDetail = { value: 0 };
    for (const surface of [material, previewMaterial, companionMaterial, stagedMaterial, shadowMaterial]) {
      attachSurfaceDetail(surface, surfaceDetail);
    }
    const lightHandle = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshPhongMaterial({ color: '#ffba52', specular: '#ffeab7', shininess: 30,
        transparent: true, depthTest: false, depthWrite: false }));
    lightHandle.visible = false;
    lightHandle.renderOrder = 11;
    scene.add(lightHandle);
    const lightLineGeometry = new THREE.BufferGeometry();
    const lightLinePoints = new THREE.BufferAttribute(new Float32Array(6), 3);
    lightLineGeometry.setAttribute('position', lightLinePoints);
    const lightLineMaterial = new THREE.LineBasicMaterial({ color: '#ffd17a', transparent: true, opacity: .6, depthWrite: false });
    const lightLine = new THREE.Line(lightLineGeometry, lightLineMaterial);
    lightLine.frustumCulled = false;
    lightLine.visible = false;
    scene.add(lightLine);
    const lightTarget = document.createElement('button');
    lightTarget.type = 'button';
    lightTarget.className = 'viewport-light-handle';
    lightTarget.setAttribute('aria-label', 'Light direction handle');
    lightTarget.title = 'Drag or use arrow keys to aim the light';
    lightTarget.hidden = true;
    container.appendChild(lightTarget);
    const companions = new Map<string, CompanionLayer>();
    const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#ffd17a', depthTest: false, depthWrite: false }));
    marker.visible = false;
    marker.renderOrder = 9;
    modelGroup.add(marker);
    scene.add(modelGroup);

    const orbitLifecycle = attachOrbitDetailLifecycle(
      controls,
      camera,
      previewGroup,
      detailGroup,
      {
        onCameraMoved: () => {
          ++streamGenerationRef.current;
          ++viewGenRef.current;
          setCompanionView({ moving: true });
          onViewChangeRef.current?.();
        },
        onCameraSettled: () => {
          setCompanionView({ moving: false });
          const m = activeModelRef.current;
          if (m) {
            void streamForCurrentCamera(m);
          }
        },
      },
    );

    sceneRefs.current = {
      scene,
      camera,
      controls,
      orbitLifecycle,
      renderer,
      grid,
      modelGroup,
      surfaceGroup,
      companionMaterial,
      stagedMaterial,
      companions,
      marker,
      previewGroup,
      detailGroup,
      material,
      previewMaterial,
      shadowMaterial,
      paintStyle,
      surfaceDetail,
      setLightingVisible(visible) {
        surfaceDetail.value = visible ? 0 : 1;
        for (const { light, intensity } of sceneLights) light.intensity = visible ? intensity : 0;
        const materials = [material, previewMaterial, companionMaterial, stagedMaterial];
        for (const layer of companions.values()) {
          if (layer.maskedMaterials) materials.push(layer.maskedMaterials.detail, layer.maskedMaterials.preview);
        }
        // Keep the base colors available for the view-space detail shader.
        for (const surface of materials) {
          if (visible) surface.emissive.setHex(0);
          else surface.emissive.copy(surface.color);
        }
      },
      radius: 1,
    };

    const pickRay = (x: number, y: number) => {
      const currentModel = activeModelRef.current;
      if (!currentModel || !surfaceGroup.visible) return;

      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const ndc = new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        -((y - rect.top) / rect.height) * 2 + 1,
      );
      camera.updateMatrixWorld(true);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);

      modelGroup.updateMatrixWorld(true);
      const invMat = new THREE.Matrix4().copy(surfaceGroup.matrixWorld).invert();
      const localRay = raycaster.ray.clone().applyMatrix4(invMat);
      localRay.direction.normalize();

      const orig: Vec3 = [localRay.origin.x, localRay.origin.y, localRay.origin.z];
      const dir: Vec3 = [localRay.direction.x, localRay.direction.y, localRay.direction.z];
      return { currentModel, orig, dir, rayBatches: findRayIntersectingBatchIndices(currentModel.batches, orig, dir) };
    };

    const pickAt = (e: PointerEvent) => {
      const ray = pickRay(e.clientX, e.clientY);
      if (!ray) return;
      const { currentModel, orig, dir, rayBatches } = ray;
      const token = { modelId: currentModel.modelId, modelGen: modelGenRef.current, viewGen: viewGenRef.current };
      if (fillPickRef.current) {
        onPickRef.current(orig, dir, rayBatches, token);
        return;
      }

      const resolution = resolveClickAgainstVisibleDetail(
        detailGroup.visible,
        new Set(detailCacheRef.current.keys()),
        rayBatches,
      );

      if (resolution.kind === 'preview-only') {
        void streamForCurrentCamera(currentModel);
        onPickNeedsDetailRef.current?.(
          'Loading original surface detail for this view; click again to pick face.',
        );
        return;
      }

      if (resolution.kind === 'needs-detail') {
        const gen = ++streamGenerationRef.current;
        void ensureDetailBatchesLoaded(currentModel, resolution.targetBatches, gen).then(() => {
          if (streamGenerationRef.current === gen && sceneRefs.current) {
            updateSettledLayerVisibility(sceneRefs.current, currentModel);
          }
        });
        onPickNeedsDetailRef.current?.(
          'Loading original detail for clicked region; click again to pick face.',
        );
        return;
      }

      // Frame remains unchanged; capture visible batch IDs and generations synchronously before async pick
      onPickRef.current(orig, dir, resolution.visibleBatchIds, token);
    };

    let downX = 0;
    let downY = 0;
    let strokePointer: number | null = null;
    let lightDrag: { pointer: number; x: number; y: number; direction: Vec3; rotation: THREE.Quaternion;
      lastX: number; lastY: number; height: number } | null = null;
    let orbitActive = false;
    const onOrbitStart = () => { orbitActive = true; };
    const onOrbitEnd = () => { orbitActive = false; };
    controls.addEventListener('start', onOrbitStart);
    controls.addEventListener('end', onOrbitEnd);
    const lightCenter = new THREE.Vector3();
    const lightPosition = new THREE.Vector3();
    const projectedLight = new THREE.Vector3();
    const lightBounds = new THREE.Box3();
    let strokeView = 0;
    let lastSample = { x: 0, y: 0 };
    let sampleFrame = 0;
    let pendingPoint = lastSample;
    const canvas = renderer.domElement;
    const brush = new SurfaceBrush();

    const faceOutlineGeometry = new THREE.BufferGeometry();
    const faceOutlinePositions = new THREE.BufferAttribute(new Float32Array(9), 3);
    faceOutlineGeometry.setAttribute('position', faceOutlinePositions);
    const faceOutlineMaterial = new THREE.LineBasicMaterial({ color: '#fff0ad', depthWrite: false });
    const faceOutline = new THREE.LineLoop(faceOutlineGeometry, faceOutlineMaterial);
    faceOutline.frustumCulled = false;
    faceOutline.renderOrder = 10;
    faceOutline.visible = false;
    surfaceGroup.add(faceOutline);
    let hoverInFlight = false;
    let nextHoverAt = 0;
    let lastHoverKey = '';
    let hoverPoint: { x: number; y: number } | null = null;
    const previewHoveredFace = () => {
      if (!previewPickRef.current || !hoverPoint || !detailGroup.visible) {
        faceOutline.visible = false;
        lastHoverKey = '';
        return;
      }
      const view = viewGenRef.current;
      const modelGen = modelGenRef.current;
      const point = hoverPoint;
      const key = [view, modelGen, point.x, point.y].join(':');
      const now = performance.now();
      if (hoverInFlight || key === lastHoverKey || now < nextHoverAt) return;
      const ray = pickRay(point.x, point.y);
      const currentApi = apiRef.current;
      if (!ray || !currentApi) return;
      const resolution = resolveClickAgainstVisibleDetail(true, new Set(detailCacheRef.current.keys()), ray.rayBatches);
      if (resolution.kind !== 'pick') {
        faceOutline.visible = false;
        return;
      }
      hoverInFlight = true;
      faceOutline.visible = false;
      lastHoverKey = key;
      nextHoverAt = now + 75;
      void currentApi.pickFace(ray.currentModel.modelId, ray.orig, ray.dir, resolution.visibleBatchIds).then((hit) => {
        if (view !== viewGenRef.current || modelGen !== modelGenRef.current || !previewPickRef.current ||
          hoverPoint !== point || sceneRefs.current?.renderer !== renderer) return;
        const entry = hit.batchIndex === undefined ? undefined : detailCacheRef.current.get(hit.batchIndex);
        if (!hit.hit || !entry || hit.triangleIndex === undefined || !hit.normal) {
          faceOutline.visible = false;
          return;
        }
        const vertices = entry.mesh.geometry.getAttribute('position');
        for (let i = 0; i < 3; i++) {
          const vertex = hit.triangleIndex * 3 + i;
          const lift = Math.max(1e-7, (hit.distance ?? 1) * 1e-5);
          faceOutlinePositions.setXYZ(i, vertices.getX(vertex) - ray.dir[0] * lift,
            vertices.getY(vertex) - ray.dir[1] * lift, vertices.getZ(vertex) - ray.dir[2] * lift);
        }
        faceOutlinePositions.needsUpdate = true;
        faceOutline.visible = true;
      }).catch(() => { faceOutline.visible = false; }).finally(() => { hoverInFlight = false; });
    };

    const clearBrushHover = () => {
      hoverPoint = null;
    };
    const moveBrushHover = (event: PointerEvent) => {
      hoverPoint = event.altKey || event.pointerType === 'touch'
        ? null
        : { x: event.clientX, y: event.clientY };
    };
    const endStroke = (commit: boolean) => {
      window.cancelAnimationFrame(sampleFrame);
      sampleFrame = 0;
      strokePointer = null;
      brush.clear();
      shadowPaintRef.current?.onEnd(commit);
    };
    const sampleBrush = (next: { x: number; y: number }) => {
      const paint = shadowPaintRef.current;
      if (!paint?.enabled || strokeView !== viewGenRef.current) {
        endStroke(false);
        return;
      }
      const hits = brush.sample(renderer, lastSample, next, paint.diameter);
      const address = paint.address ?? ANCHOR_ADDRESS;
      paint.onFaces(address.faceOffset || address.batchOffset ? hits.map((hit) => ({
        ...hit, faceId: hit.faceId + address.faceOffset, batchIndex: hit.batchIndex + address.batchOffset,
      })) : hits);
      lastSample = next;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (lightDrag) {
        e.stopImmediatePropagation();
        return;
      }
      if (e.button !== 0) return;
      downX = e.clientX;
      downY = e.clientY;
      if (lightPlacementRef.current?.active) return;
      const paint = shadowPaintRef.current;
      if (!paint?.enabled || e.altKey) return;

      e.stopImmediatePropagation();
      e.preventDefault();
      if (strokePointer !== null || !paint.onStart()) return;
      if (!detailGroup.visible || detailCacheRef.current.size === 0) {
        const currentModel = activeModelRef.current;
        if (currentModel) void streamForCurrentCamera(currentModel);
        onPickNeedsDetailRef.current?.('Loading original surface detail. Try the brush again once it appears.');
        endStroke(false);
        return;
      }

      const details = [...detailCacheRef.current.entries()].map(([index, entry]) => ({
        index, mesh: entry.mesh, faceIds: entry.faceIds,
      }));
      const preview = previewGroup.visible ? [...previewGroup.children] : [];
      for (const { group, ghost } of companions.values()) {
        if (group.visible && !ghost) preview.push(...group.children.filter((mesh) => mesh.visible));
      }
      if (!brush.capture(renderer, camera, canvas.getBoundingClientRect(), preview, details)) {
        endStroke(false);
        return;
      }

      strokePointer = e.pointerId;
      strokeView = viewGenRef.current;
      lastSample = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      moveBrushHover(e);
      sampleBrush(lastSample);
    };
    const onPointerMove = (e: PointerEvent) => {
      moveBrushHover(e);
      if (e.pointerId !== strokePointer) return;
      e.stopImmediatePropagation();
      pendingPoint = { x: e.clientX, y: e.clientY };
      if (sampleFrame) return;
      sampleFrame = window.requestAnimationFrame(() => {
        sampleFrame = 0;
        if (strokePointer !== null && Math.hypot(pendingPoint.x - lastSample.x, pendingPoint.y - lastSample.y) >= 4) {
          sampleBrush(pendingPoint);
        }
      });
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId === strokePointer) {
        e.stopImmediatePropagation();
        if (e.clientX !== lastSample.x || e.clientY !== lastSample.y) {
          sampleBrush({ x: e.clientX, y: e.clientY });
        }
        if (strokePointer !== null) endStroke(true);
        return;
      }
      if (e.button !== 0 || e.altKey || shadowPaintRef.current?.enabled || lightPlacementRef.current?.active) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) <= 4) pickAt(e);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId === strokePointer) endStroke(false);
      clearBrushHover();
    };
    const onGestureWheel = (event: WheelEvent) => {
      if (strokePointer === null && !lightDrag) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const endLightDrag = () => {
      if (!lightDrag) return;
      const { pointer } = lightDrag;
      lightDrag = null;
      delete lightTarget.dataset.dragging;
      if (lightTarget.hasPointerCapture(pointer)) lightTarget.releasePointerCapture(pointer);
    };
    const onLightDown = (event: PointerEvent) => {
      const placement = lightPlacementRef.current;
      if (event.button !== 0 || !placement?.active || lightDrag || orbitActive || strokePointer !== null) return;
      event.preventDefault();
      lightTarget.focus({ preventScroll: true });
      clearBrushHover();
      lightTarget.setPointerCapture(event.pointerId);
      lightTarget.dataset.dragging = '';
      lightDrag = {
        pointer: event.pointerId, x: event.clientX, y: event.clientY, direction: placement.direction,
        rotation: camera.getWorldQuaternion(new THREE.Quaternion()), height: canvas.clientHeight,
        lastX: event.clientX, lastY: event.clientY,
      };
    };
    const onLightMove = (event: PointerEvent) => {
      const placement = lightPlacementRef.current;
      const drag = lightDrag;
      if (!placement?.active || drag?.pointer !== event.pointerId ||
          (drag.lastX === event.clientX && drag.lastY === event.clientY)) return;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      placement.onDirection(dragLightDirection(drag.direction, drag.rotation,
        event.clientX - drag.x, event.clientY - drag.y, drag.height));
    };
    const onLightUp = (event: PointerEvent) => {
      if (lightDrag?.pointer !== event.pointerId) return;
      onLightMove(event);
      endLightDrag();
    };
    const onLightCancel = (event: PointerEvent) => {
      if (lightDrag?.pointer === event.pointerId) endLightDrag();
    };
    const onLightKey = (event: KeyboardEvent) => {
      const placement = lightPlacementRef.current;
      if (!placement?.active || lightDrag || orbitActive) return;
      const x = Number(event.key === 'ArrowRight') - Number(event.key === 'ArrowLeft');
      const y = Number(event.key === 'ArrowDown') - Number(event.key === 'ArrowUp');
      if (!x && !y) return;
      event.preventDefault();
      const step = (event.shiftKey ? 10 : 3) * Math.max(180, canvas.clientHeight) / 180;
      placement.onDirection(dragLightDirection(placement.direction, camera.getWorldQuaternion(new THREE.Quaternion()),
        x * step, y * step, canvas.clientHeight));
    };
    canvas.addEventListener('pointerdown', onPointerDown, true);
    canvas.addEventListener('pointermove', onPointerMove, true);
    canvas.addEventListener('pointerup', onPointerUp, true);
    canvas.addEventListener('pointercancel', onPointerCancel, true);
    canvas.addEventListener('lostpointercapture', onPointerCancel);
    canvas.addEventListener('pointerleave', clearBrushHover);
    container.addEventListener('wheel', onGestureWheel, { capture: true, passive: false });
    lightTarget.addEventListener('pointerdown', onLightDown);
    lightTarget.addEventListener('pointermove', onLightMove);
    lightTarget.addEventListener('pointerup', onLightUp);
    lightTarget.addEventListener('pointercancel', onLightCancel);
    lightTarget.addEventListener('lostpointercapture', onLightCancel);
    lightTarget.addEventListener('keydown', onLightKey);

    const resizeObserver = new ResizeObserver(() => {
      if (strokePointer !== null) endStroke(false);
      endLightDrag();
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      setCompanionView((view) => ({ moving: view.moving }));
    });
    resizeObserver.observe(container);

    let rafId = 0;
    const animate = () => {
      rafId = window.requestAnimationFrame(animate);
      if (!activeRef.current) return;
      const placement = lightPlacementRef.current;
      if (!placement?.active) endLightDrag();
      if (!lightDrag) controls.update();
      const bounds = activeModelRef.current?.bounds;
      lightHandle.visible = lightLine.visible = false;
      if (placement?.active && bounds && surfaceGroup.visible) {
        if (placement.cameraRequest !== null && placement.cameraRequest !== handledCameraRequest.current) {
          handledCameraRequest.current = placement.cameraRequest;
          placement.onDirection(camera.getWorldDirection(lightPosition).negate().toArray());
        }
        lightBounds.min.fromArray(bounds.min);
        lightBounds.max.fromArray(bounds.max);
        const radius = Math.max(.5, lightBounds.getSize(lightPosition).length() * .5);
        surfaceGroup.localToWorld(lightBounds.getCenter(lightCenter));

        camera.updateMatrixWorld();
        const projectionScale = camera.projectionMatrix.elements[5];
        const centerDepth = -projectedLight.copy(lightCenter).applyMatrix4(camera.matrixWorldInverse).z;
        const viewHalfSize = Math.max(0, centerDepth) * Math.min(1, camera.aspect) / projectionScale;
        const armLength = Math.min(radius * .9, viewHalfSize * .75);
        lightHandle.position.copy(lightCenter).addScaledVector(lightPosition.fromArray(placement.direction), armLength);
        projectedLight.copy(lightHandle.position).applyMatrix4(camera.matrixWorldInverse);
        const depth = -projectedLight.z;
        const height = canvas.clientHeight;
        if (height > 0 && depth >= camera.near && depth <= camera.far) {
          projectedLight.applyMatrix4(camera.projectionMatrix);
          lightHandle.scale.setScalar(18 * depth / (height * projectionScale));
          lightTarget.style.left = `${(projectedLight.x + 1) * 50}%`;
          lightTarget.style.top = `${(1 - projectedLight.y) * 50}%`;
          lightHandle.visible = Math.abs(projectedLight.x) <= 1 && Math.abs(projectedLight.y) <= 1;
        }
        lightLine.visible = true;
        lightLinePoints.setXYZ(0, lightCenter.x, lightCenter.y, lightCenter.z);
        lightLinePoints.setXYZ(1, lightHandle.position.x, lightHandle.position.y, lightHandle.position.z);
        lightLinePoints.needsUpdate = true;
      }
      // Keep capture while the pointer leads the projected ball outside the viewport.
      lightTarget.hidden = !lightHandle.visible && !lightDrag;
      const surfaceDetail = detailGroup.visible ? 'original' : 'preview';
      if (canvas.dataset.surfaceDetail !== surfaceDetail) canvas.dataset.surfaceDetail = surfaceDetail;
      const paint = shadowPaintRef.current;
      brushPreview.update(renderer, paint?.enabled && detailGroup.visible ? hoverPoint : null, paint?.diameter ?? 1);
      previewHoveredFace();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      orbitLifecycle.dispose();
      canvas.removeEventListener('pointerdown', onPointerDown, true);
      canvas.removeEventListener('pointermove', onPointerMove, true);
      canvas.removeEventListener('pointerup', onPointerUp, true);
      canvas.removeEventListener('pointercancel', onPointerCancel, true);
      canvas.removeEventListener('lostpointercapture', onPointerCancel);
      canvas.removeEventListener('pointerleave', clearBrushHover);
      container.removeEventListener('wheel', onGestureWheel, true);
      endLightDrag();
      lightTarget.remove();
      if (strokePointer !== null) endStroke(false);
      brush.dispose();
      faceOutlineGeometry.dispose();
      faceOutlineMaterial.dispose();
      disposeGroupMeshes(previewGroup);
      disposeGroupMeshes(detailGroup);
      detailCacheRef.current.clear();
      detailTrianglesRef.current = 0;
      for (const layer of companions.values()) disposeCompanion(layer);
      companions.clear();
      lightHandle.geometry.dispose();
      lightHandle.material.dispose();
      lightLineGeometry.dispose();
      lightLineMaterial.dispose();
      marker.geometry.dispose();
      marker.material.dispose();
      grid.dispose();
      companionMaterial.dispose();
      stagedMaterial.dispose();
      material.dispose();
      previewMaterial.dispose();
      shadowMaterial.dispose();
      paintStyle.dispose();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRefs.current = null;
    };
  }, [disableWebGL]);

  useEffect(() => {
    sceneRefs.current?.setLightingVisible(showLighting);
  }, [showLighting, disableWebGL]);

  // Stage pendingModel batches in isolation; keep old geometry intact until atomic
  // native commit returns committed:true.
  useEffect(() => {
    if (!pendingModel || !api) return;
    let cancelled = false;

    const stagedPreviewGeos: THREE.BufferGeometry[] = [];
    const stagedDetailEntries: { batchIndex: number; triangleCount: number; faceIds: Uint32Array; geo: THREE.BufferGeometry }[] = [];

    const disposeStaged = () => {
      for (const g of stagedPreviewGeos) g.dispose();
      for (const e of stagedDetailEntries) e.geo.dispose();
    };

    const stageBatches = async () => {
      try {
        if (pendingModel.previewFilePath) {
          const previewBin = await api.readBatch(pendingModel.previewFilePath);
          if (cancelled) {
            disposeStaged();
            return;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(previewBin.positions, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(previewBin.normals, 3));
          stagedPreviewGeos.push(geo);
        }

        const center: Vec3 = [
          (pendingModel.bounds.min[0] + pendingModel.bounds.max[0]) * 0.5,
          (pendingModel.bounds.min[1] + pendingModel.bounds.max[1]) * 0.5,
          (pendingModel.bounds.min[2] + pendingModel.bounds.max[2]) * 0.5,
        ];
        const initialIndices = selectCameraVisibleBatchIndices(
          pendingModel.batches,
          [center[0], center[1], center[2] + 100],
          center,
          INITIAL_STAGE_BATCHES,
        );
        const batchByIndex = new Map(pendingModel.batches.map((b) => [b.batchIndex, b]));

        for (const idx of initialIndices) {
          const batch = batchByIndex.get(idx);
          if (!batch) continue;
          const bin = await api.readBatch(batch.filePath);
          if (cancelled) {
            disposeStaged();
            return;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(bin.positions, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(bin.normals, 3));
          stagedDetailEntries.push({ batchIndex: idx, triangleCount: bin.triangleCount, faceIds: bin.faceIds, geo });
        }

        const committed = await onCommitRef.current(pendingModel);
        if (cancelled || !committed) {
          disposeStaged();
          return;
        }

        ++modelGenRef.current;
        const refs = sceneRefs.current;
        if (refs) {
          ++streamGenerationRef.current;
          disposeGroupMeshes(refs.previewGroup);
          disposeGroupMeshes(refs.detailGroup);
          detailCacheRef.current.clear();
          detailTrianglesRef.current = 0;

          for (const geo of stagedPreviewGeos) {
            const preview = new THREE.Mesh(geo, refs.previewMaterial);
            preview.renderOrder = 2;
            refs.previewGroup.add(preview);
          }
          for (const entry of stagedDetailEntries) {
            const mesh = new THREE.Mesh(entry.geo, refs.material);
            refs.detailGroup.add(mesh);
            detailTrianglesRef.current += entry.triangleCount;
            detailCacheRef.current.set(entry.batchIndex, {
              mesh,
              triangleCount: entry.triangleCount,
              faceIds: entry.faceIds,
              lastUsed: ++lruTickRef.current,
            });
          }

          updateSettledLayerVisibility(refs, pendingModel);
          stagedPreviewGeos.length = 0;
          stagedDetailEntries.length = 0;
        } else {
          disposeStaged();
        }
      } catch (err) {
        disposeStaged();
        if (!cancelled) {
          onErrorRef.current(
            err instanceof Error ? err : new Error('Failed loading replacement geometry batches'),
          );
        }
      }
    };

    void stageBatches();
    return () => {
      cancelled = true;
      disposeStaged();
    };
  }, [api, pendingModel]);

  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !api) return;
    const wanted = new Set(companionParts?.map((part) => part.model.modelId));
    for (const [id, layer] of refs.companions) {
      if (wanted.has(id)) continue;
      refs.modelGroup.remove(layer.group);
      disposeCompanion(layer);
      refs.companions.delete(id);
    }

    refs.camera.updateMatrixWorld(true);
    const moving = companionView.moving;
    const coverage = shadowPaintRef.current?.companionCoverage;
    let stencilId = 1;
    const layers = (companionParts ?? []).map((part) => {
      const id = part.model.modelId;
      let layer = refs.companions.get(id);
      if (!layer) {
        layer = { group: new THREE.Group(), ghost: false, preview: null, batches: new Map() };
        refs.companions.set(id, layer);
        refs.modelGroup.add(layer.group);
      }
      const { group } = layer;
      group.visible = !part.hidden && (id !== model?.modelId || id === ghostModelId);
      group.position.fromArray(part.pose.translation);
      group.quaternion.fromArray(part.pose.rotation);
      group.updateWorldMatrix(true, false);
      layer.ghost = part.staged || id === ghostModelId;
      // Each dense part masks only its own simplified triangles. Other parts
      // still occlude it normally through the depth buffer.
      const mask = part.model.previewFilePath ? ++stencilId : 0;
      const useMask = !layer.ghost && mask > 0 && mask <= 255;
      if (useMask) {
        if (!layer.maskedMaterials) {
          const detail = refs.companionMaterial.clone();
          const preview = refs.companionMaterial.clone();
          attachSurfaceDetail(detail, refs.surfaceDetail);
          attachSurfaceDetail(preview, refs.surfaceDetail);
          layer.maskedMaterials = { detail, preview };
        }
        markExactSurface(layer.maskedMaterials.detail, mask);
        maskPreviewSurface(layer.maskedMaterials.preview, mask);
      }
      const material = layer.ghost ? refs.stagedMaterial : useMask ? layer.maskedMaterials!.detail : refs.companionMaterial;
      const previewMaterial = useMask ? layer.maskedMaterials!.preview : material;
      const visible = group.visible ? visiblePartBatches(refs.camera, group, part.model) : [];
      const desired = new Set<number>();
      const hasPaint = (index: number) => Boolean(coverage?.get(index + part.batchOffset)?.size);
      return { part, layer, visible, desired, material, previewMaterial, hasPaint };
    });

    // Small parts have no simplified fallback. Budget the original detail streamed
    // for dense parts across the assembly, rather than giving each part its own cache limit.
    const candidates = layers.flatMap((entry) => {
      const { layer, part, visible, desired } = entry;
      if (!part.model.previewFilePath) {
        for (const { batchIndex } of visible) desired.add(batchIndex);
        return [];
      }
      if (moving || layer.ghost) return [];
      const target = layer.group.worldToLocal(refs.controls.target.clone());
      const eye = layer.group.worldToLocal(refs.camera.position.clone());
      return visible.map((batch) => ({
        entry, batch,
        painted: entry.hasPaint(batch.batchIndex),
        distance: distanceSqToBounds(target, batch.bounds) + 0.25 * distanceSqToBounds(eye, batch.bounds),
      }));
    }).sort((a, b) => Number(b.painted) - Number(a.painted) || a.distance - b.distance);
    let triangles = 0;
    let count = 0;
    for (const { entry, batch, painted } of candidates) {
      if (!painted && (count >= MAX_DETAIL_BATCHES || triangles + batch.triangleCount > MAX_COMPANION_DETAIL_TRIANGLES)) continue;
      triangles += batch.triangleCount;
      count++;
      entry.desired.add(batch.batchIndex);
    }

    let canceled = false;
    const previews: (() => Promise<void>)[] = [];
    const paintedDetails: (() => Promise<void>)[] = [];
    const details: (() => Promise<void>)[] = [];
    for (const { part, layer, visible, desired, material, previewMaterial, hasPaint } of layers) {
      const { group, batches } = layer;
      const previewPath = part.model.previewFilePath;
      const refreshPreview = () => {
        if (layer.preview) layer.preview.visible = moving || visible.some(({ batchIndex }) => !batches.has(batchIndex));
      };
      for (const [index, { mesh, faceIds }] of batches) {
        if (moving || desired.has(index)) {
          mesh.material = material;
          mesh.visible = !moving || !layer.preview || hasPaint(index);
          applyShadow(mesh, index, faceIds, part, !layer.ghost);
        } else {
          group.remove(mesh);
          disposeDetailMesh(mesh);
          batches.delete(index);
        }
      }
      if (layer.preview && !moving && visible.length === 0) {
        group.remove(layer.preview);
        disposeDetailMesh(layer.preview);
        layer.preview = null;
      }
      if (layer.preview) {
        layer.preview.material = previewMaterial;
        refreshPreview();
      }

      async function loadMesh(filePath: string) {
        if (!api || canceled) return;
        try {
          const bin = await api.readBatch(filePath);
          if (canceled) return;
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(bin.positions, 3));
          geometry.setAttribute('normal', new THREE.BufferAttribute(bin.normals, 3));
          return { mesh: new THREE.Mesh(geometry, material), faceIds: bin.faceIds };
        } catch (error) {
          if (!canceled) onPickNeedsDetailRef.current?.(error instanceof Error ? error.message : 'Could not display a kit part.');
        }
      }
      if (previewPath && visible.length && !layer.preview) {
        previews.push(async () => {
          const preview = await loadMesh(previewPath);
          if (!preview) return;
          layer.preview = preview.mesh;
          preview.mesh.material = previewMaterial;
          preview.mesh.renderOrder = 2;
          group.add(preview.mesh);
          if (moving) {
            for (const [index, { mesh }] of batches) mesh.visible = hasPaint(index);
          }
          refreshPreview();
        });
      }
      for (const { batchIndex, filePath } of visible) {
        if (!desired.has(batchIndex) || batches.has(batchIndex)) continue;
        (hasPaint(batchIndex) ? paintedDetails : details).push(async () => {
          const entry = await loadMesh(filePath);
          if (!entry) return;
          applyShadow(entry.mesh, batchIndex, entry.faceIds, part, !layer.ghost);
          group.add(entry.mesh);
          batches.set(batchIndex, entry);
          refreshPreview();
        });
      }
    }
    async function stream(queue: (() => Promise<void>)[]) {
      for (let offset = 0; offset < queue.length && !canceled; offset += DETAIL_STREAM_CONCURRENCY) {
        await Promise.all(queue.slice(offset, offset + DETAIL_STREAM_CONCURRENCY).map((load) => load()));
      }
    }
    void stream(previews).then(() => stream(paintedDetails)).then(() => stream(details));
    return () => { canceled = true; };
  }, [api, model?.modelId, companionParts, ghostModelId, companionView, disableWebGL, paintedCompanionBatches]);

  useEffect(() => {
    const refs = sceneRefs.current;
    for (const part of companionParts ?? []) {
      const layer = refs?.companions.get(part.model.modelId);
      if (!layer) continue;
      for (const [index, { mesh, faceIds }] of layer.batches) {
        applyShadow(mesh, index, faceIds, part, !layer.ghost);
      }
    }
  }, [companionParts, shadowPaint?.companionCoverage, shadowPaint?.baseCoverage, previewScores]);
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    refs.surfaceGroup.position.fromArray(focusPose.translation);
    refs.surfaceGroup.quaternion.fromArray(focusPose.rotation);
    refs.surfaceGroup.visible = !hideFocused;
    refs.modelGroup.updateMatrixWorld(true);
  }, [focusPose, hideFocused]);

  const frameBounds = fitBounds ?? model?.bounds;
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    refs.marker.visible = Boolean(jointMarker);
    if (jointMarker) {
      refs.marker.position.fromArray(jointMarker);
      refs.marker.scale.setScalar(refs.radius * 0.016);
    }
  }, [jointMarker, frameBounds]);
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !frameBounds) return;

    ++viewGenRef.current;
    onViewChangeRef.current?.();

    const q = computeOrientationQuaternion(orientation.upright, orientation.front);
    refs.modelGroup.quaternion.copy(q);

    const min = new THREE.Vector3(...frameBounds.min);
    const max = new THREE.Vector3(...frameBounds.max);
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    const radius = Math.max(0.5, size.length() * 0.5);
    refs.radius = radius;

    const rotatedCenter = center.clone().applyQuaternion(q);
    refs.modelGroup.position.set(-rotatedCenter.x, -rotatedCenter.y + radius * 0.5, -rotatedCenter.z);
    refs.modelGroup.updateMatrixWorld(true);
    const floor = new THREE.Box3(min, max).applyMatrix4(refs.modelGroup.matrixWorld).min.y;
    refs.grid.position.y = floor - radius * 0.012;

    refs.controls.target.set(0, radius * 0.5, 0);
    refs.camera.position.set(radius * 1.4, radius * 1.1, radius * 2.2);
    refs.camera.near = Math.max(0.01, radius * 0.005);
    refs.camera.far = Math.max(500, radius * 40);
    refs.camera.updateProjectionMatrix();
    refs.controls.update();
    refs.orbitLifecycle.syncRestSnapshot();
    setCompanionView({ moving: false });

  }, [frameBounds, orientation]);

  useEffect(() => {
    if (model) void streamForCurrentCamera(model);
  }, [model, frameBounds, orientation, focusPose]);

  // Camera view presets
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !cameraPresetRequest) return;
    ++viewGenRef.current;
    onViewChangeRef.current?.();

    const r = refs.radius;
    const targetY = r * 0.5;
    const approach = refs.camera.position.clone().sub(refs.controls.target).normalize();
    refs.controls.target.set(0, targetY, 0);
    switch (cameraPresetRequest.preset) {
      case 'focus': {
        if (!model) break;
        const bounds = new THREE.Box3(new THREE.Vector3(...model.bounds.min), new THREE.Vector3(...model.bounds.max));
        const target = refs.surfaceGroup.localToWorld(bounds.getCenter(new THREE.Vector3()));
        const radius = Math.max(0.5, bounds.getSize(new THREE.Vector3()).length() * 0.5);
        refs.controls.target.copy(target);
        refs.camera.position.copy(target).addScaledVector(approach, radius * 2.4);
        break;
      }
      case 'front':
        refs.camera.position.set(0, targetY, r * 2.4);
        break;
      case 'back':
        refs.camera.position.set(0, targetY, -r * 2.4);
        break;
      case 'top':
        refs.camera.position.set(0, targetY + r * 2.4, 0.01);
        break;
      case 'bottom':
        refs.camera.position.set(0, targetY - r * 2.4, 0.01);
        break;
      case 'left':
        refs.camera.position.set(-r * 2.4, targetY, 0);
        break;
      case 'right':
        refs.camera.position.set(r * 2.4, targetY, 0);
        break;
      case 'reset':
      default:
        refs.camera.position.set(r * 1.4, r * 1.1, r * 2.2);
        break;
    }
    refs.controls.update();
    refs.camera.updateMatrixWorld(true);
    refs.orbitLifecycle.syncRestSnapshot();
    setCompanionView({ moving: false });
    if (model) {
      void streamForCurrentCamera(model);
    }
  }, [cameraPresetRequest, model]);

  return (
    <div
      ref={containerRef}
      className="viewport-canvas"
      data-painting-enabled={shadowPaint?.enabled || undefined}
      data-testid="viewport-canvas"
      aria-label="3D miniature viewport"
    />
  );
}
