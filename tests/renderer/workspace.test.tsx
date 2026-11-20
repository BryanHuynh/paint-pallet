// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import App from '../../src/renderer/App';
import {
  attachOrbitDetailLifecycle,
  findRayIntersectingBatchIndices,
  resolveClickAgainstVisibleDetail,
  selectCameraVisibleBatchIndices,
  visiblePartBatches,
} from '../../src/renderer/components/Viewport3D';
import { computeOrientationQuaternion } from '../../src/renderer/orientation';
import type { ModelSummary, PaintPalletApi } from '../../src/shared/workerProtocol';

function createMockApi(overrides: Partial<PaintPalletApi> = {}): PaintPalletApi {
  return {
    selectStlFile: vi.fn().mockResolvedValue('C:/models/test_mini.stl'),
    importStl: vi.fn().mockResolvedValue({
      modelId: 'model_1',
      partId: 'part_0',
      fileName: 'test_mini.stl',
      fileSizeBytes: 1024,
      triangleCount: 4200,
      bounds: { min: [-10, 0, -10], max: [10, 32, 10] },
      batches: [
        { batchIndex: 0, filePath: 'batch_0000.bin', triangleCount: 4200, bounds: { min: [-10, 0, -10], max: [10, 32, 10] } },
      ],
      previewFilePath: null,
    } satisfies ModelSummary),
    cancelImport: vi.fn().mockResolvedValue({ canceled: true }),
    getActiveModel: vi.fn().mockResolvedValue(null),
    readBatch: vi.fn().mockResolvedValue({
      triangleCount: 0,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      faceIds: new Uint32Array(0),
    }),
    pickFace: vi.fn().mockResolvedValue({
      hit: false,
      partId: null,
      originalFaceId: null,
      distance: null,
      point: null,
      normal: null,
    }),
    onImportProgress: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

describe('UI import-orbit-orientation actions', () => {
  afterEach(() => {
    cleanup();
  });

  it('imports an STL via Open model and displays model stats', async () => {
    const api = createMockApi();
    render(<App api={api} disableWebGL />);

    const openBtn = screen.getByRole('button', { name: /open model/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(api.selectStlFile).toHaveBeenCalledTimes(1);
      expect(api.importStl).toHaveBeenCalledWith('C:/models/test_mini.stl');
    });

    expect(await screen.findByText('test_mini.stl')).toBeInTheDocument();
    expect(screen.getByText('4,200')).toBeInTheDocument();
  });

  it('imports a dropped STL through the model pipeline and ignores a second drop while busy', async () => {
    const api = createMockApi();
    const importDroppedStl = vi.fn(() => api.importStl('C:/models/test_mini.stl'));
    api.importDroppedStl = importDroppedStl;
    render(<App api={api} disableWebGL />);

    const viewport = screen.getByRole('region', { name: /stl surface viewport/i });
    const file = new File(['mesh'], 'test_mini.STL');
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' };
    fireEvent.dragOver(viewport, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(screen.getByText('Drop model to open')).toBeInTheDocument();

    fireEvent.drop(viewport, { dataTransfer });
    fireEvent.drop(viewport, { dataTransfer });

    expect(await screen.findByText('test_mini.stl')).toBeInTheDocument();
    expect(importDroppedStl).toHaveBeenCalledExactlyOnceWith(file);
    expect(api.importStl).toHaveBeenCalledExactlyOnceWith('C:/models/test_mini.stl');
    expect(api.selectStlFile).not.toHaveBeenCalled();
    expect(screen.queryByText('Drop model to open')).not.toBeInTheDocument();
  });

  it('rejects a non-STL or multiple dropped files before asking Electron for a path', async () => {
    const importDroppedStl = vi.fn();
    const api = createMockApi({ importDroppedStl });
    render(<App api={api} disableWebGL />);

    const viewport = screen.getByRole('region', { name: /stl surface viewport/i });
    const stl = new File(['mesh'], 'mini.stl');
    const png = new File(['image'], 'reference.png');
    for (const files of [[png], [stl, stl]]) {
      fireEvent.drop(viewport, { dataTransfer: { types: ['Files'], files } });
      expect(await screen.findByRole('alert')).toHaveTextContent('Drop one .stl or .obj file at a time.');
    }
    expect(importDroppedStl).not.toHaveBeenCalled();
    expect(api.importStl).not.toHaveBeenCalled();
  });

  it('keeps the previous model open when a subsequent import fails or is canceled', async () => {
    const selectStlFile = vi
      .fn()
      .mockResolvedValueOnce('C:/models/first.stl')
      .mockResolvedValueOnce('C:/models/broken.stl');
    const importStl = vi
      .fn()
      .mockResolvedValueOnce({
        modelId: 'model_first',
        partId: 'part_0',
        fileName: 'first.stl',
        fileSizeBytes: 512,
        triangleCount: 120,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        batches: [],
        previewFilePath: null,
      } satisfies ModelSummary)
      .mockRejectedValueOnce(new Error('Truncated or malformed binary STL'));

    const api = createMockApi({ selectStlFile, importStl });
    render(<App api={api} disableWebGL />);

    fireEvent.click(screen.getByRole('button', { name: /open model/i }));
    expect(await screen.findByText('first.stl')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open model/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Truncated or malformed/i);
    expect(screen.getByText('first.stl')).toBeInTheDocument();
  });

  it('updates upright and front orientation and aligns local axes to world +Y and +Z', async () => {
    const onOrientationChange = vi.fn();
    const api = createMockApi();
    render(<App api={api} disableWebGL onOrientationChange={onOrientationChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open model' }));
    const uprightSelect = await screen.findByLabelText(/upright axis/i);
    const frontSelect = screen.getByLabelText(/front axis/i);

    fireEvent.change(uprightSelect, { target: { value: '+Z' } });
    expect(onOrientationChange).toHaveBeenLastCalledWith({ upright: '+Z', front: '+Y' });

    fireEvent.change(frontSelect, { target: { value: '-Y' } });
    expect(onOrientationChange).toHaveBeenLastCalledWith({ upright: '+Z', front: '-Y' });

    const q = computeOrientationQuaternion('+Z', '-Y');
    const mappedUp = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const mappedFront = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
    expect(mappedUp.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-5);
    expect(mappedFront.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-5);
  });

  it('mounts an independently built PaletteWorkspace component and keeps it mounted while hidden', () => {
    function MockPaletteIntegration() {
      const [count, setCount] = React.useState(0);
      return (
        <div data-testid="palette-integration-root">
          <button type="button" onClick={() => setCount((c) => c + 1)}>
            Palette count: {count}
          </button>
        </div>
      );
    }

    const api = createMockApi();
    render(
      <App
        api={api}
        disableWebGL
        PaletteWorkspaceComponent={MockPaletteIntegration}
      />,
    );

    const paletteTab = screen.getByRole('tab', { name: /palette/i });
    fireEvent.click(paletteTab);

    const paletteBtn = screen.getByRole('button', { name: /palette count: 0/i });
    fireEvent.click(paletteBtn);
    expect(screen.getByRole('button', { name: /palette count: 1/i })).toBeInTheDocument();

    const modelTab = screen.getByRole('tab', { name: /model/i });
    fireEvent.click(modelTab);
    expect(screen.getByTestId('palette-host')).toHaveAttribute('hidden');
    expect(screen.getByTestId('viewport-canvas')).toBeInTheDocument();

    fireEvent.click(paletteTab);
    expect(screen.getByTestId('palette-host')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: /palette count: 1/i })).toBeInTheDocument();
  });

  it('mounts the real PaletteWorkspace in the palette outlet and preserves recipe state across tab switches', () => {
    const api = createMockApi();
    render(<App api={api} disableWebGL />);

    const paletteTab = screen.getByRole('tab', { name: /palette/i });
    fireEvent.click(paletteTab);

    expect(screen.getByTestId('palette-host')).not.toHaveAttribute('hidden');
    const recipeNameInput = screen.getByLabelText(/recipe name/i) as HTMLInputElement;
    fireEvent.change(recipeNameInput, { target: { value: 'NMM Gold Trim' } });
    expect(recipeNameInput.value).toBe('NMM Gold Trim');

    fireEvent.click(screen.getByRole('tab', { name: /model/i }));
    expect(screen.getByTestId('palette-host')).toHaveAttribute('hidden');

    fireEvent.click(paletteTab);
    expect(screen.getByTestId('palette-host')).not.toHaveAttribute('hidden');
    expect((screen.getByLabelText(/recipe name/i) as HTMLInputElement).value).toBe('NMM Gold Trim');
  });

  it('keeps previous model open and shows rollback alert when readBatch fails or swap is canceled', async () => {
    const firstModel: ModelSummary = {
      modelId: 'model_first',
      partId: 'part_0',
      fileName: 'first.stl',
      fileSizeBytes: 512,
      triangleCount: 120,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      batches: [{ batchIndex: 0, filePath: 'first_b0.bin', triangleCount: 120, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
      previewFilePath: null,
    };
    const secondModel: ModelSummary = {
      modelId: 'model_second',
      partId: 'part_0',
      fileName: 'second.stl',
      fileSizeBytes: 1024,
      triangleCount: 240,
      bounds: { min: [0, 0, 0], max: [2, 2, 2] },
      batches: [{ batchIndex: 0, filePath: 'second_b0.bin', triangleCount: 240, bounds: { min: [0, 0, 0], max: [2, 2, 2] } }],
      previewFilePath: null,
    };

    const emptyBatch = {
      triangleCount: 0,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      faceIds: new Uint32Array(0),
    };

    let resolvePendingBatch: ((v: typeof emptyBatch) => void) | undefined;
    const readBatch = vi
      .fn()
      .mockResolvedValueOnce(emptyBatch) // first.stl succeeds
      .mockRejectedValueOnce(new Error('Disk batch read failed')) // second.stl readBatch error
      .mockImplementationOnce(
        () =>
          new Promise<typeof emptyBatch>((resolve) => {
            resolvePendingBatch = resolve;
          }),
      );

    const selectStlFile = vi.fn().mockResolvedValue('C:/models/any.stl');
    const importStl = vi
      .fn()
      .mockResolvedValueOnce(firstModel)
      .mockResolvedValueOnce(secondModel)
      .mockResolvedValueOnce(secondModel);

    const api = createMockApi({
      selectStlFile,
      importStl,
      readBatch,
      commitModel: vi.fn().mockResolvedValue({ committed: true }),
      discardModel: vi.fn().mockResolvedValue({ discarded: true }),
    });
    render(<App api={api} disableWebGL />);

    // Commit first.stl
    fireEvent.click(screen.getByRole('button', { name: /open model/i }));
    expect(await screen.findByText('first.stl')).toBeInTheDocument();
    expect(api.commitModel).toHaveBeenCalledWith('model_first');

    // Fail readBatch on second.stl -> discards secondModel and keeps first.stl open
    fireEvent.click(screen.getByRole('button', { name: /open model/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Disk batch read failed.*Kept first\.stl open/i);
    expect(api.discardModel).toHaveBeenCalledWith('model_second');
    expect(screen.getByText('first.stl')).toBeInTheDocument();

    // Start third attempt where readBatch is pending, then cancel geometry swap
    fireEvent.click(screen.getByRole('button', { name: /open model/i }));
    const cancelBtn = await screen.findByRole('button', { name: /cancel import/i });
    fireEvent.click(cancelBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Canceled geometry swap; kept first\.stl open/i);
    expect(api.discardModel).toHaveBeenCalledTimes(2);
    expect(screen.getByText('first.stl')).toBeInTheDocument();
    resolvePendingBatch?.(emptyBatch);
  });

  it('selects camera-visible and ray-intersected batches across peripheral areas', () => {
    const batches = Array.from({ length: 24 }, (_, idx) => ({
      batchIndex: idx,
      filePath: `b_${idx}.bin`,
      triangleCount: 100,
      bounds: {
        min: [idx * 10, 0, 0] as [number, number, number],
        max: [idx * 10 + 5, 5, 5] as [number, number, number],
      },
    }));

    // Camera focused on far peripheral batch 22 ([222, 2, 2])
    const selected = selectCameraVisibleBatchIndices(batches, [222, 2, 25], [222, 2, 2], 4);
    expect(selected).toContain(22);
    expect(selected.length).toBe(4);

    // Ray aimed at batch 20
    const rayHits = findRayIntersectingBatchIndices(batches, [202, 2, 20], [0, 0, -1]);
    expect(rayHits).toEqual([20]);
  });

  it('streams only batches in frame using the pose of each kit part', () => {
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 8);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const assembly = new THREE.Group();
    const child = new THREE.Group();
    assembly.rotation.z = Math.PI / 2;
    assembly.add(child);
    const bounds = (x: number): ModelSummary['bounds'] => ({
      min: [x - 0.5, -0.5, -0.5], max: [x + 0.5, 0.5, 0.5],
    });
    const model: ModelSummary = {
      modelId: 'kit-part', partId: 'child', fileName: 'part.stl', fileSizeBytes: 184,
      triangleCount: 2, bounds: { min: bounds(0).min, max: bounds(9).max },
      batches: [0, 9].map((x, batchIndex) => ({
        batchIndex, bounds: bounds(x), triangleCount: 1, filePath: `batch-${batchIndex}`,
      })),
      previewFilePath: 'preview.bin',
    };
    const inFrame = () => {
      assembly.updateMatrixWorld(true);
      return visiblePartBatches(camera, child, model).map(({ batchIndex }) => batchIndex);
    };
    expect(inFrame()).toEqual([0]);
    child.position.x = -9;
    expect(inFrame()).toEqual([1]);
    child.position.x = 20;
    expect(inFrame()).toEqual([]);
  });

  it('rejects preview-only clicks, requests second click when detail is missing, and resolves visible detail', () => {
    // 1. Preview-only click (detailGroup hidden or empty)
    expect(resolveClickAgainstVisibleDetail(false, new Set([0, 1]), [0])).toEqual({
      kind: 'preview-only',
    });
    expect(resolveClickAgainstVisibleDetail(true, new Set(), [0])).toEqual({
      kind: 'preview-only',
    });

    // 2. Clicked region needs more detail -> load targetBatches and ask for second click
    expect(resolveClickAgainstVisibleDetail(true, new Set([0, 1]), [12, 13])).toEqual({
      kind: 'needs-detail',
      targetBatches: [12, 13],
    });

    // 3. Clicked region is visible in detail -> resolve against captured visibleBatchIds
    expect(resolveClickAgainstVisibleDetail(true, new Set([0, 12]), [12, 13])).toEqual({
      kind: 'pick',
      visibleBatchIds: [0, 12],
    });
  });

  it('disables Cancel during atomic commit and rolls back on rejected commit', async () => {
    const firstModel: ModelSummary = {
      modelId: 'model_first',
      partId: 'part_0',
      fileName: 'first.stl',
      fileSizeBytes: 512,
      triangleCount: 120,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      batches: [{ batchIndex: 0, filePath: 'first_b0.bin', triangleCount: 120, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
      previewFilePath: null,
    };
    const secondModel: ModelSummary = {
      modelId: 'model_second',
      partId: 'part_0',
      fileName: 'second.stl',
      fileSizeBytes: 1024,
      triangleCount: 240,
      bounds: { min: [0, 0, 0], max: [2, 2, 2] },
      batches: [{ batchIndex: 0, filePath: 'second_b0.bin', triangleCount: 240, bounds: { min: [0, 0, 0], max: [2, 2, 2] } }],
      previewFilePath: null,
    };

    let resolveCommit: ((v: { committed: boolean }) => void) | undefined;
    const commitModel = vi
      .fn()
      .mockResolvedValueOnce({ committed: true })
      .mockImplementationOnce(
        () =>
          new Promise<{ committed: boolean }>((resolve) => {
            resolveCommit = resolve;
          }),
      );
    const discardModel = vi.fn().mockResolvedValue({ discarded: true });
    const importStl = vi
      .fn()
      .mockResolvedValueOnce(firstModel)
      .mockResolvedValueOnce(secondModel);

    const api = createMockApi({ importStl, commitModel, discardModel });
    render(<App api={api} disableWebGL />);

    // Commit first.stl
    fireEvent.click(screen.getByRole('button', { name: /open model/i }));
    expect(await screen.findByText('first.stl')).toBeInTheDocument();

    // Start second.stl; commitModel is in-flight -> Cancel must be disabled
    fireEvent.click(screen.getByRole('button', { name: /open model/i }));
    await waitFor(() => {
      expect(commitModel).toHaveBeenCalledWith('model_second');
    });
    const cancelBtn = screen.getByRole('button', { name: /cancel import/i });
    expect(cancelBtn).toBeDisabled();

    // Reject commit -> discards secondModel and preserves first.stl
    resolveCommit?.({ committed: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Replacement commit was rejected; kept first\.stl open/i,
    );
    expect(discardModel).toHaveBeenCalledWith('model_second');
    expect(screen.getByText('first.stl')).toBeInTheDocument();
  });

  it('keeps exact detail on stationary OrbitControls pointerdown/pointerup and enters preview only on real drag', async () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    document.body.appendChild(canvas);

    const camera = new THREE.PerspectiveCamera(42, 800 / 600, 0.1, 1000);
    camera.position.set(0, 1, 5);
    const controls = new OrbitControls(camera, canvas);

    const previewGroup = new THREE.Group();
    previewGroup.add(new THREE.Mesh(new THREE.BufferGeometry()));
    previewGroup.visible = true;

    const detailGroup = new THREE.Group();
    detailGroup.add(new THREE.Mesh(new THREE.BufferGeometry()));
    detailGroup.visible = true;

    const onCameraMoved = vi.fn();
    const onCameraSettled = vi.fn();
    const lifecycle = attachOrbitDetailLifecycle(
      controls,
      camera,
      previewGroup,
      detailGroup,
      { onCameraMoved, onCameraSettled, settleDelayMs: 20 },
    );

    const dispatchPointer = (type: string, x: number, y: number) => {
      const evt = new Event(type, { bubbles: true, cancelable: true }) as unknown as PointerEvent;
      Object.defineProperties(evt, {
        pointerId: { value: 1 },
        pointerType: { value: 'mouse' },
        button: { value: 0 },
        buttons: { value: type === 'pointerup' ? 0 : 1 },
        clientX: { value: x },
        clientY: { value: y },
      });
      canvas.dispatchEvent(evt);
    };

    // 1. Stationary press + release: real OrbitControls emits 'start' on pointerdown,
    //    but detailGroup must stay visible and onCameraMoved must NOT fire.
    dispatchPointer('pointerdown', 400, 300);
    expect(detailGroup.visible).toBe(true);
    expect(onCameraMoved).not.toHaveBeenCalled();

    dispatchPointer('pointerup', 400, 300);
    expect(detailGroup.visible).toBe(true);
    expect(resolveClickAgainstVisibleDetail(detailGroup.visible, new Set([0]), [0])).toEqual({
      kind: 'pick',
      visibleBatchIds: [0],
    });

    // 2. Stationary repeat click
    dispatchPointer('pointerdown', 400, 300);
    dispatchPointer('pointerup', 400, 300);
    expect(detailGroup.visible).toBe(true);
    expect(onCameraMoved).not.toHaveBeenCalled();

    // 3. Real drag that moves camera -> enters moving preview, then settles
    dispatchPointer('pointerdown', 400, 300);
    dispatchPointer('pointermove', 480, 340);
    expect(onCameraMoved).toHaveBeenCalledTimes(1);
    expect(detailGroup.visible).toBe(false);
    expect(previewGroup.visible).toBe(true);

    dispatchPointer('pointerup', 480, 340);
    await waitFor(() => {
      expect(onCameraSettled).toHaveBeenCalledTimes(1);
    });

    lifecycle.dispose();
    controls.dispose();
    canvas.remove();
  });

  it('renders the bundled Paint Pallet brand logo in the header on both workspace tabs', () => {
    const api = createMockApi();
    const StubPalette = () => <div>Palette Stub</div>;
    const { container } = render(
      <App api={api} PaletteWorkspaceComponent={StubPalette} disableWebGL />,
    );

    const getLogoImg = () => container.querySelector('header.workbench-header img.brand-mark');
    const logo = getLogoImg();
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute('alt', '');
    expect(logo).toHaveAttribute('aria-hidden', 'true');
    expect(logo?.getAttribute('src')).toMatch(/paint-pallet-logo\.png/);
    expect(screen.getByRole('heading', { name: 'Paint Pallet' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Palette' }));
    expect(screen.getByText('Palette Stub')).toBeInTheDocument();
    expect(getLogoImg()).toBeInTheDocument();
    expect(getLogoImg()?.getAttribute('src')).toMatch(/paint-pallet-logo\.png/);
  });
});
