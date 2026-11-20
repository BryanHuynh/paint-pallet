import { useEffect, useMemo, useRef, useState } from 'react';
import { Vector3 } from 'three';
import { lightingConfigurationKey, type ProjectLighting, type ProjectLightSource, type ProjectState } from '../../shared/paintProject';
import type { ExposurePart, ModelOrientation, PaintPalletApi, Vec3 } from '../../shared/workerProtocol';
import { computeOrientationQuaternion } from '../orientation';
import { generateToneMask, paintToneFaces, summarizeExposure, type MaskBrushTool, type ToneMask } from './lightingState';
import type { ShadowCoverage, SurfaceFace } from './shadowPaint';
import { packToneMask, unpackToneMask } from './projectMasks';

interface ExposureResult {
  key: string;
  scores?: Float32Array;
  error?: string;
}

interface AppliedLighting {
  mask: ToneMask;
  manual: boolean;
  lightKey: string;
  automaticCoverage?: ShadowCoverage;
}

interface LightingHistory {
  current: AppliedLighting | null;
  undo: (AppliedLighting | null)[];
  redo: (AppliedLighting | null)[];
}

type LightSettings = Pick<ProjectLighting, 'sources' | 'activeSourceId' | 'midtone' | 'highlight' | 'castShadowsBetweenParts'>;
interface LightingState {
  settings: LightSettings;
  history: LightingHistory;
}

const NO_MASK: ToneMask = new Map();
const emptyHistory = (): LightingHistory => ({ current: null, undo: [], redo: [] });
const initialLighting = (): LightingState => ({
  settings: {
    sources: [{ id: 'light-1', name: 'Light 1', azimuth: 35, elevation: 50, intensity: 100 }],
    activeSourceId: 'light-1', midtone: 35, highlight: 75, castShadowsBetweenParts: true,
  },
  history: emptyHistory(),
});

