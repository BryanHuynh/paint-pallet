import { useEffect, useMemo, useRef, useState } from 'react';
import type { PartAddress } from '../../shared/kit';
import type { PaintPalletApi } from '../../shared/workerProtocol';
import { unpackFillFaces } from './useConnectedFill';
import { packShadowCoverage, unpackShadowCoverage } from './projectMasks';
import { paintShadowFaces, startShadowStroke, type ShadowCoverage, type ShadowStroke, type ShadowTool, type SurfaceFace } from './shadowPaint';

export const EDGE_PREVIEW = 'edge-highlight-preview';
export const edgeColorKey = (recipeId: string) => recipeId + ':edge';

interface AppliedEdges {
  coverage: ShadowCoverage;
  manualRecipes: ReadonlySet<string>;
}
interface History {
  current: AppliedEdges;
  undo: AppliedEdges[];
  redo: AppliedEdges[];
}
const emptyEdges: AppliedEdges = { coverage: new Map(), manualRecipes: new Set() };
const emptyHistory = (current: AppliedEdges = emptyEdges): History => ({ current, undo: [], redo: [] });

export function clipEdgeCoverage(edges: ShadowCoverage, shadow: ShadowCoverage): ShadowCoverage {
  const result = new Map<number, ReadonlyMap<number, SurfaceFace & { recipeId: string }>>();
  for (const [batch, marks] of edges) {
    const painted = shadow.get(batch);
    if (!painted) continue;
    const retained = new Map([...marks].filter(([faceId, mark]) => painted.get(faceId)?.recipeId === mark.recipeId));
    if (retained.size) result.set(batch, retained);
  }
  return result;
}

export function applyEdgesOver(base: ShadowCoverage, edges: ShadowCoverage, shadow: ShadowCoverage, preview = false): ShadowCoverage {
  const result = new Map(base);
  for (const [batch, marks] of edges) {
    const painted = shadow.get(batch);
    let layer: Map<number, SurfaceFace & { recipeId: string }> | undefined;
    for (const hit of marks.values()) {
      if (painted?.get(hit.faceId)?.recipeId !== hit.recipeId) continue;
      layer ??= new Map(base.get(batch));
      layer.set(hit.faceId, { ...hit, recipeId: preview ? EDGE_PREVIEW : edgeColorKey(hit.recipeId) });
    }
    if (layer) result.set(batch, layer);
  }
  return result;
}

type EdgeScope = PartAddress & { faceCount: number; id: string };

function isInScope(faceId: number, part?: EdgeScope) {
  return !part || (faceId >= part.faceOffset && faceId < part.faceOffset + part.faceCount);
}

function replaceRecipe(coverage: ShadowCoverage, recipeId: string, faces: Iterable<SurfaceFace>, part?: EdgeScope) {
  const next = new Map(coverage);
  for (const [batchIndex, batch] of coverage) {

    const other = new Map([...batch].filter(([, hit]) => hit.recipeId !== recipeId || !isInScope(hit.faceId, part)));
    if (other.size === batch.size) continue;
    if (other.size) next.set(batchIndex, other);
    else next.delete(batchIndex);
  }
  const stroke = startShadowStroke(next, recipeId, 'brush');
  paintShadowFaces(stroke, faces);
  return stroke.coverage;
}

