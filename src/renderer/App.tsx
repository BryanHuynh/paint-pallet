import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AxisDirection,
  ImportProgressEvent,
  ModelOrientation,
  ModelSummary,
  PaintPalletApi,
  PickResult,
  Vec3,
} from '../shared/workerProtocol';
import { ALL_AXES, getOrthogonalFrontOptions } from './orientation';
import { Viewport3D, type CameraPreset } from './components/Viewport3D';

type PaletteComponent = React.ComponentType<Record<string, unknown>>;

const discoveredPaletteModules = import.meta.glob<{ default?: PaletteComponent }>(
  './palette/PaletteWorkspace.{tsx,ts,jsx,js}',
  { eager: true },
);

function resolveDiscoveredPalette(): PaletteComponent | null {
  for (const mod of Object.values(discoveredPaletteModules)) {
    if (mod && typeof mod.default === 'function') {
      return mod.default;
    }
  }
  return null;
}

export interface AppProps {
  api?: PaintPalletApi;
  PaletteWorkspaceComponent?: PaletteComponent | null;
  disableWebGL?: boolean;
  onOrientationChange?: (orientation: ModelOrientation) => void;
}

export default function App({
  api: injectedApi,
  PaletteWorkspaceComponent,
  disableWebGL = false,
  onOrientationChange,
}: AppProps) {
  const api = injectedApi ?? window.paintPallet;
  const ResolvedPalette = PaletteWorkspaceComponent ?? resolveDiscoveredPalette();

  const [activeTab, setActiveTab] = useState<'model' | 'palette'>('model');
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [pendingModel, setPendingModel] = useState<ModelSummary | null>(null);
  const [orientation, setOrientation] = useState<ModelOrientation>({
    upright: '+Y',
    front: '+Z',
  });
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const [progress, setProgress] = useState<ImportProgressEvent | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [cameraPresetRequest, setCameraPresetRequest] = useState<{
    preset: CameraPreset;
    seq: number;
  } | null>(null);

  useEffect(() => {
    if (!api) return;
    const unsub = api.onImportProgress((evt) => {
      setProgress(evt);
    });
    return unsub;
  }, [api]);

  const frontOptions = useMemo(
    () => getOrthogonalFrontOptions(orientation.upright),
    [orientation.upright],
  );

  const updateOrientation = useCallback(
    (next: ModelOrientation) => {
      setOrientation(next);
      onOrientationChange?.(next);
    },
    [onOrientationChange],
  );

  const handleUprightChange = (nextUpright: AxisDirection) => {
    const validFronts = getOrthogonalFrontOptions(nextUpright);
    const nextFront = validFronts.includes(orientation.front)
      ? orientation.front
      : validFronts[0];
    updateOrientation({ upright: nextUpright, front: nextFront });
  };

  const handleFrontChange = (nextFront: AxisDirection) => {
    updateOrientation({ upright: orientation.upright, front: nextFront });
  };

  const handleOpenStl = async () => {
    if (!api) return;
    setStatusMsg(null);
    const selectedPath = await api.selectStlFile();
    if (!selectedPath) return;

    setIsImporting(true);
    setProgress({
      type: 'progress',
      jobId: 'active',
      phase: 'reading',
      bytesRead: 0,
      totalBytes: 1,
      trianglesRead: 0,
      totalTriangles: 0,
    });

    try {
      const summary = await api.importStl(selectedPath);
      setPendingModel(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      if (/canceled/i.test(msg)) {
        setStatusMsg(
          model
            ? `Import canceled; kept ${model.fileName} open.`
            : 'Import canceled.',
        );
      } else {
        setStatusMsg(
          model
            ? `${msg} Kept ${model.fileName} open.`
            : msg,
        );
      }
    } finally {
      setIsImporting(false);
      setProgress(null);
    }
  };

  const handleCancelImport = async () => {
    if (!api) return;
    if (isImporting) {
      await api.cancelImport();
      return;
    }
    if (pendingModel) {
      setPendingModel(null);
      setStatusMsg(
        model
          ? `Canceled geometry swap; kept ${model.fileName} open.`
          : 'Canceled geometry swap.',
      );
    }
  };

  const handlePendingModelCommit = useCallback((committed: ModelSummary) => {
    setModel(committed);
    setPendingModel(null);
    setPickResult(null);
  }, []);

  const handlePendingModelError = useCallback(
    (err: Error) => {
      setPendingModel(null);
      setStatusMsg(
        model
          ? `${err.message} Kept ${model.fileName} open.`
          : err.message,
      );
    },
    [model],
  );

  const handleSurfacePick = useCallback(
    async (origin: Vec3, direction: Vec3) => {
      if (!api || !model) return;
      const result = await api.pickFace(model.modelId, origin, direction);
      setPickResult(result);
    },
    [api, model],
  );

  const triggerCameraPreset = (preset: CameraPreset) => {
    setCameraPresetRequest((prev) => ({ preset, seq: (prev?.seq ?? 0) + 1 }));
  };

  const progressPct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : 0;

  const isBusy = isImporting || Boolean(pendingModel);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#viewport-region">
        Skip to viewport
      </a>

      <header className="workbench-header">
        <div className="brand-group">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <h1 className="brand-title">Paint Pallet</h1>
        </div>

        <nav className="workspace-tabs" aria-label="Workspace tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="tab-btn"
            aria-selected={activeTab === 'model'}
            onClick={() => setActiveTab('model')}
          >
            Model
          </button>
          {ResolvedPalette ? (
            <button
              type="button"
              role="tab"
              className="tab-btn"
              aria-selected={activeTab === 'palette'}
              onClick={() => setActiveTab('palette')}
            >
              Palette
            </button>
          ) : null}
        </nav>

        <div className="header-actions">
          {isBusy ? (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleCancelImport}
            >
              Cancel import
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleOpenStl}
            disabled={isBusy}
          >
            Open STL
          </button>
        </div>
      </header>

      {ResolvedPalette ? (
        <main
          className="palette-host"
          data-testid="palette-host"
          hidden={activeTab !== 'palette'}
        >
          <ResolvedPalette />
        </main>
      ) : null}

      <main className="workbench-main" hidden={activeTab !== 'model'}>
        <section
          id="viewport-region"
          className="viewport-region"
          aria-label="STL surface viewport"
        >
          <Viewport3D
            api={api}
            model={model}
            pendingModel={pendingModel}
            orientation={orientation}
            cameraPresetRequest={cameraPresetRequest}
            onSurfacePick={handleSurfacePick}
            onPendingModelCommit={handlePendingModelCommit}
            onPendingModelError={handlePendingModelError}
            disableWebGL={disableWebGL}
          />

          {!model && !isBusy ? (
            <div className="viewport-empty">
              <div className="viewport-empty__card">
                <h2>Binary STL surface inspector</h2>
                <p>
                  Open a print-ready binary STL up to 2 GiB to inspect original triangles,
                  set upright and front axes, and pick original face IDs.
                </p>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={handleOpenStl}
                >
                  Choose STL file
                </button>
              </div>
            </div>
          ) : null}

          {statusMsg ? (
            <div className="error-banner" role="alert">
              <span>{statusMsg}</span>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => setStatusMsg(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {progress ? (
            <div className="progress-overlay" role="status" aria-live="polite">
              <div className="progress-overlay__row">
                <span>Importing STL ({progress.phase})</span>
                <span>{progressPct}%</span>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-bar__fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="progress-overlay__row">
                <span>
                  {progress.trianglesRead.toLocaleString()} /{' '}
                  {progress.totalTriangles.toLocaleString()} triangles
                </span>
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  onClick={handleCancelImport}
                >
                  Cancel import
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <aside className="inspector-panel" aria-label="Model inspector">
          <section className="inspector-section">
            <h2>Model summary</h2>
            {model ? (
              <dl className="kv-list">
                <dt>File</dt>
                <dd>{model.fileName}</dd>
                <dt>Triangles</dt>
                <dd>{model.triangleCount.toLocaleString()}</dd>
                <dt>Spatial batches</dt>
                <dd>{model.batches.length}</dd>
                <dt>Bounds min</dt>
                <dd>
                  {model.bounds.min.map((v) => v.toFixed(1)).join(', ')}
                </dd>
                <dt>Bounds max</dt>
                <dd>
                  {model.bounds.max.map((v) => v.toFixed(1)).join(', ')}
                </dd>
              </dl>
            ) : (
              <p className="hint-text">No STL loaded.</p>
            )}
          </section>

          <section className="inspector-section">
            <h2>Orientation</h2>
            <div className="field-row">
              <label htmlFor="upright-select">Upright axis</label>
              <select
                id="upright-select"
                className="select-input"
                value={orientation.upright}
                onChange={(e) => handleUprightChange(e.target.value as AxisDirection)}
              >
                {ALL_AXES.map((axis) => (
                  <option key={axis} value={axis}>
                    {axis}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <label htmlFor="front-select">Front axis</label>
              <select
                id="front-select"
                className="select-input"
                value={orientation.front}
                onChange={(e) => handleFrontChange(e.target.value as AxisDirection)}
              >
                {frontOptions.map((axis) => (
                  <option key={axis} value={axis}>
                    {axis}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() => updateOrientation({ upright: '+Y', front: '+Z' })}
            >
              Reset orientation
            </button>
          </section>

          <section className="inspector-section">
            <h2>Surface pick</h2>
            {pickResult && pickResult.hit ? (
              <dl className="kv-list">
                <dt>Original face ID</dt>
                <dd data-testid="picked-face-id">{pickResult.originalFaceId}</dd>
                <dt>Part ID</dt>
                <dd>{pickResult.partId}</dd>
                <dt>Hit point</dt>
                <dd>
                  {pickResult.point?.map((v) => v.toFixed(2)).join(', ')}
                </dd>
              </dl>
            ) : (
              <p className="hint-text">Click a surface triangle to inspect its face ID.</p>
            )}
          </section>

          <section className="inspector-section">
            <h2>Camera controls</h2>
            <div className="preset-grid">
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => triggerCameraPreset('reset')}
              >
                Reset view
              </button>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => triggerCameraPreset('front')}
              >
                Front view
              </button>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => triggerCameraPreset('top')}
              >
                Top view
              </button>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => triggerCameraPreset('right')}
              >
                Right view
              </button>
            </div>
            <p className="hint-text">
              Drag to orbit · Right-drag to pan · Scroll to zoom
            </p>
          </section>
        </aside>
      </main>
    </div>
  );
}
