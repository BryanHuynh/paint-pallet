import { describe, expect, it } from 'vitest';
import {
  commitShadowStroke, emptyShadowHistory, paintShadowFaces, redoShadowStroke, startShadowStroke,
  undoShadowStroke, type ShadowHistory, type ShadowTool, type SurfaceFace,
} from '../../src/renderer/paint/shadowPaint';

describe('shadow coat strokes', () => {
  const first = { faceId: 17, batchIndex: 0, triangleIndex: 2 };
  const second = { faceId: 42, batchIndex: 1, triangleIndex: 8 };

  function stroke(history: ShadowHistory, faces: SurfaceFace[], recipeId: string, tool: ShadowTool) {
    const draft = startShadowStroke(history.coverage, recipeId, tool);
    paintShadowFaces(draft, faces);
    return commitShadowStroke(history, draft);
  }

  it('shows each sample in provisional coverage and commits all samples as one edit', () => {
    const history = emptyShadowHistory();
    const draft = startShadowStroke(history.coverage, 'cloak', 'brush');

    expect(paintShadowFaces(draft, [first])).toBe(true);
    expect(draft.coverage.get(0)?.get(17)?.recipeId).toBe('cloak');
    expect(history.coverage.size).toBe(0);
    expect(history.undo).toHaveLength(0);

    const initialBatch = draft.coverage.get(0);
    expect(paintShadowFaces(draft, [first, second])).toBe(true);
    expect(draft.coverage.get(0)).toBe(initialBatch);
    expect(draft.coverage.get(1)?.get(42)?.recipeId).toBe('cloak');

    const painted = commitShadowStroke(history, draft);
    expect(painted.coverage).toBe(draft.coverage);
    expect(painted.undo).toHaveLength(1);
    const undone = undoShadowStroke(painted);
    expect(undone.coverage.size).toBe(0);
    expect(redoShadowStroke(undone).coverage).toEqual(painted.coverage);
  });

  it('keeps committed paint intact until a live erase is released', () => {
    const history = stroke(emptyShadowHistory(), [first], 'cloak', 'brush');
    const draft = startShadowStroke(history.coverage, 'cloak', 'erase');
    expect(paintShadowFaces(draft, [first])).toBe(true);
    expect(draft.coverage.size).toBe(0);
    expect(history.coverage.get(0)?.get(17)?.recipeId).toBe('cloak');

    const erased = commitShadowStroke(history, draft);
    expect(erased.coverage.size).toBe(0);
    expect(undoShadowStroke(erased).coverage).toEqual(history.coverage);
  });

  it('respects ownership when brushing or erasing and clears redo on a new stroke', () => {
    const history = stroke(emptyShadowHistory(), [first], 'cloak', 'brush');
    expect(stroke(history, [first], 'armor', 'brush')).toBe(history);
    expect(stroke(history, [first], 'armor', 'erase')).toBe(history);

    const erased = stroke(history, [first], 'cloak', 'erase');
    const restored = undoShadowStroke(erased);
    const next = stroke(restored, [first, second], 'armor', 'brush');
    expect(next.coverage.get(0)?.get(17)?.recipeId).toBe('cloak');
    expect(next.coverage.get(1)?.get(42)?.recipeId).toBe('armor');
    expect(next.redo).toHaveLength(0);
  });
});
