import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  ModelOrientation,
  ModelSummary,
  PaintPalletApi,
  Vec3,
} from '../../shared/workerProtocol';
import { computeOrientationQuaternion } from '../orientation';

export type CameraPreset = 'reset' | 'front' | 'top' | 'right';

export interface Viewport3DProps {
  api?: PaintPalletApi;
  model: ModelSummary | null;
  pendingModel: ModelSummary | null;
  orientation: ModelOrientation;
  cameraPresetRequest: { preset: CameraPreset; seq: number } | null;
  onSurfacePick: (origin: Vec3, direction: Vec3) => void;
  onPendingModelCommit: (committed: ModelSummary) => void;
  onPendingModelError: (error: Error) => void;
  disableWebGL?: boolean;
}

const MAX_DETAIL_BATCHES = 16;

function selectBoundedBatches(model: ModelSummary) {
  const modelCenter = new THREE.Vector3(
    (model.bounds.min[0] + model.bounds.max[0]) * 0.5,
    (model.bounds.min[1] + model.bounds.max[1]) * 0.5,
    (model.bounds.min[2] + model.bounds.max[2]) * 0.5,
  );
  return [...model.batches]
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
      return ac.distanceToSquared(modelCenter) - bc.distanceToSquared(modelCenter);
    })
    .slice(0, MAX_DETAIL_BATCHES);
}

function disposeGroupMeshes(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0] as THREE.Mesh;
    group.remove(child);
    child.geometry.dispose();
  }
}

export function Viewport3D({
  api,
  model,
  pendingModel,
  orientation,
  cameraPresetRequest,
  onSurfacePick,
  onPendingModelCommit,
  onPendingModelError,
  disableWebGL = false,
}: Viewport3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onPickRef = useRef(onSurfacePick);
  onPickRef.current = onSurfacePick;
  const onCommitRef = useRef(onPendingModelCommit);
  onCommitRef.current = onPendingModelCommit;
  const onErrorRef = useRef(onPendingModelError);
  onErrorRef.current = onPendingModelError;

  const sceneRefs = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    renderer: THREE.WebGLRenderer;
    modelGroup: THREE.Group;
    previewGroup: THREE.Group;
    detailGroup: THREE.Group;
    radius: number;
  } | null>(null);

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

    const modelGroup = new THREE.Group();
    const previewGroup = new THREE.Group();
    const detailGroup = new THREE.Group();
    modelGroup.add(previewGroup);
    modelGroup.add(detailGroup);
    scene.add(modelGroup);

    sceneRefs.current = {
      scene,
      camera,
      controls,
      renderer,
      modelGroup,
      previewGroup,
      detailGroup,
      radius: 1,
    };

    let settleTimer: number | null = null;
    const onControlStart = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (previewGroup.children.length > 0) {
        previewGroup.visible = true;
        detailGroup.visible = false;
      }
    };
    const onControlEnd = () => {
      if (previewGroup.children.length > 0 && detailGroup.children.length > 0) {
        settleTimer = window.setTimeout(() => {
          previewGroup.visible = false;
          detailGroup.visible = true;
        }, 120);
      }
    };
    controls.addEventListener('start', onControlStart);
    controls.addEventListener('end', onControlEnd);

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
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);

      modelGroup.updateMatrixWorld(true);
      const invMat = new THREE.Matrix4().copy(modelGroup.matrixWorld).invert();
      const localRay = raycaster.ray.clone().applyMatrix4(invMat);
      localRay.direction.normalize();

      onPickRef.current(
        [localRay.origin.x, localRay.origin.y, localRay.origin.z],
        [localRay.direction.x, localRay.direction.y, localRay.direction.z],
      );
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
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      resizeObserver.disconnect();
      controls.removeEventListener('start', onControlStart);
      controls.removeEventListener('end', onControlEnd);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRefs.current = null;
    };
  }, [disableWebGL]);

  // Stage pendingModel batches in isolation; keep previous committed model intact until
  // replacement geometry opens and mounts cleanly.
  useEffect(() => {
    if (!pendingModel || !api) return;
    let cancelled = false;

    const stagedPreviewGeos: THREE.BufferGeometry[] = [];
    const stagedDetailGeos: THREE.BufferGeometry[] = [];

    const stageBatches = async () => {
      try {
        if (pendingModel.previewFilePath) {
          const previewBin = await api.readBatch(pendingModel.previewFilePath);
          if (cancelled) return;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(previewBin.positions, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(previewBin.normals, 3));
          stagedPreviewGeos.push(geo);
        }

        const boundedBatches = selectBoundedBatches(pendingModel);
        for (const batch of boundedBatches) {
          const bin = await api.readBatch(batch.filePath);
          if (cancelled) return;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(bin.positions, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(bin.normals, 3));
          stagedDetailGeos.push(geo);
        }

        const refs = sceneRefs.current;
        if (refs) {
          const mat = new THREE.MeshStandardMaterial({
            color: 0xd4d9d2,
            roughness: 0.62,
            metalness: 0.08,
          });
          disposeGroupMeshes(refs.previewGroup);
          disposeGroupMeshes(refs.detailGroup);

          for (const geo of stagedPreviewGeos) {
            refs.previewGroup.add(new THREE.Mesh(geo, mat));
          }
          for (const geo of stagedDetailGeos) {
            refs.detailGroup.add(new THREE.Mesh(geo, mat));
          }

          if (pendingModel.batches.length <= MAX_DETAIL_BATCHES || !pendingModel.previewFilePath) {
            refs.previewGroup.visible = false;
            refs.detailGroup.visible = true;
          } else {
            refs.previewGroup.visible = true;
            refs.detailGroup.visible = false;
          }
        } else {
          for (const g of stagedPreviewGeos) g.dispose();
          for (const g of stagedDetailGeos) g.dispose();
        }

        onCommitRef.current(pendingModel);
      } catch (err) {
        for (const g of stagedPreviewGeos) g.dispose();
        for (const g of stagedDetailGeos) g.dispose();
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
      for (const g of stagedPreviewGeos) g.dispose();
      for (const g of stagedDetailGeos) g.dispose();
    };
  }, [api, pendingModel]);

  // Apply upright & front orientation and fit camera for the committed model
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !model) return;

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
  }, [model, orientation]);

  // Camera view presets
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !cameraPresetRequest) return;
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
  }, [cameraPresetRequest]);

  return (
    <div
      ref={containerRef}
      className="viewport-canvas"
      data-testid="viewport-canvas"
      aria-label="3D miniature viewport"
    />
  );
}
