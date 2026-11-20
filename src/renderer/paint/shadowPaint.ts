export interface SurfaceFace {
  faceId: number;
  batchIndex: number;
  triangleIndex: number;
}

export type ShadowTool = 'brush' | 'erase';
export type ShadowHit = SurfaceFace & { recipeId: string };
export type ShadowCoverage = ReadonlyMap<number, ReadonlyMap<number, ShadowHit>>;

interface StrokeEdit {
  added: ShadowHit[];
  removed: ShadowHit[];
  recipeIds: Set<string>;
}

export interface ShadowHistory {
  coverage: ShadowCoverage;
  undo: StrokeEdit[];
  redo: StrokeEdit[];
}

export function emptyShadowHistory(): ShadowHistory {
  return { coverage: new Map(), undo: [], redo: [] };
}

function applyStroke(coverage: ShadowCoverage, added: ShadowHit[], removed: ShadowHit[]): ShadowCoverage {
  const next = new Map(coverage);
  const changed = new Map<number, Map<number, ShadowHit>>();

  function getBatch(batchIndex: number) {
    let batch = changed.get(batchIndex);
    if (!batch) {
      batch = new Map(coverage.get(batchIndex));
      changed.set(batchIndex, batch);
    }
    return batch;
  }

  for (const hit of removed) getBatch(hit.batchIndex).delete(hit.faceId);
  for (const hit of added) getBatch(hit.batchIndex).set(hit.faceId, hit);
  for (const [batchIndex, batch] of changed) {
    if (batch.size) next.set(batchIndex, batch);
    else next.delete(batchIndex);
  }
  return next;
}

export interface ShadowStroke {
  readonly recipeId: string;
  readonly tool: ShadowTool | 'repaint';
  readonly edit: StrokeEdit;
  coverage: ShadowCoverage;
}

export function startShadowStroke(coverage: ShadowCoverage, recipeId: string, tool: ShadowStroke['tool']): ShadowStroke {
  return { coverage, recipeId, tool, edit: { added: [], removed: [], recipeIds: new Set() } };
}

export function paintShadowFaces(stroke: ShadowStroke, faces: Iterable<SurfaceFace>): boolean {
  const change: Pick<StrokeEdit, 'added' | 'removed'> = { added: [], removed: [] };
  for (const face of faces) {
    const previous = stroke.coverage.get(face.batchIndex)?.get(face.faceId);
    if (stroke.tool === 'brush' && !previous) change.added.push({ ...face, recipeId: stroke.recipeId });
    if (stroke.tool === 'repaint' && previous?.recipeId !== stroke.recipeId) {
      if (previous) change.removed.push(previous);
      change.added.push({ ...face, recipeId: stroke.recipeId });
    }
    if (stroke.tool === 'erase' && previous?.recipeId === stroke.recipeId) change.removed.push(previous);
  }
  if (!change.added.length && !change.removed.length) return false;

  stroke.coverage = applyStroke(stroke.coverage, change.added, change.removed);
  for (const hit of change.added) {
    stroke.edit.added.push(hit);
    stroke.edit.recipeIds.add(hit.recipeId);
  }
  for (const hit of change.removed) {
    stroke.edit.removed.push(hit);
    stroke.edit.recipeIds.add(hit.recipeId);
  }
  return true;
}

export function commitShadowStroke(history: ShadowHistory, stroke: ShadowStroke): ShadowHistory {
  if (!stroke.edit.added.length && !stroke.edit.removed.length) return history;
  return {
    coverage: stroke.coverage,
    undo: [...history.undo, stroke.edit],
    redo: [],
  };
}

export function undoShadowStroke(history: ShadowHistory): ShadowHistory {
  const stroke = history.undo.at(-1);
  if (!stroke) return history;
  return {
    coverage: applyStroke(history.coverage, stroke.removed, stroke.added),
    undo: history.undo.slice(0, -1),
    redo: [...history.redo, stroke],
  };
}

export function redoShadowStroke(history: ShadowHistory): ShadowHistory {
  const stroke = history.redo.at(-1);
  if (!stroke) return history;
  return {
    coverage: applyStroke(history.coverage, stroke.added, stroke.removed),
    undo: [...history.undo, stroke],
    redo: history.redo.slice(0, -1),
  };
}
