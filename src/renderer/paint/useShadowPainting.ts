import { useMemo, useRef, useState } from 'react';
import type { ProjectState } from '../../shared/paintProject';
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
  type ShadowStroke,
  type ShadowTool,
  type SurfaceFace,
} from './shadowPaint';
import { packShadowCoverage, unpackShadowCoverage } from './projectMasks';

export function useShadowPainting(recipes: PaintRecipe[], activeRecipeId: string | null) {
  const [tool, setTool] = useState<ShadowTool | 'fill' | null>(null);
  const [brushSize, setBrushSize] = useState(32);
  const [history, setHistory] = useState(emptyShadowHistory);
  const historyRef = useRef(history);
  const [strokePending, setStrokePending] = useState(false);
  const [draft, setDraft] = useState<{ coverage: ShadowCoverage; faceDelta: number } | null>(null);
  const strokeRef = useRef<ShadowStroke | null>(null);
  const recipe = recipes.find((candidate) => candidate.id === activeRecipeId) ?? recipes[0];
  const recipeId = recipe?.id;
  const colors = useMemo(() => new Map(recipes.map((entry) => [entry.id, entry.swatches.shadow.hex])), [recipes]);
  const faceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const batch of history.coverage.values()) {
      for (const hit of batch.values()) counts.set(hit.recipeId, (counts.get(hit.recipeId) ?? 0) + 1);
    }
    return counts;
  }, [history.coverage]);
  const usedRecipeIds = useMemo(() => {
    const ids = new Set(faceCounts.keys());
    for (const edits of [history.undo, history.redo]) {
      for (const edit of edits) {
        for (const id of edit.recipeIds) ids.add(id);
      }
    }
    return ids;
  }, [faceCounts, history.undo, history.redo]);

  function updateHistory(next: ShadowHistory) {
    historyRef.current = next;
    setHistory(next);
  }

  function reset() {
    strokeRef.current = null;
    updateHistory(emptyShadowHistory());
    setTool(null);
    setStrokePending(false);
    setDraft(null);
  }

  function beginStroke(): boolean {
    if (!tool || tool === 'fill' || !recipeId || strokeRef.current) return false;
    strokeRef.current = startShadowStroke(historyRef.current.coverage, recipeId, tool);
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

  function commitFill(faces: Iterable<SurfaceFace>, repaint: boolean) {
    if (!recipeId || strokeRef.current) return;
    const history = historyRef.current;
    const fill = startShadowStroke(history.coverage, recipeId, repaint ? 'repaint' : 'brush');
    if (paintShadowFaces(fill, faces)) updateHistory(commitShadowStroke(history, fill));
  }

  function restoreProject(state: ProjectState, paint: Uint32Array) {
    reset();
    updateHistory({ ...emptyShadowHistory(), coverage: unpackShadowCoverage(paint, state.recipes) });
  }

  return {
    recipe, colors, faceCounts, usedRecipeIds, tool, brushSize, setBrushSize, strokePending,
    paintedFaces: (recipeId ? faceCounts.get(recipeId) ?? 0 : 0) + (draft?.faceDelta ?? 0),
    exportProject: () => packShadowCoverage(historyRef.current.coverage, recipes),
    restoreProject,
    coverage: draft?.coverage ?? history.coverage,
    committedCoverage: history.coverage,
    commitFill,
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    setTool, reset, beginStroke, paintFaces, endStroke,
    undo: () => {
      if (!strokeRef.current) updateHistory(undoShadowStroke(historyRef.current));
    },
    redo: () => {
      if (!strokeRef.current) updateHistory(redoShadowStroke(historyRef.current));
    },
  };
}
