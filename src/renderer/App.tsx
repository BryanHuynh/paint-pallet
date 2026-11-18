import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Viewport3D, type CameraPreset, type PickGenerationToken } from './components/Viewport3D';
import PaintingGuideDialog from './guide/PaintingGuideDialog';
import type { GuideCallout, GuideRow } from '../shared/paintingGuide';
import type { OpenedProject } from '../shared/paintProject';
import type { PaletteProjectHandle, PreparedPaletteProject } from './palette/paletteProject';
import type { PaintRecipe } from './palette/types';
import { createEmptyRecipe } from './palette/recipes';
import { ShadowPanel } from './paint/ShadowPanel';
import { useShadowPainting } from './paint/useShadowPainting';
import { LightingPanel } from './paint/LightingPanel';
import { renderToneMask, toneColorKey } from './paint/lightingState';
import { useSurfaceLighting } from './paint/useSurfaceLighting';
import { FILL_PREVIEW_REGION, unpackFillFaces, useConnectedFill } from './paint/useConnectedFill';
import appLogoUrl from '../../assets/paint-pallet-logo.png';

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
  stlLimitLabel?: string;
  onOrientationChange?: (orientation: ModelOrientation) => void;
}

export default function App({
  api: injectedApi,
  PaletteWorkspaceComponent,
  disableWebGL = false,
  stlLimitLabel = '2 GiB',
  onOrientationChange,
}: AppProps) {
  const api = injectedApi ?? window.paintPallet;
  const ResolvedPalette = PaletteWorkspaceComponent ?? resolveDiscoveredPalette();

  const [recipes, setRecipes] = useState<PaintRecipe[]>(() => [createEmptyRecipe(1)]);
  const shadow = useShadowPainting(recipes);
  const paletteProject = useRef<PaletteProjectHandle | null>(null);
  const pendingProject = useRef<{ project: OpenedProject; palette: PreparedPaletteProject } | null>(null);
  const projectMenu = useRef<HTMLDetailsElement | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideCallouts, setGuideCallouts] = useState<GuideCallout[]>([]);
  const guideRows = useMemo<GuideRow[]>(() => {
    const palette = new Map(recipes.map((recipe) => [recipe.id, recipe.swatches]));
    return shadow.regions.map((region) => ({ id: region.id, name: region.name, swatches: palette.get(region.recipeId) ?? null }));
  }, [recipes, shadow.regions]);
  const [projectAction, setProjectAction] = useState<'open' | 'save' | null>(null);
  const [activeTab, setActiveTab] = useState<'model' | 'palette'>('model');
  const [model, setModel] = useState<ModelSummary | null>(null);
  const fill = useConnectedFill(api, shadow.tool === 'fill', model?.modelId, shadow.region?.id, shadow.committedCoverage);
  const [pendingModel, setPendingModel] = useState<ModelSummary | null>(null);
  const [orientation, setOrientation] = useState<ModelOrientation>({
    upright: '+Y',
    front: '+Z',
  });
  const lighting = useSurfaceLighting(api, model?.modelId, orientation, shadow.committedCoverage);
  const coverage = useMemo(
    () => renderToneMask(fill.previewCoverage ?? shadow.coverage, lighting.mask),
    [fill.previewCoverage, shadow.coverage, lighting.mask],
  );
  const shadowColors = useMemo(() => {
    const colors = new Map(shadow.colors);
    if (fill.previewCoverage) colors.set(FILL_PREVIEW_REGION, '#76d9ac');
    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    for (const region of shadow.regions) {
      const recipe = byId.get(region.recipeId);
      if (!recipe) continue;
      colors.set(toneColorKey(region.id, 'midtone'), recipe.swatches.midtone.hex);
      colors.set(toneColorKey(region.id, 'highlight'), recipe.swatches.highlight.hex);
    }
    return colors;
  }, [fill.previewCoverage, shadow.colors, recipes, shadow.regions]);
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const [progress, setProgress] = useState<ImportProgressEvent | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isDraggingStl, setIsDraggingStl] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [cameraPresetRequest, setCameraPresetRequest] = useState<{
    preset: CameraPreset;
    seq: number;
  } | null>(null);

  const importInFlight = useRef(false);
  const pendingModelRef = useRef<ModelSummary | null>(null);
  pendingModelRef.current = pendingModel;
  const activeModelIdRef = useRef<string | null>(null);
  activeModelIdRef.current = model?.modelId ?? null;
  const appModelGenRef = useRef(0);
  const appViewGenRef = useRef(0);
  const pickSeqRef = useRef(0);

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
      ++appViewGenRef.current;
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

  const importFrom = async (
    prepareImport: () => Promise<(() => Promise<ModelSummary>) | null>,
  ) => {
    if (!api || importInFlight.current || pendingModelRef.current || isCommitting) return;
    importInFlight.current = true;
    setStatusMsg(null);

    try {
      const loadModel = await prepareImport();
      if (!loadModel) return;

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
      const summary = await loadModel();
      pendingModelRef.current = summary;
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
      importInFlight.current = false;
      setIsImporting(false);
      setProgress(null);
    }
  };

  const handleOpenStl = () => {
    if (!api) return;
    void importFrom(async () => {
      const filePath = await api.selectStlFile();
      return filePath ? () => api.importStl(filePath) : null;
    });
  };

  const handleStlDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const canDrop = Boolean(api?.importDroppedStl) && !isBusy && !importInFlight.current;
    event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
    setIsDraggingStl(canDrop);
  };

  const handleStlDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDraggingStl(false);
  };

  const handleStlDrop = (event: React.DragEvent<HTMLElement>) => {
    const { files, types } = event.dataTransfer;
    if (!files.length && !types.includes('Files')) return;
    event.preventDefault();
    setIsDraggingStl(false);
    const importDroppedStl = api?.importDroppedStl;
    if (!importDroppedStl || isBusy) return;

    void importFrom(async () => {
      const file = files[0];
      if (files.length !== 1 || !file || !/\.(stl|obj)$/i.test(file.name)) {
        throw new Error('Drop one .stl or .obj file at a time.');
      }

      return () => importDroppedStl(file);
    });
  };

  function takePendingProject(modelId: string) {
    const pending = pendingProject.current;
    if (pending?.project.model.modelId !== modelId) return null;
    pendingProject.current = null;
    return pending;
  }

  async function saveProject() {
    if (!api?.saveProject || !model || !paletteProject.current) return;
    if (projectMenu.current) projectMenu.current.open = false;
    setProjectAction('save');
    setStatusMsg(null);
    try {
      const paint = shadow.exportProject();
      const snapshots = lighting.exportProject(paint.regions);
      const palette = await paletteProject.current.exportProject();
      await api.saveProject({
        modelId: model.modelId,
        state: {
          orientation,
          recipes,
          ...palette.state,
          regions: paint.regions,
          activeRegionId: paint.activeRegionId,
          snapshots: snapshots.snapshots,
          activeSnapshotId: snapshots.activeSnapshotId,
          guideCallouts,
        },
        referenceBytes: palette.referenceBytes,
        paint: paint.paint,
        tones: snapshots.tones,
      });
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Unable to save the paint project.');
    } finally {
      setProjectAction(null);
    }
  }

  async function openProject() {
    if (!api?.openProject || !paletteProject.current || importInFlight.current) return;
    const paletteHandle = paletteProject.current;
    if (projectMenu.current) projectMenu.current.open = false;
    importInFlight.current = true;
    setProjectAction('open');
    setStatusMsg(null);
    let project: OpenedProject | null = null;
    try {
      project = await api.openProject();
      if (!project) return;
      const palette = await paletteHandle.prepareProject(project.state, project.referenceBytes);
      pendingProject.current = { project, palette };
      pendingModelRef.current = project.model;
      setPendingModel(project.model);
      setActiveTab('model');
    } catch (error) {
      if (project) await api.discardModel?.(project.model.modelId).catch(() => {});
      const message = error instanceof Error ? error.message : 'Unable to open the paint project.';
      setStatusMsg(model ? `${message} Kept ${model.fileName} open.` : message);
    } finally {
      importInFlight.current = false;
      setProjectAction(null);
      setProgress(null);
    }
  }

  const handleCancelImport = async () => {
    if (!api || isCommitting) return;
    if (isImporting) {
      await api.cancelImport();
      return;
    }
    const staged = pendingModelRef.current;
    if (staged) {
      pendingModelRef.current = null;
      setPendingModel(null);
      takePendingProject(staged.modelId)?.palette.dispose();
      await api.discardModel?.(staged.modelId);
      setStatusMsg(
        model
          ? `Canceled geometry swap; kept ${model.fileName} open.`
          : 'Canceled geometry swap.',
      );
    }
  };

  const handlePendingModelCommit = useCallback(
    async (committed: ModelSummary): Promise<boolean> => {
      if (pendingModelRef.current?.modelId !== committed.modelId) {
        return false;
      }
      setIsCommitting(true);
      try {
        const res = api?.commitModel
          ? await api.commitModel(committed.modelId)
          : { committed: true };

        // Guard stale commit reply if staged model was superseded or cleared
        if (pendingModelRef.current?.modelId !== committed.modelId) {
          takePendingProject(committed.modelId)?.palette.dispose();
          if (res.committed) {
            await api?.discardModel?.(committed.modelId);
          }
          return false;
        }

        if (!res.committed) {
          pendingModelRef.current = null;
          setPendingModel(null);
          takePendingProject(committed.modelId)?.palette.dispose();
          await api?.discardModel?.(committed.modelId);
          setStatusMsg(
            model
              ? `Replacement commit was rejected; kept ${model.fileName} open.`
              : 'Replacement commit was rejected.',
          );
          return false;
        }

        ++appModelGenRef.current;
        activeModelIdRef.current = committed.modelId;
        pendingModelRef.current = null;
        const opened = takePendingProject(committed.modelId);
        fill.cancel();
        if (opened) {
          const { state, paint, tones } = opened.project;
          setOrientation(state.orientation);
          setRecipes(state.recipes);
          setGuideCallouts(state.guideCallouts ?? []);
          shadow.restoreProject(state, paint);
          lighting.restoreProject(state, tones);
          opened.palette.apply();
        } else {
          setGuideCallouts([]);
          shadow.reset();
          lighting.reset();
        }
        setModel(committed);
        setPendingModel(null);
        setProgress(null);
        setPickResult(null);
        return true;
      } catch (err) {
        pendingModelRef.current = null;
        setPendingModel(null);
        takePendingProject(committed.modelId)?.palette.dispose();
        await api?.discardModel?.(committed.modelId);
        const msg = err instanceof Error ? err.message : 'Replacement commit failed.';
        setStatusMsg(model ? `${msg} Kept ${model.fileName} open.` : msg);
        return false;
      } finally {
        setIsCommitting(false);
      }
    },
    [api, model],
  );

  const handlePendingModelError = useCallback(
    async (err: Error) => {
      const staged = pendingModelRef.current;
      if (!staged) return;
      pendingModelRef.current = null;
      setPendingModel(null);
      takePendingProject(staged.modelId)?.palette.dispose();
      await api?.discardModel?.(staged.modelId);
      setStatusMsg(
        model
          ? `${err.message} Kept ${model.fileName} open.`
          : err.message,
      );
    },
    [api, model],
  );

  const handleViewChange = useCallback(() => {
    ++appViewGenRef.current;
  }, []);

  const handlePickNeedsDetail = useCallback((message: string) => {
    setStatusMsg(message);
  }, []);

  const handleSurfacePick = async (
    origin: Vec3,
    direction: Vec3,
    batchIndices: number[],
    token: PickGenerationToken,
  ) => {
    if (!api || !model || token.modelId !== model.modelId) return;
    const startAppModelGen = appModelGenRef.current;
    const startAppViewGen = appViewGenRef.current;
    const isCurrent = () =>
      activeModelIdRef.current === token.modelId &&
      appModelGenRef.current === startAppModelGen &&
      appViewGenRef.current === startAppViewGen;

    try {
      const sequence = ++pickSeqRef.current;
      const result = await api.pickFace(model.modelId, origin, direction, batchIndices);
      if (sequence !== pickSeqRef.current || !isCurrent()) return;
      if (shadow.tool === 'fill' && shadow.region) {
        if (result.hit && result.originalFaceId !== null && result.partId === model.partId) {
          fill.select({ modelId: model.modelId, faceId: result.originalFaceId, regionId: shadow.region.id });
        }
      } else {
        setPickResult(result);
      }
    } catch (error) {
      if (isCurrent()) setStatusMsg(error instanceof Error ? error.message : 'Surface pick failed.');
    }
  };

  const triggerCameraPreset = (preset: CameraPreset) => {
    setCameraPresetRequest((prev) => ({ preset, seq: (prev?.seq ?? 0) + 1 }));
  };

  const progressPct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : 0;

  const isBusy = isImporting || Boolean(pendingModel) || isCommitting || projectAction !== null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#viewport-region">
        Skip to viewport
      </a>

      <header className="workbench-header">
        <div className="brand-group">
          <img
            className="brand-mark"
            src={appLogoUrl}
            alt=""
            aria-hidden="true"
            width={36}
            height={36}
            decoding="async"
          />
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
          {api?.openProject && api.saveProject && (
            <details className="project-menu" ref={projectMenu}>
              <summary className="btn btn--secondary">Project</summary>
              <div className="project-menu-actions">
                <button type="button" className="btn btn--secondary" disabled={isBusy} onClick={openProject}>
                  Open project
                </button>
                <button type="button" className="btn btn--secondary" disabled={isBusy || !model} onClick={saveProject}>
                  Save project
                </button>
                {api.exportPaintingGuide && (
                  <button type="button" className="btn btn--secondary" disabled={isBusy || !model}
                    onClick={() => {
                      if (projectMenu.current) projectMenu.current.open = false;
                      setGuideOpen(true);
                    }}>
                    Painting guide
                  </button>
                )}
              </div>
            </details>
          )}
          {(isImporting || pendingModel || isCommitting) ? (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleCancelImport}
              disabled={isCommitting}
            >
              Cancel import
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleOpenStl}
            disabled={!api || isBusy}
          >
            Open model
          </button>
        </div>
      </header>

      {ResolvedPalette ? (
        <main
          className="palette-host"
          data-testid="palette-host"
          hidden={activeTab !== 'palette'}
        >
          <ResolvedPalette recipes={recipes} setRecipes={setRecipes} projectRef={paletteProject} />
        </main>
      ) : null}

      <main className="workbench-main" hidden={activeTab !== 'model'}>
        <section
          id="viewport-region"
          className="viewport-region"
          aria-label="STL surface viewport"
          onDragOver={handleStlDragOver}
          onDragLeave={handleStlDragLeave}
          onDrop={handleStlDrop}
        >
          <Viewport3D
            api={api}
            model={model}
            pendingModel={pendingModel}
            orientation={orientation}
            cameraPresetRequest={cameraPresetRequest}
            onSurfacePick={handleSurfacePick}
            shadowPaint={{
              enabled: Boolean(model && !isBusy && (lighting.brushTool ||
                (shadow.tool && shadow.tool !== 'fill' && shadow.recipe))),
              coverage,
              colors: shadowColors,
              diameter: shadow.brushSize,
              onFaces: lighting.brushTool ? lighting.paintFaces : shadow.paintFaces,
              onStart: lighting.brushTool ? lighting.beginBrush : shadow.beginStroke,
              onEnd: lighting.brushTool ? lighting.endBrush : shadow.endStroke,
            }}
            onPickNeedsDetail={handlePickNeedsDetail}
            onViewChange={handleViewChange}
            onPendingModelCommit={handlePendingModelCommit}
            onPendingModelError={handlePendingModelError}
            disableWebGL={disableWebGL}
          />

          {!model && !isBusy ? (
            <div className="viewport-empty">
              <div className="viewport-empty__card">
                <h2>Model surface inspector</h2>
                {api?.importDroppedStl ? <p>Drop an STL or OBJ file here.</p> : null}
                <p>
                  Open an STL or OBJ model to inspect original triangles,
                  set upright and front axes, and pick original face IDs. Binary STL files can be up to {stlLimitLabel}.
                </p>
                {api ? (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={handleOpenStl}
                  >
                    Choose model file
                  </button>
                ) : (
                  <p>Open the Electron app to import and inspect STL files.</p>
                )}
              </div>
            </div>
          ) : null}

          {isDraggingStl && !isBusy ? (
            <div className="stl-drop-overlay" aria-hidden="true">
              Drop model to open
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

          {projectAction && !progress ? (
            <div className="progress-overlay" role="status">{projectAction === 'open' ? 'Opening project…' : 'Saving project…'}</div>
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
                  disabled={isCommitting}
                >
                  Cancel import
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <aside className="inspector-panel" aria-label="Model inspector">
          {model && (
            <ShadowPanel
              paint={shadow}
              fill={fill}
              recipes={recipes}
              busy={isBusy || lighting.brushPending}
              onToolChange={(tool) => {
                lighting.setBrushTool(null);
                shadow.setTool(tool);
              }}
              onApplyFill={() => {
                if (fill.packed) shadow.commitFill(unpackFillFaces(fill.packed));
                fill.cancel();
              }}
            />
          )}
          {model && lighting.available && (
            <LightingPanel
              lighting={lighting}
              busy={isBusy || shadow.strokePending || lighting.brushPending}
              brushSize={shadow.brushSize}
              onBrushSize={shadow.setBrushSize}
              onChooseBrush={(tool) => {
                if (tool) {
                  fill.cancel();
                  shadow.setTool(null);
                }
                lighting.setBrushTool(tool);
              }}
            />
          )}

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
      {guideOpen && api && model && (
        <PaintingGuideDialog
          api={api} model={model} orientation={orientation} coverage={shadow.committedCoverage}
          tones={lighting.committedMask} snapshot={lighting.snapshot.name.trim() || 'Untitled snapshot'}
          rows={guideRows} callouts={guideCallouts} setCallouts={setGuideCallouts}
          unapplied={lighting.unapplied} close={() => setGuideOpen(false)}
        />
      )}
    </div>
  );
}
