import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaintPalletApi } from '../../shared/workerProtocol';
import { unpackFillFaces } from './useConnectedFill';
import { packShadowCoverage, unpackShadowCoverage } from './projectMasks';
import { paintShadowFaces, startShadowStroke, type ShadowCoverage, type ShadowRegion, type ShadowStroke, type ShadowTool, type SurfaceFace } from './shadowPaint';

export const EDGE_PREVIEW = 'edge-highlight-preview';
export const edgeColorKey = (regionId: string) => regionId + ':edge';

interface AppliedEdges {
  coverage: ShadowCoverage;
  manualRegions: ReadonlySet<string>;
}
interface History {
  current: AppliedEdges;
  undo: AppliedEdges[];
  redo: AppliedEdges[];
}
const emptyEdges: AppliedEdges = { coverage: new Map(), manualRegions: new Set() };
const emptyHistory = (current: AppliedEdges = emptyEdges): History => ({ current, undo: [], redo: [] });

export function clipEdgeCoverage(edges: ShadowCoverage, shadow: ShadowCoverage): ShadowCoverage {
  const result = new Map<number, ReadonlyMap<number, SurfaceFace & { regionId: string }>>();
  for (const [batch, marks] of edges) {
    const painted = shadow.get(batch);
    if (!painted) continue;
    const retained = new Map([...marks].filter(([faceId, mark]) => painted.get(faceId)?.regionId === mark.regionId));
    if (retained.size) result.set(batch, retained);
  }
  return result;
}

export function applyEdgesOver(base: ShadowCoverage, edges: ShadowCoverage, shadow: ShadowCoverage, preview = false): ShadowCoverage {
  const result = new Map(base);
  for (const [batch, marks] of edges) {
    const painted = shadow.get(batch);
    let layer: Map<number, SurfaceFace & { regionId: string }> | undefined;
    for (const hit of marks.values()) {
      if (painted?.get(hit.faceId)?.regionId !== hit.regionId) continue;
      layer ??= new Map(base.get(batch));
      layer.set(hit.faceId, { ...hit, regionId: preview ? EDGE_PREVIEW : edgeColorKey(hit.regionId) });
    }
    if (layer) result.set(batch, layer);
  }
  return result;
}

function replaceRegion(coverage: ShadowCoverage, regionId: string, faces: Iterable<SurfaceFace>) {
  const next = new Map(coverage);
  for (const [batchIndex, batch] of coverage) {

    const other = new Map([...batch].filter(([, hit]) => hit.regionId !== regionId));
    if (other.size === batch.size) continue;
    if (other.size) next.set(batchIndex, other);
    else next.delete(batchIndex);
  }
  const stroke = startShadowStroke(next, regionId, 'brush');
  paintShadowFaces(stroke, faces);
  return stroke.coverage;
}

