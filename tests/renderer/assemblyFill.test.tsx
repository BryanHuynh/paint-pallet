// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import type { Viewport3DProps } from '../../src/renderer/components/Viewport3D';
import { renderGuideViews } from '../../src/renderer/guide/renderGuideViews';
import type { OpenedProject, ProjectSaveRequest } from '../../src/shared/paintProject';
import type { ModelSummary, PaintPalletApi, PickResult } from '../../src/shared/workerProtocol';

vi.mock('../../src/renderer/components/Viewport3D', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/components/Viewport3D')>();
  return {
    ...actual,
    Viewport3D(props: Viewport3DProps) {
      return <>
        <actual.Viewport3D {...props} disableWebGL />
        {props.model && <button type="button" onClick={() => {
          void props.onSurfacePick([0, 0, 2], [0, 0, -1], [0], {
            modelId: props.model!.modelId, modelGen: 0, viewGen: 0,
          });
        }}>Click test surface</button>}
      </>;
    },
  };
});

vi.mock('../../src/renderer/guide/renderGuideViews', () => {
  const views = Array<string>(4).fill('data:image/png;base64,');
  const result: Awaited<ReturnType<typeof renderGuideViews>> = {
    images: { shadow: views, midtone: views, highlight: views },
    details: {},
  };
  return { renderGuideViews: vi.fn().mockResolvedValue(result) };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(renderGuideViews).mockClear();
});

function model(id: string): ModelSummary {
  return {
    modelId: `model-${id}`, partId: id, fileName: `${id}.stl`, fileSizeBytes: 128, triangleCount: 4,
    bounds: { min: [0, 0, 0], max: [1, 0.5, 0.5] }, batches: [], previewFilePath: null,
  };
}

function hit(faceId: number): PickResult {
  return { hit: true, partId: 'anchor', originalFaceId: faceId, distance: 2, point: [0, 0, 0], normal: [0, 0, 1] };
}

function makeApi(anchor: ModelSummary): PaintPalletApi {
  return {
    selectStlFile: vi.fn().mockResolvedValue(anchor.fileName),
    importStl: vi.fn().mockResolvedValue(anchor),
    cancelImport: vi.fn(), getActiveModel: vi.fn().mockResolvedValue(null), readBatch: vi.fn(),
    pickFace: vi.fn(), onImportProgress: vi.fn().mockReturnValue(() => {}),
  };
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

it('confirms a current assembly, then saves and reopens it for painting and guide export without joints', async () => {
  const anchor = model('anchor');
  const selected = model('selected');
  const alternate = model('alternate');
  const api = makeApi(anchor);
  let saved: OpenedProject | undefined;
  api.importKitParts = vi.fn().mockResolvedValue({ models: [selected, alternate], canceled: false, errors: [] });
  api.saveProject = vi.fn(async (request: ProjectSaveRequest) => {
    saved = { ...request, model: { ...anchor, modelId: 'reopened-anchor' }, kitModels: [selected, alternate] };
    return { path: '/example/assembly.paintproject', name: 'assembly.paintproject' };
  });
  api.openProject = vi.fn(async () => saved ?? null);
  const exportGuide = vi.fn<NonNullable<PaintPalletApi['exportPaintingGuide']>>().mockResolvedValue(true);
  api.exportPaintingGuide = exportGuide;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.open = true; },
  });
  render(<App api={api} />);

  click('Open model');
  await screen.findByRole('option', { name: 'anchor · Anchor' });
  click('Add kit parts');
  await screen.findByRole('option', { name: 'selected · Staged' });
  const inspectPart = screen.getByLabelText('Inspect part');
  fireEvent.change(inspectPart, { target: { value: 'selected' } });
  await waitFor(() => expect(inspectPart).toHaveValue('selected'));
  click('Move and rotate');
  click('Move +X');
  click('Keep position');
  click('Isolate part');
  click('Confirm current assembly');
  expect(screen.getByRole('checkbox', { name: 'selected' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'alternate' })).not.toBeChecked();
  click('Confirm 1 part');
  expect(screen.getByRole('option', { name: 'selected · Placement confirmed' })).toBeInTheDocument();

  fireEvent.click(screen.getByText('Project', { selector: 'summary' }));
  click('Save project');
  await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
  expect(saved?.state.kit).toMatchObject({
    parts: [{ id: 'anchor', staged: false }, { id: 'selected', staged: false, placementConfirmed: true,
      faceOffset: 4, pose: { translation: [0.01, 0, 0], rotation: [0, 0, 0, 1] } },
      { id: 'alternate', staged: true }],
    joints: [], installation: { order: [] },
  });

  fireEvent.click(screen.getByText('Project', { selector: 'summary' }));
  click('Open project');
  await waitFor(() => expect(screen.getByLabelText('Inspect part')).toHaveValue('anchor'));
  expect(screen.getByRole('option', { name: 'selected · Placement confirmed' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'alternate · Staged' })).toBeInTheDocument();

  fireEvent.click(screen.getByText('Project', { selector: 'summary' }));
  click('Painting guide');
  const guide = await screen.findByRole('dialog', { name: 'Painting guide' });
  const exportButton = within(guide).getByRole('button', { name: 'Export PDF' });
  await waitFor(() => expect(exportButton).toBeEnabled());
  fireEvent.click(exportButton);
  await waitFor(() => expect(exportGuide).toHaveBeenCalledWith(expect.objectContaining({ installation: [] })));
  for (const [options] of vi.mocked(renderGuideViews).mock.calls) {
    expect(options.parts?.map((part) => part.id)).toEqual(['anchor', 'selected']);
    expect(options.parts?.[1].pose.translation).toEqual([0.01, 0, 0]);
  }
});

