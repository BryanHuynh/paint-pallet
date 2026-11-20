import { Box3, Ray, Vector3 } from 'three';
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type {
  AxisDirection,
  Bounds3,
  ImportProgressEvent,
  ModelOrientation,
  ModelSummary,
  PaintPalletApi,
  PickResult,
  Vec3,
} from '../shared/workerProtocol';
import { ALL_AXES, getOrthogonalFrontOptions } from './orientation';
import { findRayIntersectingBatchIndices, Viewport3D, type CameraPreset, type PickGenerationToken } from './components/Viewport3D';
import PaintingGuideDialog from './guide/PaintingGuideDialog';
import type { GuideCallout, GuideRow } from '../shared/paintingGuide';
import type { OpenedProject, ProjectFile } from '../shared/paintProject';
import type { PaletteProjectHandle, PreparedPaletteProject } from './palette/paletteProject';
import type { PaintRecipe } from './palette/types';
import { createEmptyRecipe } from './palette/recipes';
import { EdgePanel } from './paint/EdgePanel';
import { EDGE_PREVIEW, applyEdgesOver, clipEdgeCoverage, edgeColorKey, useEdgeHighlight } from './paint/useEdgeHighlight';
import { ANCHOR_ADDRESS, EMPTY_INSTALLATION, IDENTITY_PART_POSE, nextPartAddress, restoreKitAddresses, syncInstallation, type KitPart } from '../shared/kit';
import { poseMatrix } from './kit/jointMath';
import { JointPanel } from './kit/JointPanel';
import { JOINT_HIGHLIGHT, useKitAssembly } from './kit/useKitAssembly';
import { KitPanel } from './kit/KitPanel';
import { ShadowPanel } from './paint/ShadowPanel';
import { useShadowPainting } from './paint/useShadowPainting';
import { LightingPanel } from './paint/LightingPanel';
import { renderToneMask, toneColorKey } from './paint/lightingState';
import { useSurfaceLighting, worldLightDirection } from './paint/useSurfaceLighting';
import { FILL_PREVIEW_RECIPE, useConnectedFill } from './paint/useConnectedFill';
import appLogoUrl from '../../assets/paint-pallet-logo.png';
import fieldRobotUrl from '../../assets/field-robot.webp';
import { ModelTutorial, tutorialSteps } from './components/ModelTutorial';

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
  const [activeRecipeId, setActiveRecipeId] = useState<string | null>('recipe-1');
  const shadow = useShadowPainting(recipes, activeRecipeId);
  const [guideCallouts, setGuideCallouts] = useState<GuideCallout[]>([]);
  const paletteProject = useRef<PaletteProjectHandle | null>(null);
  const [referenceEdits, setReferenceEdits] = useState(0);
  const markReferenceEdit = useCallback(() => setReferenceEdits((count) => count + 1), []);
  const paletteWorkspace = useMemo(() => ResolvedPalette
    ? <ResolvedPalette recipes={recipes} setRecipes={setRecipes} activeRecipeId={activeRecipeId}
      setActiveRecipeId={setActiveRecipeId} usedRecipeIds={shadow.usedRecipeIds}
      projectRef={paletteProject} onProjectChange={markReferenceEdit} />
    : null, [ResolvedPalette, recipes, activeRecipeId, shadow.usedRecipeIds, markReferenceEdit]);
  const pendingProject = useRef<{ project: OpenedProject; palette: PreparedPaletteProject } | null>(null);
  const projectMenu = useRef<HTMLDetailsElement | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideRows = useMemo<GuideRow[]>(() => recipes.filter(({ id }) => shadow.faceCounts.has(id))
    .map(({ id, name, swatches, edgeSwatch }) => ({ id, name: name.trim() || 'Untitled recipe', swatches, edgeSwatch })),
  [recipes, shadow.faceCounts]);
  const [projectAction, setProjectAction] = useState<'open' | 'save' | null>(null);
  const [projectFile, setProjectFile] = useState<ProjectFile | null>(null);
  const [recentProjects, setRecentProjects] = useState<ProjectFile[]>([]);
  const [projectNotice, setProjectNotice] = useState('');
  const [activeTab, setActiveTab] = useState<'model' | 'palette'>('model');
  const [tutorialIndex, setTutorialIndex] = useState<number | null>(null);
  const tutorialStep = tutorialIndex === null ? undefined : tutorialSteps[tutorialIndex];
  const tutorialButton = useRef<HTMLButtonElement>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [parts, setParts] = useState<KitPart[]>([]);
  const [focusId, setFocusId] = useState('');
  const [kitBounds, setKitBounds] = useState<Bounds3 | undefined>();
  const [kitImporting, setKitImporting] = useState(false);
  const focusPending = useRef<{ id: string; modelId: string; remove?: KitPart } | null>(null);
  const selectedPart = parts.find((part) => part.id === focusId);
  const displayModel = selectedPart?.model ?? model;
  const [paintIsolation, setPaintIsolation] = useState<string | null>(null);
  const canPaintPart = Boolean(displayModel && !selectedPart?.staged && !selectedPart?.hidden &&
    (!paintIsolation || selectedPart?.id === paintIsolation));
  const paintPart = useMemo(() => selectedPart ? {
    faceOffset: selectedPart.faceOffset, batchOffset: selectedPart.batchOffset,
    faceCount: selectedPart.model.triangleCount, id: selectedPart.id,
  } : undefined, [selectedPart]);
  const assembly = useKitAssembly(api, parts, setParts, choosePart);
  const [installation, setInstallation] = useState(EMPTY_INSTALLATION);
  const guideInstallation = useMemo(() => syncInstallation(installation, parts, assembly.joints), [installation, parts, assembly.joints]);
  const ghostPart = assembly.draft && (assembly.draft.preview || assembly.draft.method === 'manual')
    ? parts.find((part) => part.id === assembly.draft?.childId)
    : undefined;
  const isolatedPartId = assembly.isolated ?? paintIsolation;
  const parentPose = parts.find((part) => part.id === assembly.draft?.parentId)?.pose;
  const jointPoint = assembly.draft?.point;
  const jointMarker = useMemo(() => parentPose && jointPoint ? new Vector3(...jointPoint)
    .applyMatrix4(poseMatrix(parentPose)).toArray() : undefined, [parentPose, jointPoint]);
  const companionParts = useMemo(() => parts.length > 1 ? parts.map((part) => ({
    ...part,
    hidden: Boolean(isolatedPartId && isolatedPartId !== part.id) || part.hidden,
    pose: part.id === ghostPart?.id ? assembly.draft!.pose : part.pose,
  })) : undefined, [parts, isolatedPartId, ghostPart?.id, assembly.draft?.pose]);
  const [aimingLight, setAimingLight] = useState(false);
  const [showLighting, setShowLighting] = useState(true);
  const [previewBeforeFill, setPreviewBeforeFill] = useState(false);
  const [repaintFill, setRepaintFill] = useState(false);
  const [pendingModel, setPendingModel] = useState<ModelSummary | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const isBusy = isImporting || kitImporting || Boolean(pendingModel) || isCommitting || projectAction !== null;
  const fillEnabled = canPaintPart && !assembly.draft && !(showLighting && aimingLight) && !isImporting && !kitImporting &&
    !pendingModel && projectAction !== 'open' && shadow.tool === 'fill' && Boolean(shadow.recipe);
  const fill = useConnectedFill(api, fillEnabled, shadow.recipe?.id, shadow.committedCoverage,
    previewBeforeFill, repaintFill, shadow.commitFill);
  const fillPickVersion = useRef(0);
  function cancelFill() {
    ++fillPickVersion.current;
    fill.cancel();
  }
  const [orientation, setOrientation] = useState<ModelOrientation>({
    upright: '+Y',
    front: '+Z',
  });
  const attached = parts.filter((part) => !part.staged);
  const layoutKey = attached.length > 1 ? JSON.stringify(attached.map(({ id, faceOffset, pose }) => [id, faceOffset, pose])) : undefined;
  const lighting = useSurfaceLighting(api, model?.modelId, orientation, shadow.committedCoverage,
    attached.length > 1 ? attached.map((part) => ({ modelId: part.model.modelId, pose: part.pose, faceOffset: part.faceOffset })) : undefined,
    layoutKey);
  const lightCameraSequence = useRef(0);
  const [lightCameraRequest, setLightCameraRequest] = useState<number | null>(null);
  const lightDirection = useMemo(() => worldLightDirection(lighting.azimuth, lighting.elevation).toArray(),
    [lighting.azimuth, lighting.elevation]);
  useEffect(() => {
    if (!lighting.previewing || !lighting.hasShadow || !lighting.source || !canPaintPart || assembly.draft) {
      setAimingLight(false);
      setLightCameraRequest(null);
    }
  }, [lighting.previewing, lighting.hasShadow, lighting.source?.id, canPaintPart, assembly.draft]);
  const edge = useEdgeHighlight(api, displayModel?.modelId, shadow.recipe?.id, shadow.committedCoverage, paintPart);
  const guideEdges = useMemo(() => clipEdgeCoverage(edge.committed, shadow.committedCoverage), [edge.committed, shadow.committedCoverage]);
  const projectContents = useMemo(() => ({}), [recipes, referenceEdits, orientation, parts, assembly.joints,
    guideInstallation, guideCallouts, activeRecipeId, shadow.committedCoverage, edge.committed,
    lighting.sources, lighting.midtone, lighting.highlight, lighting.castShadowsBetweenParts,
    lighting.appliedLightKey, lighting.manual ? lighting.committedMask : null]);
  const [savedContents, setSavedContents] = useState<typeof projectContents | null>(null);
  const latestProjectContents = useRef(projectContents);
  latestProjectContents.current = projectContents;
  const replacementPromptOpen = useRef(false);
  const cleanAfterReplacement = useRef(false);
  const projectDirty = Boolean(model && savedContents && savedContents !== projectContents);

  useEffect(() => {
    if (!cleanAfterReplacement.current) return;
    cleanAfterReplacement.current = false;
    setSavedContents(projectContents);
  }, [model, projectContents]);

  useEffect(() => {
    if (!projectDirty || !api?.saveProject) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = false;
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [projectDirty, api]);

  const refreshRecentProjects = useCallback(() => {
    void api?.listRecentProjects?.().then(setRecentProjects).catch(() => {});
  }, [api]);
  useEffect(refreshRecentProjects, [refreshRecentProjects]);

  async function canReplaceProject() {
    if (replacementPromptOpen.current) return false;
    replacementPromptOpen.current = true;
    try {
      if (!api?.confirmProjectReplacement) {
        return window.confirm('Discard unsaved changes and open another file?');
      }
      const choice = await api.confirmProjectReplacement();
      if (choice === 'save') return await saveProject();
      return choice === 'discard';
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Unable to confirm switching projects.');
      return false;
    } finally {
      replacementPromptOpen.current = false;
    }
  }
  const coverage = useMemo(() => {
    const base = fill.previewCoverage ?? shadow.coverage;
    const tones = showLighting ? renderToneMask(base, lighting.mask) : base;
    const withEdges = applyEdgesOver(tones, edge.coverage, base);
    return edge.preview ? applyEdgesOver(withEdges, edge.preview, shadow.committedCoverage, true) : withEdges;
  }, [fill.previewCoverage, shadow.coverage, shadow.committedCoverage, showLighting, lighting.mask, edge.coverage, edge.preview]);
  const shadowColors = useMemo(() => {
    const colors = new Map(shadow.colors);
    if (fill.previewCoverage) colors.set(FILL_PREVIEW_RECIPE, '#76d9ac');
    colors.set(EDGE_PREVIEW, '#72dfae');
    colors.set(JOINT_HIGHLIGHT, '#ffce78');
    for (const recipe of recipes) {
      colors.set(edgeColorKey(recipe.id), recipe.edgeSwatch?.hex ?? '#48a887');
      colors.set(toneColorKey(recipe.id, 'midtone'), recipe.swatches.midtone.hex);
      colors.set(toneColorKey(recipe.id, 'highlight'), recipe.swatches.highlight.hex);
    }
    return colors;
  }, [fill.previewCoverage, shadow.colors, recipes]);
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const [progress, setProgress] = useState<ImportProgressEvent | null>(null);
  const [isDraggingStl, setIsDraggingStl] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [cameraPresetRequest, setCameraPresetRequest] = useState<{
    preset: CameraPreset;
    seq: number;
  } | null>(null);

  const importInFlight = useRef(false);
  const pendingModelRef = useRef<ModelSummary | null>(null);
  pendingModelRef.current = pendingModel;
  const activeModelIdRef = useRef<string | null>(null);
  activeModelIdRef.current = displayModel?.modelId ?? null;
  const appModelGenRef = useRef(0);
  const appViewGenRef = useRef(0);
  const pickSeqRef = useRef(0);
  const pickContext = useMemo(() => ({}), [displayModel, companionParts, fillEnabled, previewBeforeFill, repaintFill,
    shadow.recipe?.id, assembly.draft]);
  const pickContextRef = useRef(pickContext);
  pickContextRef.current = pickContext;
  const pendingFillPick = useRef<{
    context: typeof pickContext;
    viewGeneration: number;
    version: number;
    done: Promise<void>;
  }>(null);

  useEffect(() => {
    if (!api) return;
    const unsub = api.onImportProgress((evt) => {
      if (importInFlight.current) setProgress(evt);
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
    if (!api || importInFlight.current || isBusy || replacementPromptOpen.current) return;
    if (projectDirty && !await canReplaceProject()) return;
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
      setActiveTab('model');
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

  function showTutorialStep(index: number) {
    if (projectMenu.current) projectMenu.current.open = false;
    setTutorialIndex(index);
    setActiveTab(tutorialSteps[index].tab);
  }

  function closeTutorial() {
    setTutorialIndex(null);
    tutorialButton.current?.focus();
  }

  function openTutorialProjectMenu() {
    const menu = projectMenu.current;
    if (!menu) return;
    menu.open = true;
    menu.querySelector('summary')?.focus();
  }

  const tutorialTarget = tutorialStep?.tab === activeTab && tutorialStep.id;
  useEffect(() => {
    if (!tutorialTarget || tutorialTarget === 'finish') return;
    const target = document.querySelector(`[data-tutorial-target="${tutorialTarget}"]`);
    const anchor = tutorialTarget === 'recipe' ? target?.querySelector('h2') : target;
    anchor?.scrollIntoView?.({ block: 'nearest' });
  }, [tutorialTarget, model]);

  const loadPracticeModel = api?.importPracticeModel;
  const handleStlDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const canDrop = Boolean(api?.importDroppedStl || api?.openDroppedProject) && !isBusy && !importInFlight.current;
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
    if (files.length === 1 && /.paintproject$/i.test(files[0].name) && api?.openDroppedProject) {
      void openProject(files[0]);
      return;
    }
    const importDroppedStl = api?.importDroppedStl;
    if (!importDroppedStl || isBusy) return;

    void importFrom(async () => {
      const file = files[0];
      if (files.length !== 1 || !file || !/\.(stl|obj)$/i.test(file.name)) {
        throw new Error(api?.openDroppedProject ? 'Drop one .stl, .obj, or .paintproject file at a time.' : 'Drop one .stl or .obj file at a time.');
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

  async function saveProject(saveAs = false) {
    if (!api?.saveProject || !model || !paletteProject.current || isBusy || importInFlight.current) return false;
    if (projectMenu.current) projectMenu.current.open = false;
    setProjectAction('save');
    setStatusMsg(null);
    setProjectNotice('');
    const savingContents = projectContents;
    try {
      const paint = shadow.exportProject();
      const lightingProject = lighting.exportProject(recipes, shadow.committedCoverage);
      const edgeProject = edge.exportProject(recipes, shadow.committedCoverage);
      const palette = await paletteProject.current.exportProject();
      const saved = await api.saveProject({
        modelId: model.modelId,
        ...(saveAs ? { saveAs: true } : {}),
        kitModelIds: parts.slice(1).map((part) => part.model.modelId),
        state: {
          orientation,
          recipes,
          ...palette.state,
          activeRecipeId: shadow.recipe?.id ?? null,
          lighting: lightingProject.lighting,
          edgeManualRecipes: edgeProject.manual,
          guideCallouts: guideCallouts.filter(({ recipeId }) => recipes.some(({ id }) => id === recipeId)),
          kit: parts.length ? {
            parts: parts.map(({ id, name, model: partModel, pose, hidden, staged, placementConfirmed, faceOffset, batchOffset }) => ({
              id, name, sourceName: partModel.fileName, pose, hidden, staged, placementConfirmed, faceOffset, batchOffset,
            })),
            joints: assembly.joints,
            installation: guideInstallation,
          } : undefined,
        },
        referenceBytes: palette.referenceBytes,
        paint,
        toneMask: lightingProject.toneMask,
        edgeMask: edgeProject.packed,
      });
      if (saved) {
        setProjectFile(saved);
        setSavedContents(savingContents);
        setProjectNotice(`Saved ${saved.name}`);
        refreshRecentProjects();
        return latestProjectContents.current === savingContents;
      }
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Unable to save the paint project.');
    } finally {
      setProjectAction(null);
    }
    return false;
  }

  async function openProject(origin?: string | File) {
    if (!api?.openProject || !paletteProject.current || isBusy || importInFlight.current || replacementPromptOpen.current) return;
    if (projectDirty && !await canReplaceProject()) return;
    const paletteHandle = paletteProject.current;
    if (projectMenu.current) projectMenu.current.open = false;
    importInFlight.current = true;
    setProjectAction('open');
    setStatusMsg(null);
    setProjectNotice('');
    let project: OpenedProject | null = null;
    try {
      project = origin instanceof File ? await api.openDroppedProject?.(origin) ?? null : await api.openProject(origin);
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
      refreshRecentProjects();
    }
  }

  const handleProjectShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat || event.defaultPrevented || guideOpen) return;
    const key = event.key.toLowerCase();
    if (key === 's' && api?.saveProject) {
      event.preventDefault();
      void saveProject(event.shiftKey);
    } else if (key === 'o' && !event.shiftKey && api?.openProject) {
      event.preventDefault();
      void openProject();
    } else if (key === 'n' && !event.shiftKey && api?.openProject) {
      event.preventDefault();
      if (projectMenu.current) projectMenu.current.open = false;
      handleOpenStl();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleProjectShortcut(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  function fitKit(parts: KitPart[]) {
    if (parts.length <= 1) {
      setKitBounds(undefined);
      return;
    }
    const bounds = new Box3();
    const partBounds = new Box3();
    for (const part of parts) {
      partBounds.min.fromArray(part.model.bounds.min);
      partBounds.max.fromArray(part.model.bounds.max);
      bounds.union(partBounds.applyMatrix4(poseMatrix(part.pose)));
    }
    setKitBounds({ min: bounds.min.toArray(), max: bounds.max.toArray() });
  }

  function choosePart(part: KitPart, remove?: KitPart) {
    if (pendingModelRef.current || importInFlight.current || part.id === focusId) return;
    cancelFill();
    lighting.cancel();
    edge.cancel();
    shadow.setTool(null);
    lighting.setBrushTool(null);
    edge.setTool(null);
    setPickResult(null);
    setStatusMsg(null);
    setPaintIsolation((id) => id ? part.id : null);
    focusPending.current = { id: part.id, modelId: part.model.modelId, remove };
    pendingModelRef.current = part.model;
    setPendingModel(part.model);
  }

  async function addKitParts() {
    if (!api?.importKitParts || !model || importInFlight.current || pendingModelRef.current) return;
    importInFlight.current = true;
    setKitImporting(true);
    setStatusMsg(null);
    try {
      const result = await api.importKitParts();
      if (!result) return;
      if (result.models.length) {
        const next = [...parts];
        for (const part of result.models) {
          next.push({
            id: part.partId, name: part.fileName.replace(/\.stl$/i, ''), model: part,
            pose: IDENTITY_PART_POSE, staged: true, hidden: false, ...nextPartAddress(next),
          });
        }
        setParts(next);
        fitKit(next);
      }
      const feedback = [...result.errors];
      if (result.canceled) feedback.push('Import canceled. Previously staged parts are still available.');
      if (feedback.length) setStatusMsg(feedback.join(' '));
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Could not add kit parts.');
    } finally {
      setProgress(null);
      setKitImporting(false);
      importInFlight.current = false;
    }
  }

  async function discardKitPart(part: KitPart) {
    try {
      const discarded = await api?.discardModel?.(part.model.modelId);
      if (discarded?.discarded) {
        setParts((current) => current.filter((item) => item.id !== part.id));
        fitKit(parts.filter((item) => item.id !== part.id));
      } else {
        setStatusMsg('Could not remove the staged part.');
      }
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Could not remove the staged part.');
    }
  }

  const handleCancelImport = async () => {
    if (!api || isCommitting) return;
    if (isImporting || kitImporting) {
      await api.cancelImport();
      return;
    }
    const staged = pendingModelRef.current;
    if (staged) {
      pendingModelRef.current = null;
      setPendingModel(null);
      if (focusPending.current?.modelId === staged.modelId) {
        focusPending.current = null;
        return;
      }
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
      const focus = focusPending.current;
      if (focus?.modelId === committed.modelId && pendingModelRef.current?.modelId === committed.modelId) {
        focusPending.current = null;
        pendingModelRef.current = null;
        ++appModelGenRef.current;
        activeModelIdRef.current = committed.modelId;
        setFocusId(focus.id);
        setPendingModel(null);
        if (focus.remove) void discardKitPart(focus.remove);
        return true;
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
        cleanAfterReplacement.current = true;
        setProjectFile(opened?.project.file ?? null);
        setProjectNotice(opened?.project.file ? `Opened ${opened.project.file.name}` : '');
        cancelFill();
        if (opened) {
          const { state, paint, toneMask, edgeMask } = opened.project;
          setOrientation(state.orientation);
          setRecipes(state.recipes);
          setActiveRecipeId(state.activeRecipeId);
          setGuideCallouts(state.guideCallouts ?? []);
          shadow.restoreProject(state, paint);
          lighting.restoreProject(state, toneMask);
          edge.restore(state.edgeManualRecipes, edgeMask, state.recipes);
          opened.palette.apply();
        } else {
          setGuideCallouts([]);
          shadow.reset();
          lighting.reset();
          edge.reset();
        }
        setModel(committed);
        const kit = opened?.project.state.kit;
        const sourceModels = [committed, ...(opened?.project.kitModels ?? [])];
        const nextParts = kit ? restoreKitAddresses(sourceModels, kit)
          : [{ id: committed.partId, name: committed.fileName.replace(/\.(stl|obj)$/i, ''),
            model: committed, pose: IDENTITY_PART_POSE, hidden: false, staged: false, ...ANCHOR_ADDRESS }];
        setPaintIsolation(null);
        setParts(nextParts);
        setFocusId(nextParts[0].id);
        fitKit(nextParts);
        assembly.reset(kit?.joints);
        setInstallation(kit?.installation ?? EMPTY_INSTALLATION);
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
    [api, model, parts],
  );

  const handlePendingModelError = useCallback(
    async (err: Error) => {
      const staged = pendingModelRef.current;
      if (!staged) return;
      pendingModelRef.current = null;
      setPendingModel(null);
      if (focusPending.current?.modelId === staged.modelId) {
        focusPending.current = null;
        setStatusMsg(err.message);
        return;
      }
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

  const handleSurfacePick = (
    origin: Vec3,
    direction: Vec3,
    batchIndices: number[],
    token: PickGenerationToken,
  ) => {
    if (!api || !displayModel || isBusy || token.modelId !== displayModel.modelId) return;
    const startAppModelGen = appModelGenRef.current;
    const startAppViewGen = appViewGenRef.current;
    const version = fillPickVersion.current;
    const directFill = fillEnabled && !previewBeforeFill;
    const sequence = ++pickSeqRef.current;
    const isCurrent = () =>
      activeModelIdRef.current === token.modelId &&
      appModelGenRef.current === startAppModelGen &&
      appViewGenRef.current === startAppViewGen &&
      pickContextRef.current === pickContext &&
      (!fillEnabled || fillPickVersion.current === version) &&
      (directFill || pickSeqRef.current === sequence);

    const pick = async () => {
      if (!isCurrent()) return;
      try {
        const companionRays = () => {
          if (!selectedPart) return [];
          const ray = new Ray(new Vector3(...origin), new Vector3(...direction)).applyMatrix4(poseMatrix(selectedPart.pose));
          return (companionParts ?? []).flatMap((part) => {
            if (part.id === selectedPart.id || part.hidden || part.staged || part.id === ghostPart?.id) return [];
            const local = ray.clone().applyMatrix4(poseMatrix(part.pose).invert());
            const start = local.origin.toArray();
            const forward = local.direction.toArray();
            const batches = findRayIntersectingBatchIndices(part.model.batches, start, forward);
            const address = { faceOffset: part.faceOffset, batchOffset: part.batchOffset };
            return batches.length ? [{ model: part.model, address, start, forward, batches }] : [];
          });
        };
        if (fillEnabled && shadow.recipe) {
          const targets = companionRays();
          if (batchIndices.length) {
            targets.unshift({ model: displayModel, address: selectedPart ?? ANCHOR_ADDRESS,
              start: origin, forward: direction, batches: batchIndices });
          }
          const hits = await Promise.all(targets.map(async (target) => ({
            target, hit: await api.pickFace(target.model.modelId, target.start, target.forward, target.batches),
          })));
          if (!isCurrent()) return;
          let closest: { target: typeof targets[number]; distance: number; faceId: number } | undefined;
          for (const { target, hit } of hits) {
            if (!hit.hit || hit.partId !== target.model.partId || hit.distance === null || hit.originalFaceId === null) continue;
            if (!closest || hit.distance < closest.distance) {
              closest = { target, distance: hit.distance, faceId: hit.originalFaceId };
            }
          }
          if (closest) {
            fill.select({ model: closest.target.model, address: closest.target.address,
              faceId: closest.faceId, recipeId: shadow.recipe.id });
          }
          return;
        }

        const result = await api.pickFace(displayModel.modelId, origin, direction, batchIndices);
        if (!isCurrent()) return;
        if (result.hit && result.distance !== null && assembly.draft) {
          const hits = await Promise.all(companionRays().map(({ model, start, forward, batches }) =>
            api.pickFace(model.modelId, start, forward, batches)));
          if (!isCurrent()) return;
          const distance = result.distance;
          if (hits.some((hit) => hit.hit && hit.distance !== null && hit.distance < distance - 1e-5)) {
            setStatusMsg('The selected surface is behind another part. Hide that part or isolate the target.');
            return;
          }
        }
        if (assembly.draft && selectedPart) void assembly.capture(selectedPart, result);
        setPickResult(result);
      } catch (error) {
        if (isCurrent()) setStatusMsg(error instanceof Error ? error.message : 'Surface pick failed.');
      }
    };

    if (!directFill) return pick();
    // Preserve click order for Fill so Undo reverses the most recent applied click.
    const previous = pendingFillPick.current;
    const sameView = previous?.context === pickContext && previous.viewGeneration === startAppViewGen && previous.version === version;
    const done = sameView ? previous.done.then(pick) : pick();
    const pending = { context: pickContext, viewGeneration: startAppViewGen, version, done };
    pendingFillPick.current = pending;
    void done.finally(() => {
      if (pendingFillPick.current === pending) pendingFillPick.current = null;
    });
    return done;
  };

  const triggerCameraPreset = (preset: CameraPreset) => {
    setCameraPresetRequest((prev) => ({ preset, seq: (prev?.seq ?? 0) + 1 }));
  };

  const progressPct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : 0;

  return (
    <div className="app-shell" data-tutorial-step={tutorialTarget || undefined}>
      <a className="skip-link" href={activeTab === 'model' ? '#viewport-region' : '#palette-workspace'}>
        Skip to workspace
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
          {(projectFile || projectDirty) && <span className="project-filename" title={projectFile?.path}>
            {projectFile?.name ?? 'Untitled project'}{projectDirty && <span aria-label="Unsaved changes"> *</span>}
          </span>}
          {api?.openProject && api.saveProject && (
            <details className="project-menu" ref={projectMenu}>
              <summary className="btn btn--secondary" data-tutorial-target="finish">Project</summary>
              <div className="project-menu-actions">
                <button type="button" className="btn btn--secondary" disabled={isBusy} onClick={() => {
                  if (projectMenu.current) projectMenu.current.open = false;
                  handleOpenStl();
                }}>
                  New from model <kbd aria-hidden="true">Ctrl+N</kbd>
                </button>
                <button type="button" className="btn btn--secondary" disabled={isBusy} onClick={() => void openProject()}>
                  Open project <kbd aria-hidden="true">Ctrl+O</kbd>
                </button>
                <button type="button" className="btn btn--secondary" disabled={isBusy || !model} onClick={() => void saveProject()}>
                  Save project <kbd aria-hidden="true">Ctrl+S</kbd>
                </button>
                <button type="button" className="btn btn--secondary" disabled={isBusy || !model} onClick={() => void saveProject(true)}>
                  Save project as <kbd aria-hidden="true">Ctrl+Shift+S</kbd>
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
                {recentProjects.length > 0 && (
                  <div className="project-recents" aria-label="Recent projects">
                    <span>Open recent</span>
                    {recentProjects.map((file) => (
                      <button type="button" className="btn btn--secondary" key={file.path} title={file.path} disabled={isBusy}
                        onClick={() => void openProject(file.path)}>{file.name}</button>
                    ))}
                  </div>
                )}
              </div>
            </details>
          )}
          {(isImporting || kitImporting || pendingModel || isCommitting) ? (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleCancelImport}
              disabled={isCommitting}
            >
              Cancel import
            </button>
          ) : null}
          <button ref={tutorialButton} type="button" className="btn btn--secondary" aria-pressed={tutorialIndex !== null}
            onClick={() => tutorialIndex === null ? showTutorialStep(0) : closeTutorial()}>Tutorial</button>
          {(model || isBusy || activeTab === 'palette') && (
            <button type="button" className="btn btn--primary" onClick={handleOpenStl}
              disabled={!api || isBusy}>Open model</button>
          )}
        </div>
      </header>

      {tutorialIndex !== null && (
        <ModelTutorial index={tutorialIndex} onStep={showTutorialStep} onClose={closeTutorial}
          hasModel={Boolean(model)} busy={isBusy}
          onProjectMenu={api?.openProject && api.saveProject ? openTutorialProjectMenu : undefined}
          onPractice={loadPracticeModel ? () => void importFrom(async () => loadPracticeModel) : undefined} />
      )}

      {projectNotice && !projectDirty && <div className="project-notice" role="status">{projectNotice}</div>}

      {ResolvedPalette ? (
        <main
          id="palette-workspace"
          tabIndex={-1}
          className="palette-host"
          data-testid="palette-host"
          hidden={activeTab !== 'palette'}
        >
          {paletteWorkspace}
        </main>
      ) : null}

      <main className="workbench-main" data-empty={!model || undefined} hidden={activeTab !== 'model'}>
        <section
          id="viewport-region"
          tabIndex={-1}
          className="viewport-region"
          aria-label="STL surface viewport"
          onDragOver={handleStlDragOver}
          onDragLeave={handleStlDragLeave}
          onDrop={handleStlDrop}
        >
          {model && (
            <div className="viewport-toolbar" role="group" aria-label="Camera controls">
              <button type="button" className="btn btn--secondary btn--small" aria-label="Reset view"
                onClick={() => triggerCameraPreset('reset')}>Reset view</button>
              {(['front', 'top', 'right'] as const).map((preset) => {
                const label = preset[0].toUpperCase() + preset.slice(1);
                return <button type="button" key={preset} className="btn btn--secondary btn--small" aria-label={label + ' view'}
                  onClick={() => triggerCameraPreset(preset)}>{label}</button>;
              })}
              {parts.length > 1 && (
                <button type="button" className="btn btn--secondary btn--small"
                  onClick={() => triggerCameraPreset('focus')}>Fit selected part</button>
              )}
              {assembly.draft && (['back', 'bottom', 'left'] as const).map((preset) => {
                const label = preset[0].toUpperCase() + preset.slice(1);
                return <button type="button" key={preset} className="btn btn--secondary btn--small" aria-label={label + ' view'}
                  onClick={() => triggerCameraPreset(preset)}>{label}</button>;
              })}
              <span className="viewport-toolbar__hint">Drag to orbit · Right-drag to pan · Scroll to zoom</span>
            </div>
          )}

          <Viewport3D
            api={api}
            active={activeTab === 'model'}
            model={displayModel}
            companionParts={companionParts}
            ghostModelId={ghostPart?.model.modelId}
            jointMarker={jointMarker}
            focusPose={selectedPart?.pose}
            hideFocused={selectedPart?.hidden || selectedPart?.id === ghostPart?.id && Boolean(ghostPart) || Boolean(isolatedPartId && isolatedPartId !== selectedPart?.id)}
            fitBounds={kitBounds}
            pendingModel={pendingModel}
            orientation={orientation}
            cameraPresetRequest={cameraPresetRequest}
            highlightPickFace={assembly.draft?.method === 'six-face' && assembly.expectedId === focusId}
            onSurfacePick={handleSurfacePick}
            fillPick={fillEnabled}
            showLighting={showLighting}
            lightPlacement={{
              active: showLighting && aimingLight && lighting.previewing && Boolean(lighting.source) && lighting.hasShadow && canPaintPart && !assembly.draft && !isBusy,
              direction: lightDirection,
              cameraRequest: lightCameraRequest,
              onDirection: lighting.aimLight,
            }}
            shadowPaint={{
              enabled: Boolean(model && canPaintPart && !assembly.draft && !isBusy && (edge.tool || lighting.brushTool ||
                (shadow.tool && shadow.tool !== 'fill' && shadow.recipe))),
              coverage: assembly.draft ? assembly.overlay : coverage,
              baseCoverage: shadow.coverage,
              companionCoverage: coverage,
              lightPreview: showLighting ? lighting.lightPreview : null,
              address: assembly.draft ? ANCHOR_ADDRESS : paintPart,
              colors: shadowColors,
              diameter: shadow.brushSize,
              onFaces: edge.tool ? edge.paintFaces : lighting.brushTool ? lighting.paintFaces : shadow.paintFaces,
              onStart: edge.tool ? edge.beginBrush : lighting.brushTool ? lighting.beginBrush : shadow.beginStroke,
              onEnd: edge.tool ? edge.endBrush : lighting.brushTool ? lighting.endBrush : shadow.endStroke,
            }}
            onPickNeedsDetail={handlePickNeedsDetail}
            onViewChange={handleViewChange}
            onPendingModelCommit={handlePendingModelCommit}
            onPendingModelError={handlePendingModelError}
            disableWebGL={disableWebGL}
          />

          {!model && !isBusy ? (
            <div className="workspace-welcome">
              <div className="workspace-welcome__inner" data-enter>
                <div className="workspace-welcome__copy">
                  <h2>Paint your 3D model</h2>
                  <p>Build paint recipes, color the surfaces, and turn the finished model into a step-by-step painting guide.</p>
                  <div className="workspace-welcome__actions">
                    <button type="button" className="btn btn--primary" onClick={handleOpenStl}
                      disabled={!api}>Open model</button>
                    {tutorialIndex === null && (
                      <button type="button" className="btn btn--secondary" onClick={() => showTutorialStep(0)}>
                        Start tutorial
                      </button>
                    )}
                  </div>
                  {api?.importDroppedStl && <p className="workspace-welcome__note">
                    {api.openDroppedProject ? 'Drop an STL, OBJ, or Paint Pallet project here.' : 'Drop an STL or OBJ file here.'}
                    {!api?.openProject && stlLimitLabel && ` Binary STLs up to ${stlLimitLabel}.`}
                  </p>}
                </div>
                <div className="workspace-welcome__visual">
                  <img src={fieldRobotUrl} alt="Painted Field Robot miniature on an octagonal base"
                    width={760} height={760} draggable={false} />
                </div>
              </div>
            </div>
          ) : null}

          {isDraggingStl && !isBusy ? (
            <div className="stl-drop-overlay" aria-hidden="true">
              {api?.openDroppedProject ? 'Drop file to open' : 'Drop model to open'}
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
            <div className="progress-overlay" role="status">{projectAction === 'open' ? 'Opening projectâ€¦' : 'Saving projectâ€¦'}</div>
          ) : null}

          {progress && (isImporting || kitImporting || projectAction === 'open') ? (
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

        <aside className="inspector-panel" aria-label="Model inspector" hidden={!model}>
          {model && (
            <div className="inspector-section">
              <label className="hint-text">
                <input type="checkbox" checked={showLighting} disabled={lighting.brushPending}
                  onChange={(event) => {
                    const visible = event.target.checked;
                    if (!visible) lighting.setBrushTool(null);
                    setShowLighting(visible);
                  }} />
                Show lighting
              </label>
            </div>
          )}
          {api?.importKitParts && model && (
            <KitPanel key={model?.modelId} parts={parts} selected={selectedPart} busy={isBusy || Boolean(assembly.draft) ||
              shadow.strokePending || lighting.brushPending || edge.stroke}
              choose={choosePart} add={addKitParts} confirmPlacement={assembly.confirmPlacement}
              isolated={paintIsolation !== null}
              toggleIsolation={() => {
                if (!selectedPart) return;
                setPaintIsolation(paintIsolation ? null : selectedPart.id);
                if (selectedPart.hidden && !paintIsolation) {
                  setParts((current) => current.map((item) => item.id === selectedPart.id ? { ...item, hidden: false } : item));
                }
              }}
              toggleVisibility={() => setParts((current) => current.map((item) => item.id === focusId ? { ...item, hidden: !item.hidden } : item))}
              rename={(name) => setParts((current) => current.map((part) => part.id === focusId ? { ...part, name } : part))}
              remove={(part) => parts[0] && choosePart(parts[0], part)}
            />
          )}
          {parts.length > 1 && <JointPanel assembly={assembly} parts={parts} selected={selectedPart}
            busy={isBusy || shadow.strokePending || lighting.brushPending || edge.stroke} />}
          {model && canPaintPart && !assembly.draft && (
            <ShadowPanel
              paint={shadow}
              fill={fill}
              onCancelFill={cancelFill}
              recipes={recipes}
              onRecipeChange={setActiveRecipeId}
              busy={isBusy || lighting.brushPending || edge.stroke}
              onToolChange={(tool) => {
                edge.cancel();
                edge.setTool(null);
                lighting.setBrushTool(null);
                shadow.setTool(tool);
              }}
              previewBeforeFill={previewBeforeFill}
              repaintFill={repaintFill}
              setRepaintFill={(value) => {
                cancelFill();
                setRepaintFill(value);
              }}
              setPreviewBeforeFill={(value) => {
                cancelFill();
                setPreviewBeforeFill(value);
              }}
              onApplyFill={() => {
                fill.applyPreview();
                cancelFill();
              }}
            />
          )}
          {model && canPaintPart && !assembly.draft && lighting.available && (
            <LightingPanel
              lighting={lighting}
              aiming={showLighting && aimingLight}
              onAim={() => {
                if (aimingLight) {
                  setAimingLight(false);
                  setLightCameraRequest(null);
                  return;
                }
                cancelFill();
                shadow.setTool(null);
                edge.cancel();
                edge.setTool(null);
                lighting.start();
                setAimingLight(true);
              }}
              onAimFromCamera={() => {
                cancelFill();
                shadow.setTool(null);
                edge.cancel();
                edge.setTool(null);
                lighting.start();
                setAimingLight(true);
                setLightCameraRequest(++lightCameraSequence.current);
              }}
              busy={!showLighting || isBusy || shadow.strokePending || lighting.brushPending || edge.stroke}
              onSourceChange={() => {
                setAimingLight(false);
                setLightCameraRequest(null);
              }}
              onPreview={() => {
                edge.cancel();
                edge.setTool(null);
                lighting.start();
              }}
              brushSize={shadow.brushSize}
              onBrushSize={shadow.setBrushSize}
              onChooseBrush={(tool) => {
                if (tool) {
                  edge.cancel();
                  edge.setTool(null);
                  cancelFill();
                  shadow.setTool(null);
                }
                lighting.setBrushTool(tool);
              }}
            />
          )}

          {model && canPaintPart && !assembly.draft && edge.available && (
            <EdgePanel edge={edge} busy={isBusy || shadow.strokePending || lighting.brushPending || edge.stroke}
              brushSize={shadow.brushSize} setBrushSize={shadow.setBrushSize}
              beginPreview={() => {
                lighting.cancel();
                lighting.setBrushTool(null);
                cancelFill();
                shadow.setTool(null);
                edge.start();
              }}
              chooseTool={(tool) => {
                lighting.cancel();
                lighting.setBrushTool(null);
                cancelFill();
                shadow.setTool(null);
                edge.setTool(tool);
              }}
            />
          )}

          <section className="inspector-section">
            <h2>Model summary</h2>
            {displayModel ? (
              <dl className="kv-list">
                <dt>File</dt>
                <dd>{displayModel.fileName}</dd>
                <dt>Triangles</dt>
                <dd>{displayModel.triangleCount.toLocaleString()}</dd>
                <dt>Spatial batches</dt>
                <dd>{displayModel.batches.length}</dd>
                <dt>Bounds min</dt>
                <dd>
                  {displayModel.bounds.min.map((v) => v.toFixed(1)).join(', ')}
                </dd>
                <dt>Bounds max</dt>
                <dd>
                  {displayModel.bounds.max.map((v) => v.toFixed(1)).join(', ')}
                </dd>
              </dl>
            ) : (
              <p className="hint-text">No STL loaded.</p>
            )}
          </section>

          <section className="inspector-section" data-tutorial-target="model">
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

        </aside>
      </main>
      {guideOpen && api && model && (
        <PaintingGuideDialog
          api={api} model={model} orientation={orientation} coverage={shadow.committedCoverage}
          edges={guideEdges} tones={lighting.committedMask} lighting={`${lighting.sources.filter(({ intensity }) => intensity > 0).length} active lights`}
          rows={guideRows} callouts={guideCallouts} setCallouts={setGuideCallouts}
          parts={parts} joints={assembly.joints} installation={guideInstallation} setInstallation={setInstallation}
          unapplied={lighting.unapplied} close={() => setGuideOpen(false)}
        />
      )}
    </div>
  );
}
