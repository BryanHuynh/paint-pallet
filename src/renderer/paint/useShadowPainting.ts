import { useMemo, useRef, useState } from 'react';
import type { PaintRecipe } from '../palette/types';
import {
  commitShadowStroke,
  emptyShadowHistory,
  paintShadowFaces,
  redoShadowStroke,
  startShadowStroke,
  undoShadowStroke,
  type ShadowCoverage,
  type ShadowHistory,
  type ShadowRegion,
  type ShadowStroke,
  type ShadowTool,
  type SurfaceFace,
} from './shadowPaint';

export function useShadowPainting(recipes: PaintRecipe[]) {
  const [regions, setRegions] = useState<ShadowRegion[]>([]);
  const [regionId, setRegionId] = useState('');
  const [tool, setTool] = useState<ShadowTool | null>(null);
  const [brushSize, setBrushSize] = useState(32);
  const [history, setHistory] = useState(emptyShadowHistory);
  const historyRef = useRef(history);
  const [strokePending, setStrokePending] = useState(false);
  const [draft, setDraft] = useState<{ coverage: ShadowCoverage; faceDelta: number } | null>(null);
  const strokeRef = useRef<ShadowStroke | null>(null);
  const region = regions.find((candidate) => candidate.id === regionId);
  const recipe = recipes.find((candidate) => candidate.id === region?.recipeId);

  const colors = useMemo(() => {
    const byRecipe = new Map(recipes.map((entry) => [entry.id, entry.swatches.shadow.hex]));
    return new Map(regions.map((entry) => [entry.id, byRecipe.get(entry.recipeId) ?? '#2b303a']));
  }, [recipes, regions]);

  const committedFaceCount = useMemo(() => {
    let count = 0;
    for (const batch of history.coverage.values()) {
      for (const hit of batch.values()) if (hit.regionId === regionId) count++;
    }
    return count;
  }, [history.coverage, regionId]);

  function createRegion() {
    const number = regions.length + 1;
    const id = `region-${number}`;
    setRegions([...regions, { id, name: `Region ${number}`, recipeId: recipes[0]?.id ?? '' }]);
    setRegionId(id);
  }

  function updateRegion(changes: Partial<Pick<ShadowRegion, 'name' | 'recipeId'>>) {
    setRegions((previous) => previous.map((entry) => entry.id === regionId ? { ...entry, ...changes } : entry));
  }

  function updateHistory(next: ShadowHistory) {
    historyRef.current = next;
    setHistory(next);
  }

  function reset() {
    strokeRef.current = null;
    setRegions([]);
    setRegionId('');
    updateHistory(emptyShadowHistory());
    setTool(null);
    setStrokePending(false);
    setDraft(null);
  }

  function beginStroke(): boolean {
    if (!tool || !region || !recipe || strokeRef.current) return false;
    strokeRef.current = startShadowStroke(historyRef.current.coverage, region.id, tool);
    setStrokePending(true);
    return true;
  }

  function paintFaces(faces: SurfaceFace[]) {
    const stroke = strokeRef.current;
    if (!stroke || !paintShadowFaces(stroke, faces)) return;
    setDraft({
      coverage: stroke.coverage,
      faceDelta: stroke.edit.added.length - stroke.edit.removed.length,
    });
  }

  function endStroke(commit: boolean) {
    const stroke = strokeRef.current;
    if (!stroke) return;
    strokeRef.current = null;
    if (commit) updateHistory(commitShadowStroke(historyRef.current, stroke));
    setDraft(null);
    setStrokePending(false);
  }

  return {
    regions, region, recipe, colors, tool, brushSize, setBrushSize, strokePending,
    paintedFaces: committedFaceCount + (draft?.faceDelta ?? 0),
    coverage: draft?.coverage ?? history.coverage,
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    createRegion, updateRegion, setRegionId, setTool, reset, beginStroke, paintFaces, endStroke,
    undo: () => {
      if (!strokeRef.current) updateHistory(undoShadowStroke(historyRef.current));
    },
    redo: () => {
      if (!strokeRef.current) updateHistory(redoShadowStroke(historyRef.current));
    },
  };
}