it('queues direct fill clicks, undoes one fill at a time, and commits the same faces again after undo', async () => {
  const api = makeApi(model('anchor'));
  let resolveFirstPick!: (result: PickResult) => void;
  api.pickFace = vi.fn<PaintPalletApi['pickFace']>()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstPick = resolve; }))
    .mockResolvedValue(hit(1));
  const packed = [Uint32Array.of(0, 0, 0), Uint32Array.of(1, 0, 1)];
  const connectedFill = vi.fn<NonNullable<PaintPalletApi['previewConnectedFill']>>(async ({ faceId }) => packed[faceId]);
  api.previewConnectedFill = connectedFill;
  render(<App api={api} />);

  click('Open model');
  await screen.findByRole('button', { name: 'Click test surface' });
  click('Fill');
  click('Click test surface');
  click('Click test surface');
  await act(async () => resolveFirstPick(hit(0)));
  const painted = screen.getByLabelText('Painted faces');
  await waitFor(() => expect(painted).toHaveTextContent('2 painted faces'));
  expect(screen.queryByRole('button', { name: 'Apply fill' })).not.toBeInTheDocument();
  expect(connectedFill.mock.calls.map(([request]) => request.faceId)).toEqual([0, 1]);

  click('Undo stroke');
  expect(painted).toHaveTextContent('1 painted faces');
  click('Click test surface');
  await waitFor(() => expect(painted).toHaveTextContent('2 painted faces'));

  let resolvePendingFill!: (faces: Uint32Array) => void;
  connectedFill.mockImplementationOnce(() => new Promise((resolve) => { resolvePendingFill = resolve; }));
  click('Click test surface');
  await waitFor(() => expect(connectedFill).toHaveBeenCalledTimes(4));
  click('Undo stroke');
  await act(async () => resolvePendingFill(packed[1]));
  expect(painted).toHaveTextContent('1 painted faces');
  click('Undo stroke');
  expect(painted).toHaveTextContent('0 painted faces');

  fireEvent.click(screen.getByRole('checkbox', { name: 'Preview before filling' }));
  click('Click test surface');
  await screen.findByText('1 new face to fill');
  expect(painted).toHaveTextContent('0 painted faces');
  click('Apply fill');
  expect(painted).toHaveTextContent('1 painted faces');
});

it('repaints from the clicked recipe and passes other paint boundaries to the worker', async () => {
  const anchor = model('anchor');
  anchor.batches = [{ batchIndex: 0, filePath: 'test-batch', bounds: anchor.bounds, triangleCount: 4 }];
  const api = makeApi(anchor);
  api.readBatch = vi.fn().mockResolvedValue({
    triangleCount: 4, positions: new Float32Array(36), normals: new Float32Array(36),
    faceIds: Uint32Array.of(0, 1, 2, 3),
  });
  api.pickFace = vi.fn<PaintPalletApi['pickFace']>()
    .mockResolvedValueOnce(hit(0)).mockResolvedValueOnce(hit(1)).mockResolvedValueOnce(hit(0));
  const requestFill = vi.fn<NonNullable<PaintPalletApi['previewConnectedFill']>>(async ({ faceId }) =>
    Uint32Array.of(faceId, 0, faceId));
  api.previewConnectedFill = requestFill;
  render(<App api={api} />);

  click('Open model');
  await screen.findByRole('button', { name: 'Click test surface' });
  const painted = () => screen.getByLabelText('Painted faces');
  function addRecipe() {
    fireEvent.click(screen.getByRole('tab', { name: 'Palette' }));
    click('Add recipe');
    fireEvent.click(screen.getByRole('tab', { name: 'Model' }));
  }
  click('Fill');
  click('Click test surface');
  await waitFor(() => expect(painted()).toHaveTextContent('1 painted faces'));
  addRecipe();
  click('Click test surface');
  await waitFor(() => expect(painted()).toHaveTextContent('1 painted faces'));
  addRecipe();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Repaint existing color' }));
  click('Click test surface');
  await waitFor(() => expect(painted()).toHaveTextContent('1 painted faces'));
  expect(requestFill.mock.calls.map(([request]) => request.blockedFaces)).toEqual([[], [0], [1]]);
  click('Undo stroke');
  expect(painted()).toHaveTextContent('0 painted faces');
  fireEvent.change(screen.getByLabelText('Recipe', { exact: true }), { target: { value: 'recipe-1' } });
  expect(painted()).toHaveTextContent('1 painted faces');
});