export function useEdgeHighlight(
  api: PaintPalletApi | undefined, modelId: string | undefined, snapshotId: string,
  regionId: string | undefined, shadow: ShadowCoverage,
) {
  const [histories, setHistories] = useState(new Map<string, History>());
  const ref = useRef(histories);
  const [tool, setTool] = useState<ShadowTool | null>(null);
  const [stroke, setStroke] = useState(false);
  const [brushDraft, setBrushDraft] = useState<ShadowCoverage | null>(null);
  const strokeRef = useRef<{ id: string; edit: ShadowStroke } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sensitivity, setSensitivity] = useState(60);
  const [width, setWidth] = useState(1);
  const query = useMemo(() => previewing && modelId && regionId
    ? { modelId, regionId, snapshotId, shadow, width, sensitivity }
    : null, [previewing, modelId, regionId, snapshotId, shadow, width, sensitivity]);
  const [result, setResult] = useState<{
    query: NonNullable<typeof query>;
    preview?: ShadowCoverage;
    packed?: Uint32Array;
    error?: string;
  } | null>(null);
  const ready = result?.query === query ? result : null;
  const history = histories.get(snapshotId) ?? emptyHistory();
  const regionHasShadow = useMemo(() => {
    if (!regionId) return false;
    for (const batch of shadow.values()) {
      for (const face of batch.values()) if (face.regionId === regionId) return true;
    }
    return false;
  }, [regionId, shadow]);

  useEffect(() => {
    const preview = api?.previewRidgeBand;
    if (!query || !preview) return;
    let active = true;
    let started = false;
    const jobId = crypto.randomUUID();
    const timer = window.setTimeout(async () => {
      started = true;
      let count = 0;
      for (const batch of query.shadow.values()) {
        for (const hit of batch.values()) if (hit.regionId === query.regionId) count++;
      }
      const regionFaces = new Uint32Array(count);
      let offset = 0;
      for (const batch of query.shadow.values()) {
        for (const hit of batch.values()) if (hit.regionId === query.regionId) regionFaces[offset++] = hit.faceId;
      }
      try {
        const packed = await preview({ modelId: query.modelId, jobId, widthPercent: query.width,
          crease: Math.round(75 - 0.73 * query.sensitivity), regionFaces });
        if (!active) return;
        const layer = startShadowStroke(emptyEdges.coverage, query.regionId, 'brush');
        paintShadowFaces(layer, unpackFillFaces(packed));
        setResult({ query, packed, preview: layer.coverage });
      } catch (error) {
        if (active) setResult({ query, error: error instanceof Error ? error.message : 'Edge suggestion failed.' });
      } finally {
        started = false;
      }
    }, 140);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (started) void api?.cancelConnectedFill?.(jobId).catch(() => {});
    };
  }, [api, query]);

  function write(next: Map<string, History>) {
    ref.current = next;
    setHistories(next);
  }

  function writeHistory(id: string, next: History) {
    write(new Map(ref.current).set(id, next));
  }

  function commit(id: string, next: AppliedEdges) {
    const prior = ref.current.get(id) ?? emptyHistory();
    writeHistory(id, { current: next, undo: [...prior.undo, prior.current], redo: [] });
  }

  function cancel() {
    setPreviewing(false);
    setConfirming(false);
    setResult(null);
  }

  function apply(confirm = false) {
    if (!ready?.packed || !regionId) return;
    if (history.current.manualRegions.has(regionId) && !confirm) {
      setConfirming(true);
      return;
    }
    const manualRegions = new Set(history.current.manualRegions);
    manualRegions.delete(regionId);
    commit(snapshotId, { coverage: replaceRegion(history.current.coverage, regionId, unpackFillFaces(ready.packed)), manualRegions });
    cancel();
  }

  function beginBrush() {
    if (!regionId || !tool || strokeRef.current) return false;
    strokeRef.current = { id: snapshotId, edit: startShadowStroke(history.current.coverage, regionId, tool) };
    setStroke(true);
    return true;
  }

  function paintFaces(faces: SurfaceFace[]) {
    const edit = strokeRef.current?.edit;
    if (!edit) return;
    const allowed = faces.filter((face) => shadow.get(face.batchIndex)?.get(face.faceId)?.regionId === edit.regionId);
    if (paintShadowFaces(edit, allowed)) setBrushDraft(edit.coverage);
  }

  function endBrush(keep: boolean) {
    const active = strokeRef.current;
    if (!active) return;
    strokeRef.current = null;
    const { id, edit } = active;
    if (keep && (edit.edit.added.length || edit.edit.removed.length)) {
      const manualRegions = new Set(ref.current.get(id)?.current.manualRegions);
      manualRegions.add(edit.regionId);
      commit(id, { coverage: edit.coverage, manualRegions });
    }
    setBrushDraft(null);
    setStroke(false);
  }

  function undo() {
    const current = ref.current.get(snapshotId);
    const previous = current?.undo.at(-1);
    if (!current || !previous || strokeRef.current) return;
    writeHistory(snapshotId, { current: previous, undo: current.undo.slice(0, -1), redo: [...current.redo, current.current] });
  }

  function redo() {
    const current = ref.current.get(snapshotId);
    const next = current?.redo.at(-1);
    if (!current || !next || strokeRef.current) return;
    writeHistory(snapshotId, { current: next, undo: [...current.undo, current.current], redo: current.redo.slice(0, -1) });
  }

  function reset() {
    strokeRef.current = null;
    cancel();
    setTool(null);
    setBrushDraft(null);
    setStroke(false);
    write(new Map());
  }

  function restore(snapshots: { id: string; edgeManualRegions?: string[] }[], packed: Uint32Array[] | undefined, regions: ShadowRegion[]) {
    reset();
    if (!packed) return;
    write(new Map(snapshots.map((snapshot, index) => [snapshot.id, emptyHistory({
      coverage: unpackShadowCoverage(packed[index], regions), manualRegions: new Set(snapshot.edgeManualRegions),
    })])));
  }

  return {
    available: Boolean(api?.previewRidgeBand), regionHasShadow,
    tool, setTool, stroke, beginBrush, paintFaces, endBrush,
    coverage: brushDraft ?? history.current.coverage, committed: history.current.coverage,
    preview: ready?.preview, previewing, confirming,
    loading: Boolean(query && !ready), suggested: (ready?.packed?.length ?? 0) / 3, failure: ready?.error,
    sensitivity, width,
    setSensitivity(value: number) { setConfirming(false); setSensitivity(value); },
    setWidth(value: number) { setConfirming(false); setWidth(value); },
    start() { setTool(null); setPreviewing(true); },
    cancel, apply, undo, redo,
    canUndo: history.undo.length > 0, canRedo: history.redo.length > 0,
    duplicate(targetId: string) {
      writeHistory(targetId, emptyHistory(ref.current.get(snapshotId)?.current));
    },
    exportProject(ids: string[], regions: ShadowRegion[]) {
      return ids.map((id) => {
        const edge = ref.current.get(id)?.current ?? emptyEdges;
        return { packed: packShadowCoverage(edge.coverage, regions), manual: [...edge.manualRegions] };
      });
    },
    restore, reset,
  };
}
