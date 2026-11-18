import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  BatchDescriptor,
  ModelOrientation,
  ModelSummary,
  PaintPalletApi,
  Vec3,
} from '../../shared/workerProtocol';
import { computeOrientationQuaternion } from '../orientation';

export type CameraPreset = 'reset' | 'front' | 'top' | 'right';

export interface PickGenerationToken {
  modelId: string;
  modelGen: number;
  viewGen: number;
}

export interface Viewport3DProps {
  api?: PaintPalletApi;
  model: ModelSummary | null;
  pendingModel: ModelSummary | null;
  orientation: ModelOrientation;
  cameraPresetRequest: { preset: CameraPreset; seq: number } | null;
  onSurfacePick: (
    origin: Vec3,
    direction: Vec3,
    batchIndices: number[],
    token: PickGenerationToken,
  ) => void;
  onPickNeedsDetail?: (message: string) => void;
  onViewChange?: () => void;
  onPendingModelCommit: (committed: ModelSummary) => Promise<boolean> | boolean;
  onPendingModelError: (error: Error) => void;
  disableWebGL?: boolean;
}

export const MAX_DETAIL_BATCHES = 16;

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
    child.geometry.dispose();
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

  const onChange = () => {
    const camMoved =
      camera.position.distanceToSquared(startCamPos) > 1e-10 ||
      controls.target.distanceToSquared(startTarget) > 1e-10;
    if (!camMoved) return;

    if (!movedThisGesture) {
      movedThisGesture = true;
      callbacks.onCameraMoved();
      if (previewGroup.children.length > 0) {
        previewGroup.visible = true;
        detailGroup.visible = false;
      }
    }
    syncRestSnapshot();
  };

  const onEnd = () => {
    interacting = false;
    if (!movedThisGesture && detailGroup.visible) {
      return;
    }
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      if (!interacting) {
        callbacks.onCameraSettled();
      }
    }, settleDelayMs);
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
  orientation,
  cameraPresetRequest,
  onSurfacePick,
  onPickNeedsDetail,
  onViewChange,
  onPendingModelCommit,
  onPendingModelError,
  disableWebGL = false,
}: Viewport3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onPickRef = useRef(onSurfacePick);
  onPickRef.current = onSurfacePick;
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

  const detailCacheRef = useRef<Map<number, { mesh: THREE.Mesh; lastUsed: number }>>(new Map());
  const lruTickRef = useRef(0);
  const streamGenerationRef = useRef(0);
  const modelGenRef = useRef(0);
  const viewGenRef = useRef(0);

  const sceneRefs = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    orbitLifecycle: ReturnType<typeof attachOrbitDetailLifecycle>;
    renderer: THREE.WebGLRenderer;
    modelGroup: THREE.Group;
    previewGroup: THREE.Group;
    detailGroup: THREE.Group;
    material: THREE.MeshStandardMaterial;
    radius: number;
  } | null>(null);

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

    for (const idx of desiredIndices) {
      const existing = cache.get(idx);
      if (existing) {
        existing.lastUsed = ++lruTickRef.current;
      }
    }

    for (const idx of desiredIndices) {
      if (streamGenerationRef.current !== generation) return;
      if (cache.has(idx)) continue;
      const desc = batchByIndex.get(idx);
      if (!desc) continue;

      const bin = await currentApi.readBatch(desc.filePath);
      if (streamGenerationRef.current !== generation) return;

      while (cache.size >= MAX_DETAIL_BATCHES) {
        let victimKey: number | null = null;
        let oldestTick = Infinity;
        for (const [k, entry] of cache.entries()) {
          if (entry.lastUsed < oldestTick) {
            oldestTick = entry.lastUsed;
            victimKey = k;
          }
        }
        if (victimKey === null) break;
        const victim = cache.get(victimKey)!;
        refs.detailGroup.remove(victim.mesh);
        victim.mesh.geometry.dispose();
        cache.delete(victimKey);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(bin.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(bin.normals, 3));
      const mesh = new THREE.Mesh(geo, refs.material);
      refs.detailGroup.add(mesh);
      cache.set(idx, { mesh, lastUsed: ++lruTickRef.current });
    }
  };

  const streamForCurrentCamera = async (targetModel: ModelSummary) => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const gen = ++streamGenerationRef.current;
    refs.modelGroup.updateMatrixWorld(true);
    const invMat = new THREE.Matrix4().copy(refs.modelGroup.matrixWorld).invert();
    const camLocal = refs.camera.position.clone().applyMatrix4(invMat);
    const tgtLocal = refs.controls.target.clone().applyMatrix4(invMat);

    const desired = selectCameraVisibleBatchIndices(
      targetModel.batches,
      [camLocal.x, camLocal.y, camLocal.z],
      [tgtLocal.x, tgtLocal.y, tgtLocal.z],
      MAX_DETAIL_BATCHES,
    );
    await ensureDetailBatchesLoaded(targetModel, desired, gen);
    if (streamGenerationRef.current === gen && refs.detailGroup.children.length > 0) {
      // Keep whole-model overview available when model exceeds detail budget,
      // and enable detailGroup for original-triangle picking.
      refs.previewGroup.visible =
        targetModel.batches.length > MAX_DETAIL_BATCHES && refs.previewGroup.children.length > 0;
      refs.detailGroup.visible = true;
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || disableWebGL) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
    renderer.setClearColor(0x0b160c, 1);
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
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
    keyLight.position.set(2.5, 4, 3);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xc6f19d, 0.45);
    rimLight.position.set(-3, 2, -2.5);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(4, 16, 0x2f4d31, 0x1b311d);
    scene.add(grid);

    const material = new THREE.MeshStandardMaterial({
      color: 0xd4d9d2,
      roughness: 0.62,
      metalness: 0.08,
    });

    const modelGroup = new THREE.Group();
    const previewGroup = new THREE.Group();
    const detailGroup = new THREE.Group();
    modelGroup.add(previewGroup);
    modelGroup.add(detailGroup);
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
          onViewChangeRef.current?.();
        },
        onCameraSettled: () => {
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
      modelGroup,
      previewGroup,
      detailGroup,
      material,
      radius: 1,
    };

    let downX = 0;
    let downY = 0;
    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (dist > 4) return;
      const currentModel = activeModelRef.current;
      if (!currentModel) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      camera.updateMatrixWorld(true);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);

      modelGroup.updateMatrixWorld(true);
      const invMat = new THREE.Matrix4().copy(modelGroup.matrixWorld).invert();
      const localRay = raycaster.ray.clone().applyMatrix4(invMat);
      localRay.direction.normalize();

      const orig: Vec3 = [localRay.origin.x, localRay.origin.y, localRay.origin.z];
      const dir: Vec3 = [localRay.direction.x, localRay.direction.y, localRay.direction.z];
      const rayBatches = findRayIntersectingBatchIndices(currentModel.batches, orig, dir);

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
          if (streamGenerationRef.current === gen) {
            previewGroup.visible =
              currentModel.batches.length > MAX_DETAIL_BATCHES &&
              previewGroup.children.length > 0;
            detailGroup.visible = true;
          }
        });
        onPickNeedsDetailRef.current?.(
          'Loading original detail for clicked region; click again to pick face.',
        );
        return;
      }

      // Frame remains unchanged; capture visible batch IDs and generations synchronously before async pick
      onPickRef.current(orig, dir, resolution.visibleBatchIds, {
        modelId: currentModel.modelId,
        modelGen: modelGenRef.current,
        viewGen: viewGenRef.current,
      });
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    let rafId = 0;
    const animate = () => {
      rafId = window.requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      orbitLifecycle.dispose();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      disposeGroupMeshes(previewGroup);
      disposeGroupMeshes(detailGroup);
      detailCacheRef.current.clear();
      material.dispose();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRefs.current = null;
    };
  }, [disableWebGL]);

  // Stage pendingModel batches in isolation; keep old geometry intact until atomic
  // native commit returns committed:true.
  useEffect(() => {
    if (!pendingModel || !api) return;
    let cancelled = false;

    const stagedPreviewGeos: THREE.BufferGeometry[] = [];
    const stagedDetailEntries: { batchIndex: number; geo: THREE.BufferGeometry }[] = [];

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
          MAX_DETAIL_BATCHES,
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
          stagedDetailEntries.push({ batchIndex: idx, geo });
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

          for (const geo of stagedPreviewGeos) {
            refs.previewGroup.add(new THREE.Mesh(geo, refs.material));
          }
          for (const entry of stagedDetailEntries) {
            const mesh = new THREE.Mesh(entry.geo, refs.material);
            refs.detailGroup.add(mesh);
            detailCacheRef.current.set(entry.batchIndex, {
              mesh,
              lastUsed: ++lruTickRef.current,
            });
          }

          refs.previewGroup.visible =
            pendingModel.batches.length > MAX_DETAIL_BATCHES &&
            refs.previewGroup.children.length > 0;
          refs.detailGroup.visible = true;
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

  // Apply upright & front orientation and fit camera for the committed model
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !model) return;

    ++viewGenRef.current;
    onViewChangeRef.current?.();

    const q = computeOrientationQuaternion(orientation.upright, orientation.front);
    refs.modelGroup.quaternion.copy(q);

    const min = new THREE.Vector3(...model.bounds.min);
    const max = new THREE.Vector3(...model.bounds.max);
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    const radius = Math.max(0.5, size.length() * 0.5);
    refs.radius = radius;

    const rotatedCenter = center.clone().applyQuaternion(q);
    refs.modelGroup.position.set(-rotatedCenter.x, -rotatedCenter.y + radius * 0.5, -rotatedCenter.z);
    refs.modelGroup.updateMatrixWorld(true);

    refs.controls.target.set(0, radius * 0.5, 0);
    refs.camera.position.set(radius * 1.4, radius * 1.1, radius * 2.2);
    refs.camera.near = Math.max(0.01, radius * 0.005);
    refs.camera.far = Math.max(500, radius * 40);
    refs.camera.updateProjectionMatrix();
    refs.controls.update();
    refs.orbitLifecycle.syncRestSnapshot();

    void streamForCurrentCamera(model);
  }, [model, orientation]);

  // Camera view presets
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !cameraPresetRequest) return;
    ++viewGenRef.current;
    onViewChangeRef.current?.();

    const r = refs.radius;
    const targetY = r * 0.5;
    refs.controls.target.set(0, targetY, 0);
    switch (cameraPresetRequest.preset) {
      case 'front':
        refs.camera.position.set(0, targetY, r * 2.4);
        break;
      case 'top':
        refs.camera.position.set(0, targetY + r * 2.4, 0.01);
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
    if (model) {
      void streamForCurrentCamera(model);
    }
  }, [cameraPresetRequest, model]);

  return (
    <div
      ref={containerRef}
      className="viewport-canvas"
      data-testid="viewport-canvas"
      aria-label="3D miniature viewport"
    />
  );
}