export function useEdgeHighlight(
  api: PaintPalletApi | undefined, modelId: string | undefined,
  recipeId: string | undefined, shadow: ShadowCoverage, part?: EdgeScope,
) {
  const [history, setHistory] = useState(emptyHistory);
  const ref = useRef(history);
  const [tool, setTool] = useState<ShadowTool | null>(null);
  const [stroke, setStroke] = useState(false);
  const [brushDraft, setBrushDraft] = useState<ShadowCoverage | null>(null);
  const strokeRef = useRef<{ manualKey: string; edit: ShadowStroke } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sensitivity, setSensitivity] = useState(60);
  const [width, setWidth] = useState(1);
  const manualKey = part?.faceOffset ? part.id + '/' + recipeId : recipeId;
  const query = useMemo(() => previewing && modelId && recipeId
    ? { modelId, recipeId, shadow, width, sensitivity, part }
    : null, [previewing, modelId, recipeId, shadow, width, sensitivity, part]);
  const [result, setResult] = useState<{
    query: NonNullable<typeof query>;
    preview?: ShadowCoverage;
    packed?: Uint32Array;
    error?: string;
  } | null>(null);
  const ready = result?.query === query ? result : null;
  const recipeHasShadow = useMemo(() => {
    if (!recipeId) return false;
    for (const batch of shadow.values()) {
      for (const face of batch.values()) if (face.recipeId === recipeId && isInScope(face.faceId, part)) return true;
    }
    return false;
  }, [recipeId, shadow, part]);

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
        for (const hit of batch.values()) if (hit.recipeId === query.recipeId && isInScope(hit.faceId, query.part)) count++;
      }
      const regionFaces = new Uint32Array(count);
      let offset = 0;
      for (const batch of query.shadow.values()) {
        for (const hit of batch.values()) {
          if (hit.recipeId === query.recipeId && isInScope(hit.faceId, query.part)) {
            regionFaces[offset++] = hit.faceId - (query.part?.faceOffset ?? 0);
          }
        }
      }
      try {
        const packed = await preview({ modelId: query.modelId, jobId, widthPercent: query.width,
          crease: Math.round(75 - 0.73 * query.sensitivity), regionFaces });
        if (!active) return;
        const layer = startShadowStroke(emptyEdges.coverage, query.recipeId, 'brush');
        paintShadowFaces(layer, unpackFillFaces(packed, query.part));
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

  function writeHistory(next: History) {
    ref.current = next;
    setHistory(next);
  }

  function commit(next: AppliedEdges) {
    const prior = ref.current;
    writeHistory({ current: next, undo: [...prior.undo, prior.current], redo: [] });
  }

  function cancel() {
    setPreviewing(false);
    setConfirming(false);
    setResult(null);
  }

  function apply(confirm = false) {
    if (!ready?.packed || !recipeId || !manualKey) return;
    if (history.current.manualRecipes.has(manualKey) && !confirm) {
      setConfirming(true);
      return;
    }
    const manualRecipes = new Set(history.current.manualRecipes);
    manualRecipes.delete(manualKey);
    commit({ coverage: replaceRecipe(history.current.coverage, recipeId, unpackFillFaces(ready.packed, part), part), manualRecipes });
    cancel();
  }

  function beginBrush() {
    if (!recipeId || !manualKey || !tool || strokeRef.current) return false;
    strokeRef.current = { manualKey, edit: startShadowStroke(history.current.coverage, recipeId, tool) };
    setStroke(true);
    return true;
  }

  function paintFaces(faces: SurfaceFace[]) {
    const edit = strokeRef.current?.edit;
    if (!edit) return;
    const allowed = faces.filter((face) => shadow.get(face.batchIndex)?.get(face.faceId)?.recipeId === edit.recipeId);
    if (paintShadowFaces(edit, allowed)) setBrushDraft(edit.coverage);
  }

  function endBrush(keep: boolean) {
    const active = strokeRef.current;
    if (!active) return;
    strokeRef.current = null;
    const { edit } = active;
    if (keep && (edit.edit.added.length || edit.edit.removed.length)) {
      const manualRecipes = new Set(ref.current.current.manualRecipes);
      manualRecipes.add(active.manualKey);
      commit({ coverage: edit.coverage, manualRecipes });
    }
    setBrushDraft(null);
    setStroke(false);
  }

  function undo() {
    const current = ref.current;
    const previous = current?.undo.at(-1);
    if (!current || !previous || strokeRef.current) return;
    writeHistory({ current: previous, undo: current.undo.slice(0, -1), redo: [...current.redo, current.current] });
  }

  function redo() {
    const current = ref.current;
    const next = current?.redo.at(-1);
    if (!current || !next || strokeRef.current) return;
    writeHistory({ current: next, undo: [...current.undo, current.current], redo: current.redo.slice(0, -1) });
  }

  function reset() {
    strokeRef.current = null;
    cancel();
    setTool(null);
    setBrushDraft(null);
    setStroke(false);
    writeHistory(emptyHistory());
  }

  function restore(manualRecipes: string[] | undefined, packed: Uint32Array | undefined, recipes: readonly { id: string }[]) {
    reset();
    if (packed) writeHistory(emptyHistory({
      coverage: unpackShadowCoverage(packed, recipes), manualRecipes: new Set(manualRecipes),
    }));
  }

  return {
    available: Boolean(api?.previewRidgeBand), recipeHasShadow,
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
    exportProject(recipes: readonly { id: string }[], coverage: ShadowCoverage) {
      const edge = ref.current.current;
      const ids = new Set(recipes.map(({ id }) => id));
      const manual = [...edge.manualRecipes].filter((key) => ids.has(key) || ids.has(key.slice(key.indexOf('/') + 1)));
      return { packed: packShadowCoverage(edge.coverage, recipes, coverage), manual };
    },
    restore, reset,
  };
}