async function combineExposure(layers: { scores: Float32Array; weight: number }[], active: () => boolean) {
  if (!layers.length) return new Float32Array(0);
  if (layers.length === 1 && layers[0].weight === 1) return layers[0].scores;
  const combined = new Float32Array(layers[0].scores.length);
  const block = 524288;
  for (let start = 0; start < combined.length; start += block) {
    if (!active()) return;
    const end = Math.min(start + block, combined.length);
    for (let face = start; face < end; face++) {
      let total = 0;
      for (const { scores, weight } of layers) total += (scores[face] ?? 0) * weight;
      combined[face] = Math.min(1, total);
    }
    if (end < combined.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  return combined;
}

export function worldLightDirection(azimuth: number, elevation: number): Vector3 {
  const az = azimuth * Math.PI / 180;
  const el = elevation * Math.PI / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

export function lightAngles(direction: Vec3) {
  const unit = new Vector3(...direction).normalize();
  return {
    azimuth: (Math.round(Math.atan2(unit.x, unit.z) * 180 / Math.PI) + 360) % 360,
    elevation: Math.round(Math.asin(Math.max(-1, Math.min(1, unit.y))) * 180 / Math.PI),
  };
}

function localLightDirection(azimuth: number, elevation: number, orientation: ModelOrientation): Vec3 {
  return worldLightDirection(azimuth, elevation)
    .applyQuaternion(computeOrientationQuaternion(orientation.upright, orientation.front).invert())
    .toArray();
}

function refreshAutomaticMask(applied: AppliedLighting, shadow: ShadowCoverage,
  scores: Float32Array, midtone: number, highlight: number): ToneMask {
  if (!applied.automaticCoverage) return generateToneMask(shadow, scores, midtone, highlight).mask;
  const changed = new Map([...shadow].filter(([index, faces]) => faces !== applied.automaticCoverage?.get(index)));
  const mask = new Map(applied.mask);
  for (const index of mask.keys()) {
    if (!shadow.has(index) || changed.has(index)) mask.delete(index);
  }
  for (const [index, batch] of generateToneMask(changed, scores, midtone, highlight).mask) mask.set(index, batch);
  return mask;
}

export function useSurfaceLighting(
  api: PaintPalletApi | undefined,
  modelId: string | undefined,
  orientation: ModelOrientation,
  shadow: ShadowCoverage,
  parts?: ExposurePart[],
  layoutKey?: string,
) {
  const [state, setState] = useState(initialLighting);
  const stateRef = useRef(state);
  const nextLightNumber = useRef(2);
  const { settings, history } = state;
  const source = settings.sources.find(({ id }) => id === settings.activeSourceId);
  const { midtone, highlight } = settings;
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState<ExposureResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [brushTool, setBrushTool] = useState<MaskBrushTool | null>(null);
  const [brushDraft, setBrushDraft] = useState<ToneMask | null>(null);
  const strokeRef = useRef<{ tool: MaskBrushTool; start: ToneMask; mask: ToneMask } | null>(null);

  const plan = useMemo(() => settings.sources.filter(({ intensity }) => intensity > 0)
    .sort((a, b) => a.azimuth - b.azimuth || a.elevation - b.elevation || a.intensity - b.intensity)
    .map(({ azimuth, elevation, intensity }) => ({
      direction: localLightDirection(azimuth, elevation, orientation), weight: intensity / 100,
    })), [settings.sources, orientation]);
  const inputsRef = useRef({ plan, parts });
  inputsRef.current = { plan, parts };
  const cacheRef = useRef({ scope: '', scores: new Map<string, Float32Array>() });
  const hasKit = Boolean(parts && parts.length > 1);
  const castShadowsBetweenParts = !hasKit || settings.castShadowsBetweenParts;
  const scope = JSON.stringify([modelId, layoutKey, castShadowsBetweenParts]);
  const key = JSON.stringify([scope, plan]);
  const lightKey = lightingConfigurationKey(settings, orientation, layoutKey);
  const ready = result?.key === key ? result : null;
  const hasShadow = shadow.size !== 0;
  const applied = history.current;
  const needsAutomaticRefresh = Boolean(api?.computeLightExposure && modelId && applied && !applied.manual &&
    applied.lightKey === lightKey && applied.automaticCoverage !== shadow);
  const shouldTrace = hasShadow && (previewing || needsAutomaticRefresh);

  useEffect(() => {
    const compute = api?.computeLightExposure;
    if (!compute || !modelId || !shouldTrace || ready) return;
    let active = true;
    let jobId: string | undefined;
    const timer = window.setTimeout(async () => {
      const { plan, parts } = inputsRef.current;
      if (cacheRef.current.scope !== scope) cacheRef.current = { scope, scores: new Map() };
      const cache = cacheRef.current.scores;
      const directions = new Set(plan.map(({ direction }) => JSON.stringify(direction)));
      for (const cached of cache.keys()) if (!directions.has(cached)) cache.delete(cached);
      try {
        const layers: { scores: Float32Array; weight: number }[] = [];
        for (const { direction, weight } of plan) {
          const directionKey = JSON.stringify(direction);
          let scores = cache.get(directionKey);
          if (!scores) {
            jobId = crypto.randomUUID();
            scores = await compute({ modelId, jobId, direction, parts,
              ...(castShadowsBetweenParts ? {} : { castShadowsBetweenParts }) });
            jobId = undefined;
            if (!active) return;
            cache.set(directionKey, scores);
          }
          layers.push({ scores, weight });
        }
        const scores = await combineExposure(layers, () => active);
        if (active && scores) setResult({ key, scores });
      } catch (error) {
        if (active) setResult({ key, error: error instanceof Error ? error.message : 'Lighting preview failed.' });
      } finally {
        jobId = undefined;
      }
    }, 120);

    return () => {
      active = false;
      window.clearTimeout(timer);
      if (jobId) void api?.cancelLightExposure?.(jobId).catch(() => {});
    };
  }, [api, modelId, shouldTrace, ready, key, scope, castShadowsBetweenParts]);

  const scores = ready?.scores;
  const distribution = useMemo(() => scores && hasShadow ? summarizeExposure(shadow, scores) : null,
    [scores, hasShadow, shadow]);
  const preview = previewing && scores && distribution ? { scores, midtone, highlight } : null;
  const draft = preview && distribution ? {
    midtoneFaces: distribution.atOrAbove[midtone],
    highlightFaces: distribution.atOrAbove[highlight],
  } : null;

  useEffect(() => {
    if (!needsAutomaticRefresh || !applied || previewing || brushDraft || (hasShadow && !ready?.scores)) return;
    const current = stateRef.current;
    if (current.history.current !== applied) return;
    const mask = hasShadow ? refreshAutomaticMask(applied, shadow, ready!.scores!, midtone, highlight) : NO_MASK;
    writeState({ ...current, history: { ...current.history, current: { ...applied, mask, automaticCoverage: shadow } } });
  }, [needsAutomaticRefresh, applied, previewing, brushDraft, hasShadow, ready?.scores, shadow, midtone, highlight]);

  function writeState(next: LightingState) {
    stateRef.current = next;
    setState(next);
  }

  function setSettings(next: Partial<LightSettings>) {
    setConfirming(false);
    const current = stateRef.current;
    writeState({ ...current, settings: { ...current.settings, ...next } });
  }

  function editSource(next: Partial<Pick<ProjectLightSource, 'name' | 'azimuth' | 'elevation' | 'intensity'>>) {
    const { sources, activeSourceId } = stateRef.current.settings;
    setSettings({ sources: sources.map((light) => light.id === activeSourceId ? { ...light, ...next } : light) });
  }

  function selectSource(id: string) {
    if (!strokeRef.current && stateRef.current.settings.sources.some((light) => light.id === id)) {
      setSettings({ activeSourceId: id });
    }
  }

  function addSource() {
    if (strokeRef.current) return;
    const { sources } = stateRef.current.settings;
    const id = crypto.randomUUID();
    const names = new Set(sources.map((light) => light.name));
    let name: string;
    do { name = `Light ${nextLightNumber.current++}`; } while (names.has(name));
    setSettings({ sources: [...sources, {
      id, name, azimuth: source ? (source.azimuth + 120) % 360 : 35,
      elevation: source ? source.elevation : 50, intensity: sources.length ? 30 : 100,
    }], activeSourceId: id });
  }

  function removeSource() {
    if (strokeRef.current) return;
    const current = stateRef.current.settings;
    const index = current.sources.findIndex(({ id }) => id === current.activeSourceId);
    if (index < 0) return;
    const sources = current.sources.filter(({ id }) => id !== current.activeSourceId);
    setSettings({ sources, activeSourceId: sources[Math.min(index, sources.length - 1)]?.id ?? null });
  }

  function currentHistory() {
    return stateRef.current.history;
  }

  function writeHistory(history: LightingHistory) {
    writeState({ ...stateRef.current, history });
  }

  function commit(next: AppliedLighting) {
    const current = currentHistory();
    writeHistory({ current: next, undo: [...current.undo, current.current], redo: [] });
  }

  function apply(confirm = false) {
    if (!preview) return;
    if (currentHistory().current?.manual && !confirm) {
      setConfirming(true);
      return;
    }
    commit({ mask: generateToneMask(shadow, preview.scores, midtone, highlight).mask,
      manual: false, lightKey, automaticCoverage: shadow });
    setPreviewing(false);
    setConfirming(false);
  }

  function beginBrush(): boolean {
    const current = currentHistory().current;
    if (!brushTool || !current || strokeRef.current) return false;
    strokeRef.current = { tool: brushTool, start: current.mask, mask: current.mask };
    setBrushDraft(current.mask);
    return true;
  }

  function paintFaces(faces: SurfaceFace[]) {
    const stroke = strokeRef.current;
    if (!stroke) return;
    const next = paintToneFaces(stroke.mask, shadow, faces, stroke.tool);
    if (next === stroke.mask) return;
    stroke.mask = next;
    setBrushDraft(next);
  }

  function endBrush(keep: boolean) {
    const stroke = strokeRef.current;
    if (!stroke) return;
    strokeRef.current = null;
    const current = currentHistory().current;
    if (keep && current && stroke.mask !== stroke.start) {
      commit({ mask: stroke.mask, lightKey: current.lightKey, manual: true });
    }
    setBrushDraft(null);
  }

  function undoMask() {
    const current = currentHistory();
    if (!current.undo.length || strokeRef.current) return;
    const previous = current.undo.at(-1) ?? null;
    if (!previous) setBrushTool(null);
    writeHistory({ current: previous, undo: current.undo.slice(0, -1), redo: [...current.redo, current.current] });
  }

  function redoMask() {
    const current = currentHistory();
    if (!current.redo.length || strokeRef.current) return;
    const next = current.redo.at(-1) ?? null;
    if (!next) setBrushTool(null);
    writeHistory({ current: next, undo: [...current.undo, current.current], redo: current.redo.slice(0, -1) });
  }

  function reset() {
    strokeRef.current = null;
    writeState(initialLighting());
    nextLightNumber.current = 2;
    cacheRef.current = { scope: '', scores: new Map() };
    setBrushDraft(null);
    setBrushTool(null);
    setConfirming(false);
    setResult(null);
    setPreviewing(false);
  }

  function restoreProject(project: ProjectState, toneMask: Uint32Array) {
    reset();
    const { applied, manual, appliedLightKey, ...settings } = project.lighting;
    const attached = project.kit?.parts.filter((part) => !part.staged) ?? [];
    const storedLayout = attached.length > 1 && attached.every((part) => part.faceOffset !== undefined)
      ? JSON.stringify(attached.map(({ id, faceOffset, pose }) => [id, faceOffset, pose])) : undefined;
    writeState({ settings, history: emptyHistory() });
    if (applied) writeHistory({ ...emptyHistory(), current: {
      mask: unpackToneMask(toneMask, project.recipes), manual,
      lightKey: appliedLightKey ?? lightingConfigurationKey(settings, project.orientation, storedLayout),
    } });
    nextLightNumber.current = settings.sources.length + 1;
  }

  return {
    available: Boolean(api?.computeLightExposure),
    hasShadow,
    hasKit,
    castShadowsBetweenParts,
    setCastShadowsBetweenParts: (value: boolean) => setSettings({ castShadowsBetweenParts: value }),
    previewing,
    loading: previewing && hasShadow && !ready,
    refreshing: !previewing && needsAutomaticRefresh && hasShadow && !ready?.error,
    error: previewing || needsAutomaticRefresh ? ready?.error : undefined,
    sources: settings.sources,
    source,
    selectSource,
    addSource,
    removeSource,
    aimLight(direction: Vec3) {
      const angles = lightAngles(direction);
      if (source && (angles.azimuth !== source.azimuth || angles.elevation !== source.elevation)) editSource(angles);
    },
    renameSource: (name: string) => editSource({ name }),
    azimuth: source?.azimuth ?? 35, setAzimuth: (value: number) => editSource({ azimuth: value }),
    elevation: source?.elevation ?? 50, setElevation: (value: number) => editSource({ elevation: value }),
    intensity: source?.intensity ?? 0, setIntensity: (value: number) => editSource({ intensity: value }),
    midtone, setMidtone: (value: number) => setSettings({ midtone: Math.min(value, highlight) }),
    highlight, setHighlight: (value: number) => setSettings({ highlight: Math.max(value, midtone) }),
    draft,
    histogram: distribution?.bins,
    lightPreview: applied?.manual ? null : preview,
    mask: brushDraft ?? applied?.mask ?? NO_MASK,
    applied: Boolean(applied),
    appliedLightKey: applied?.lightKey,
    committedMask: applied?.mask ?? NO_MASK,
    unapplied: hasShadow && (!applied || applied.lightKey !== lightKey || needsAutomaticRefresh),
    manual: Boolean(applied?.manual),
    confirming,
    brushTool,
    setBrushTool,
    brushPending: brushDraft !== null,
    beginBrush,
    paintFaces,
    endBrush,
    undoMask,
    redoMask,
    canUndoMask: history.undo.length > 0,
    canRedoMask: history.redo.length > 0,
    start() {
      if (ready?.error) setResult(null);
      setBrushTool(null);
      setPreviewing(true);
    },
    cancel() {
      setPreviewing(false);
      setConfirming(false);
    },
    apply,
    exportProject(recipes: ProjectState['recipes'], coverage: ShadowCoverage) {
      const { settings, history } = stateRef.current;
      return {
        lighting: { ...settings, applied: Boolean(history.current), manual: Boolean(history.current?.manual),
          appliedLightKey: history.current?.lightKey },
        toneMask: packToneMask(history.current?.mask ?? NO_MASK, recipes, coverage),
      };
    },
    restoreProject,
    reset,
  };
}
