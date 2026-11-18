// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import * as THREE from 'three';
import App from '../../src/renderer/App';
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

  it('imports an STL via Open STL and displays model stats', async () => {
    const api = createMockApi();
    render(<App api={api} disableWebGL />);

    const openBtn = screen.getByRole('button', { name: /open stl/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(api.selectStlFile).toHaveBeenCalledTimes(1);
      expect(api.importStl).toHaveBeenCalledWith('C:/models/test_mini.stl');
    });

    expect(await screen.findByText('test_mini.stl')).toBeInTheDocument();
    expect(screen.getByText('4,200')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: /open stl/i }));
    expect(await screen.findByText('first.stl')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open stl/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Truncated or malformed/i);
    expect(screen.getByText('first.stl')).toBeInTheDocument();
  });

  it('updates upright and front orientation and aligns local axes to world +Y and +Z', () => {
    const onOrientationChange = vi.fn();
    const api = createMockApi();
    render(<App api={api} disableWebGL onOrientationChange={onOrientationChange} />);

    const uprightSelect = screen.getByLabelText(/upright axis/i);
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

  it('mounts an independently built PaletteWorkspace component as a workspace tab', () => {
    function MockPaletteIntegration() {
      return <div data-testid="palette-integration-root">Palette Integration Mount</div>;
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

    expect(screen.getByTestId('palette-integration-root')).toBeInTheDocument();

    const modelTab = screen.getByRole('tab', { name: /model/i });
    fireEvent.click(modelTab);
    expect(screen.getByTestId('viewport-canvas')).toBeInTheDocument();
  });
});
