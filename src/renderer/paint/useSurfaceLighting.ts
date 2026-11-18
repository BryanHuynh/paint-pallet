import { useEffect, useMemo, useRef, useState } from 'react';
import { Vector3 } from 'three';
import type { ProjectState } from '../../shared/paintProject';
import type { ModelOrientation, PaintPalletApi, Vec3 } from '../../shared/workerProtocol';
import { computeOrientationQuaternion } from '../orientation';
import { generateToneMask, paintToneFaces, type MaskBrushTool, type ToneMask } from './lightingState';
import type { ShadowCoverage, ShadowRegion, SurfaceFace } from './shadowPaint';
import { packToneMask, unpackToneMask } from './projectMasks';

interface ExposureResult {
  key: string;
  scores?: Float32Array;
  error?: string;
}

interface AppliedLighting {
  mask: ToneMask;
  manual: boolean;
}

interface LightingHistory {
  current: AppliedLighting | null;
  undo: (AppliedLighting | null)[];
  redo: (AppliedLighting | null)[];
}

interface LightSettings {
  azimuth: number;
  elevation: number;
  midtone: number;
  highlight: number;
}

interface LightingSnapshot {
  id: string;
  name: string;
  settings: LightSettings;
  history: LightingHistory;
}

interface SnapshotState {
  activeId: string;
  items: LightingSnapshot[];
}

const NO_MASK: ToneMask = new Map();
const emptyHistory = (): LightingHistory => ({ current: null, undo: [], redo: [] });
const initialSettings = (): LightSettings => ({ azimuth: 35, elevation: 50, midtone: 35, highlight: 75 });
const initialSnapshots = (): SnapshotState => ({
  activeId: 'snapshot-1',
  items: [{ id: 'snapshot-1', name: 'Snapshot 1', settings: initialSettings(), history: emptyHistory() }],
});

function localLightDirection(azimuth: number, elevation: number, orientation: ModelOrientation): Vec3 {
  const az = azimuth * Math.PI / 180;
  const el = elevation * Math.PI / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .applyQuaternion(computeOrientationQuaternion(orientation.upright, orientation.front).invert())
    .toArray();
}

export function useSurfaceLighting(
  api: PaintPalletApi | undefined,
  modelId: string | undefined,
  orientation: ModelOrientation,
  shadow: ShadowCoverage,
) {
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const snapshotsRef = useRef(snapshots);
  const nextSnapshotNumber = useRef(2);
  const snapshot = snapshots.items.find((item) => item.id === snapshots.activeId)!;
  const { azimuth, elevation, midtone, highlight } = snapshot.settings;
  const history = snapshot.history;
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState<ExposureResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [brushTool, setBrushTool] = useState<MaskBrushTool | null>(null);
  const [brushDraft, setBrushDraft] = useState<ToneMask | null>(null);
  const strokeRef = useRef<{ tool: MaskBrushTool; start: ToneMask; mask: ToneMask } | null>(null);

  const direction = useMemo(() => localLightDirection(azimuth, elevation, orientation), [
    azimuth, elevation, orientation,
  ]);
  const key = JSON.stringify([modelId, direction]);
  const ready = result?.key === key ? result : null;
  const hasShadow = shadow.size !== 0;

  useEffect(() => {
    const compute = api?.computeLightExposure;
    if (!compute || !modelId || !previewing || !hasShadow || ready) return;
    let active = true;
    let started = false;
    const jobId = crypto.randomUUID();
    const timer = window.setTimeout(async () => {
      started = true;
      try {
        const scores = await compute({ modelId, jobId, direction });
        if (active) setResult({ key, scores });
      } catch (error) {
        if (active) setResult({ key, error: error instanceof Error ? error.message : 'Lighting preview failed.' });
      } finally {
        started = false;
      }
    }, 120);

    return () => {
      active = false;
      window.clearTimeout(timer);
      if (started) void api?.cancelLightExposure?.(jobId).catch(() => {});
    };
  }, [api, modelId, previewing, hasShadow, ready, key, direction]);

  const draft = useMemo(() => {
    if (!previewing || !ready?.scores || !hasShadow) return null;
    return generateToneMask(shadow, ready.scores, midtone, highlight);
  }, [previewing, ready?.scores, hasShadow, shadow, midtone, highlight]);

  function writeSnapshots(next: SnapshotState) {
    snapshotsRef.current = next;
    setSnapshots(next);
  }

  function editSnapshot(update: (current: LightingSnapshot) => LightingSnapshot) {
    const current = snapshotsRef.current;
    writeSnapshots({
      ...current,
      items: current.items.map((item) => item.id === current.activeId ? update(item) : item),
    });
  }

  function setSettings(next: Partial<LightSettings>) {
    setConfirming(false);
    editSnapshot((current) => ({ ...current, settings: { ...current.settings, ...next } }));
  }

  function selectSnapshot(id: string) {
    if (strokeRef.current || !snapshotsRef.current.items.some((item) => item.id === id)) return;
    setPreviewing(false);
    setConfirming(false);
    setBrushTool(null);
    writeSnapshots({ ...snapshotsRef.current, activeId: id });
  }

  function addSnapshot(duplicate: boolean) {
    if (strokeRef.current) return;
    const current = snapshotsRef.current;
    const source = current.items.find((item) => item.id === current.activeId)!;
    const number = nextSnapshotNumber.current++;
    const id = `snapshot-${number}`;
    writeSnapshots({
      ...current,
      items: [...current.items, {
        id,
        name: duplicate ? `${source.name.trim() || 'Snapshot'} copy` : `Snapshot ${number}`,
        settings: duplicate ? { ...source.settings } : initialSettings(),
        history: { ...emptyHistory(), current: duplicate ? source.history.current : null },
      }],
    });
    selectSnapshot(id);
  }

  function currentHistory() {
    const current = snapshotsRef.current;
    return current.items.find((item) => item.id === current.activeId)!.history;
  }

  function writeHistory(history: LightingHistory) {
    editSnapshot((current) => ({ ...current, history }));
  }

  function commit(next: AppliedLighting) {
    const current = currentHistory();
    writeHistory({ current: next, undo: [...current.undo, current.current], redo: [] });
  }

  function apply(confirm = false) {
    if (!draft) return;
    if (currentHistory().current?.manual && !confirm) {
      setConfirming(true);
      return;
    }
    commit({ mask: draft.mask, manual: false });
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
    if (keep && stroke.mask !== stroke.start) commit({ mask: stroke.mask, manual: true });
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
    writeSnapshots(initialSnapshots());
    nextSnapshotNumber.current = 2;
    setBrushDraft(null);
    setBrushTool(null);
    setConfirming(false);
    setResult(null);
    setPreviewing(false);
  }

  function restoreProject(state: ProjectState, tones: Uint32Array[]) {
    reset();
    const items = state.snapshots.map(({ id, name, azimuth, elevation, midtone, highlight, applied, manual }, index) => ({
      id, name, settings: { azimuth, elevation, midtone, highlight },
      history: { ...emptyHistory(), current: applied ? { mask: unpackToneMask(tones[index], state.regions), manual } : null },
    }));
    writeSnapshots({ activeId: state.activeSnapshotId, items });
    nextSnapshotNumber.current = Math.max(0, ...items.map((item) => Number(item.id.replace(/^snapshot-/, '')) || 0)) + 1;
  }

  const applied = history.current;
  return {
    available: Boolean(api?.computeLightExposure),
    hasShadow,
    previewing,
    loading: previewing && hasShadow && !ready,
    error: previewing ? ready?.error : undefined,
    snapshots: snapshots.items,
    snapshot,
    selectSnapshot,
    addSnapshot,
    renameSnapshot: (name: string) => editSnapshot((current) => ({ ...current, name })),
    azimuth, setAzimuth: (value: number) => setSettings({ azimuth: value }),
    elevation, setElevation: (value: number) => setSettings({ elevation: value }),
    midtone, setMidtone: (value: number) => setSettings({ midtone: Math.min(value, highlight) }),
    highlight, setHighlight: (value: number) => setSettings({ highlight: Math.max(value, midtone) }),
    draft,
    mask: brushDraft ?? (applied?.manual ? applied.mask : draft?.mask ?? applied?.mask) ?? NO_MASK,
    applied: Boolean(applied),
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
    exportProject(regions: ShadowRegion[]) {
      return {
        activeSnapshotId: snapshots.activeId,
        snapshots: snapshots.items.map(({ id, name, settings, history }) => ({
          id, name, ...settings, applied: Boolean(history.current), manual: Boolean(history.current?.manual),
        })),
        tones: snapshots.items.map(({ history }) => packToneMask(history.current?.mask ?? NO_MASK, regions)),
      };
    },
    restoreProject,
    reset,
  };
}
