import React, { useEffect, useId, useRef, useState } from 'react';
import {
  mapClientToCanvasPixel,
  readBoundedRegionImageData,
  rgbToHex,
  suggestTonesFromImageData,
} from './colorMath';
import styles from './PaletteWorkspace.module.css';
import { ToneSwatchCard } from './ToneSwatchCard';
import type {
  PaintRecipe,
  PixelRect,
  ReferenceImage,
  SwatchEntry,
  ToneSlot,
  ToneSuggestions,
} from './types';

const TONE_SLOTS: { slot: ToneSlot; label: string }[] = [
  { slot: 'shadow', label: 'Shadow' },
  { slot: 'midtone', label: 'Midtone' },
  { slot: 'highlight', label: 'Highlight' },
];

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const MAGNIFIER_RADIUS = 7;
const MAGNIFIER_GRID = MAGNIFIER_RADIUS * 2 + 1;
const MAGNIFIER_CELL_PX = 8;
const MAGNIFIER_SIZE = MAGNIFIER_GRID * MAGNIFIER_CELL_PX;

const ACCEPTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

function isSupportedImageFile(file: File): boolean {
  if (ACCEPTED_MIME_TYPES.has(file.type)) {
    return true;
  }
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

function loadReferenceFile(file: File, id: string): Promise<ReferenceImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({
        id,
        name: file.name,
        url,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        element: img,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.name}.`));
    };
    img.src = url;
  });
}

function createEmptyRecipe(index: number): PaintRecipe {
  return {
    id: `recipe-${index}`,
    name: `Recipe ${index}`,
    swatches: {
      shadow: { hex: '#2B303A', brand: '', bottleName: '', mixNotes: '' },
      midtone: { hex: '#6B7280', brand: '', bottleName: '', mixNotes: '' },
      highlight: { hex: '#D1D5DB', brand: '', bottleName: '', mixNotes: '' },
    },
  };
}

export default function PaletteWorkspace(): React.ReactElement {
  const importInputId = useId();
  const recipeNameInputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const panStateRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const nextRefId = useRef(1);
  const nextRecipeNumberRef = useRef(2);
  const isMountedRef = useRef(true);
  const urlsToRevokeRef = useRef<string[]>([]);

  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [recipes, setRecipes] = useState<PaintRecipe[]>(() => [
    createEmptyRecipe(1),
  ]);
  const [activeRecipeId, setActiveRecipeId] = useState<string | null>('recipe-1');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [activeTone, setActiveTone] = useState<ToneSlot>('shadow');
  const [toolMode, setToolMode] = useState<'eyedropper' | 'select'>('eyedropper');
  const [zoom, setZoom] = useState<number | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [selection, setSelection] = useState<PixelRect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [magnifier, setMagnifier] = useState<{
    x: number;
    y: number;
    visible: boolean;
    hex: string;
  }>({ x: 0, y: 0, visible: false, hex: '#000000' });
  const [keyboardAnchor, setKeyboardAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [suggestionPreview, setSuggestionPreview] =
    useState<ToneSuggestions | null>(null);

  const activeReference =
    references.find((ref) => ref.id === activeRefId) ?? references[0] ?? null;

  const activeRecipe = activeRecipeId
    ? (recipes.find((recipe) => recipe.id === activeRecipeId) ?? recipes[0] ?? null)
    : (recipes[0] ?? null);

  useEffect(() => {
    if (!dragStart && !isPanning) {
      return;
    }
    const endPointer = () => {
      setDragStart(null);
      panStateRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
    return () => {
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
    };
  }, [dragStart, isPanning]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      for (const url of urlsToRevokeRef.current) {
        URL.revokeObjectURL(url);
      }
      urlsToRevokeRef.current = [];
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeReference) {
      return;
    }
    canvas.width = activeReference.width;
    canvas.height = activeReference.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(activeReference.element, 0, 0);
  }, [activeReference]);

  useEffect(() => {
    if (!magnifier.visible || toolMode !== 'select' || !activeReference) {
      return;
    }
    const sourceCanvas = canvasRef.current;
    const magCanvas = magnifierCanvasRef.current;
    if (!sourceCanvas || !magCanvas) {
      return;
    }
    const magCtx = magCanvas.getContext('2d');
    if (!magCtx) {
      return;
    }
    magCtx.fillStyle = '#0f1f10';
    magCtx.fillRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);

    const srcX = Math.max(0, magnifier.x - MAGNIFIER_RADIUS);
    const srcY = Math.max(0, magnifier.y - MAGNIFIER_RADIUS);
    const srcRight = Math.min(sourceCanvas.width, magnifier.x + MAGNIFIER_RADIUS + 1);
    const srcBottom = Math.min(sourceCanvas.height, magnifier.y + MAGNIFIER_RADIUS + 1);
    const srcW = srcRight - srcX;
    const srcH = srcBottom - srcY;
    if (srcW > 0 && srcH > 0) {
      const dstX = (srcX - (magnifier.x - MAGNIFIER_RADIUS)) * MAGNIFIER_CELL_PX;
      const dstY = (srcY - (magnifier.y - MAGNIFIER_RADIUS)) * MAGNIFIER_CELL_PX;
      magCtx.imageSmoothingEnabled = false;
      magCtx.drawImage(
        sourceCanvas,
        srcX,
        srcY,
        srcW,
        srcH,
        dstX,
        dstY,
        srcW * MAGNIFIER_CELL_PX,
        srcH * MAGNIFIER_CELL_PX,
      );
    }
  }, [magnifier.visible, magnifier.x, magnifier.y, toolMode, activeReference]);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) {
      return;
    }
    const files = Array.from(fileList);
    const supported = files.filter(isSupportedImageFile);
    const unsupportedNames = files
      .filter((file) => !isSupportedImageFile(file))
      .map((file) => file.name);
    event.target.value = '';

    if (supported.length === 0) {
      setImportError(
        `Unsupported file format (${unsupportedNames.join(', ')}). Select PNG, JPEG, or WebP images.`,
      );
      return;
    }

    const results = await Promise.allSettled(
      supported.map((file) =>
        loadReferenceFile(file, `ref-${nextRefId.current++}`),
      ),
    );

    const loaded: ReferenceImage[] = [];
    const failedMessages: string[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        loaded.push(result.value);
      } else {
        failedMessages.push(
          result.reason instanceof Error
            ? result.reason.message
            : 'Could not decode an image.',
        );
      }
    }

    if (!isMountedRef.current) {
      for (const item of loaded) {
        URL.revokeObjectURL(item.url);
      }
      return;
    }

    if (loaded.length > 0) {
      for (const item of loaded) {
        urlsToRevokeRef.current.push(item.url);
      }
      setReferences((prev) => [...prev, ...loaded]);
      setActiveRefId((prev) => prev ?? loaded[0].id);
    }

    const feedbackParts: string[] = [];
    if (unsupportedNames.length > 0) {
      feedbackParts.push(
        `Skipped unsupported files (${unsupportedNames.join(', ')}). Use PNG, JPEG, or WebP.`,
      );
    }
    if (failedMessages.length > 0) {
      feedbackParts.push(failedMessages.join(' '));
    }
    if (feedbackParts.length > 0 && loaded.length > 0) {
      feedbackParts.push(
        `Kept ${loaded.length} valid ${loaded.length === 1 ? 'image' : 'images'}.`,
      );
    }
    setImportError(feedbackParts.length > 0 ? feedbackParts.join(' ') : null);
  }

  function handleCreateRecipe() {
    const nextNumber = nextRecipeNumberRef.current++;
    const next = createEmptyRecipe(nextNumber);
    setRecipes((prev) => [...prev, next]);
    setActiveRecipeId(next.id);
    setConfirmDeleteId(null);
  }

  function handleRequestDeleteRecipe() {
    if (!activeRecipe) {
      return;
    }
    setConfirmDeleteId(activeRecipe.id);
  }

  function handleCancelDeleteRecipe() {
    setConfirmDeleteId(null);
  }

  function handleConfirmDeleteRecipe() {
    if (!confirmDeleteId) {
      return;
    }
    const deletedIndex = recipes.findIndex((recipe) => recipe.id === confirmDeleteId);
    if (deletedIndex === -1) {
      setConfirmDeleteId(null);
      return;
    }
    const nextRecipes = recipes.filter((recipe) => recipe.id !== confirmDeleteId);
    let nextActiveId: string | null = null;
    if (nextRecipes.length > 0) {
      nextActiveId =
        deletedIndex < nextRecipes.length
          ? nextRecipes[deletedIndex].id
          : nextRecipes[deletedIndex - 1].id;
    }
    setRecipes(nextRecipes);
    setActiveRecipeId(nextActiveId);
    setConfirmDeleteId(null);
  }

  function handleRenameRecipe(name: string) {
    if (!activeRecipe) {
      return;
    }
    setRecipes((prev) =>
      prev.map((recipe) =>
        recipe.id === activeRecipe.id ? { ...recipe, name } : recipe,
      ),
    );
  }

  function updateActiveSwatch(slot: ToneSlot, patch: Partial<SwatchEntry>) {
    if (!activeRecipe) {
      return;
    }
    setRecipes((prev) =>
      prev.map((recipe) =>
        recipe.id === activeRecipe.id
          ? {
              ...recipe,
              swatches: {
                ...recipe.swatches,
                [slot]: { ...recipe.swatches[slot], ...patch },
              },
            }
          : recipe,
      ),
    );
  }

  function getFitScale(): number {
    const stage = stageRef.current;
    if (
      !stage ||
      !activeReference ||
      stage.clientWidth === 0 ||
      stage.clientHeight === 0
    ) {
      return 1;
    }
    const availW = Math.max(1, stage.clientWidth - 24);
    const availH = Math.max(1, stage.clientHeight - 24);
    return Math.min(
      1,
      availW / activeReference.width,
      availH / activeReference.height,
    );
  }

  function handleZoomIn() {
    const current = zoom ?? getFitScale();
    const next =
      ZOOM_LEVELS.find((level) => level > current + 0.01) ??
      ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    setZoom(next);
  }

  function handleZoomOut() {
    const current = zoom ?? getFitScale();
    const prevLevels = ZOOM_LEVELS.filter((level) => level < current - 0.01);
    const next = prevLevels.length > 0 ? prevLevels[prevLevels.length - 1] : ZOOM_LEVELS[0];
    setZoom(next);
  }

  function handleResetZoom() {
    setZoom(null);
    if (stageRef.current) {
      stageRef.current.scrollLeft = 0;
      stageRef.current.scrollTop = 0;
    }
  }

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      event.preventDefault();
      panStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: stage.scrollLeft,
        scrollTop: stage.scrollTop,
      };
      setIsPanning(true);
    }
  }

  function handleStagePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    const pan = panStateRef.current;
    if (!stage || !pan) {
      return;
    }
    stage.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    stage.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  }

  function handleStagePointerUp() {
    if (panStateRef.current) {
      panStateRef.current = null;
      setIsPanning(false);
    }
  }

  function clampToImage(x: number, y: number): { x: number; y: number } {
    if (!activeReference) {
      return { x: 0, y: 0 };
    }
    return {
      x: Math.max(0, Math.min(activeReference.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(activeReference.height - 1, Math.round(y))),
    };
  }

  function makeRectFromPoints(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): PixelRect {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x, b.x);
    const bottom = Math.max(a.y, b.y);
    return {
      x: left,
      y: top,
      width: Math.max(1, right - left + 1),
      height: Math.max(1, bottom - top + 1),
    };
  }

  function updateSelection(next: PixelRect | null) {
    setSelection(next);
    setSuggestionPreview(null);
  }

  function readPixelHex(canvas: HTMLCanvasElement, x: number, y: number): string {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return '#000000';
    }
    const clamped = clampToImage(x, y);
    const data = ctx.getImageData(clamped.x, clamped.y, 1, 1).data;
    return rgbToHex(data[0], data[1], data[2]);
  }

  function samplePixelAt(x: number, y: number) {
    const canvas = canvasRef.current;
    if (!canvas || !activeRecipe) {
      return;
    }
    const hex = readPixelHex(canvas, x, y);
    updateActiveSwatch(activeTone, { hex });
  }

  function handleCanvasPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button === 1 || event.altKey) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const { x, y } = mapClientToCanvasPixel(canvas, event.clientX, event.clientY);
    setCursor({ x, y });

    if (toolMode === 'select') {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setKeyboardAnchor(null);
      setDragStart({ x, y });
      setMagnifier({
        x,
        y,
        visible: true,
        hex: readPixelHex(canvas, x, y),
      });
      updateSelection({ x, y, width: 1, height: 1 });
      return;
    }

    samplePixelAt(x, y);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (panStateRef.current) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || toolMode !== 'select') {
      return;
    }
    const { x, y } = mapClientToCanvasPixel(canvas, event.clientX, event.clientY);
    setMagnifier({
      x,
      y,
      visible: true,
      hex: readPixelHex(canvas, x, y),
    });
    if (!dragStart) {
      return;
    }
    setCursor({ x, y });
    updateSelection(makeRectFromPoints(dragStart, { x, y }));
  }

  function handleCanvasPointerUp(event?: React.PointerEvent<HTMLCanvasElement>) {
    if (
      event &&
      event.currentTarget.hasPointerCapture?.(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (dragStart) {
      setDragStart(null);
    }
  }

  function handleCanvasPointerLeave() {
    if (!dragStart) {
      setMagnifier((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    }
  }

  function toggleKeyboardSelection() {
    if (!keyboardAnchor) {
      setKeyboardAnchor(cursor);
      updateSelection({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
      return;
    }
    updateSelection(makeRectFromPoints(keyboardAnchor, cursor));
    setKeyboardAnchor(null);
  }

  function handleCanvasKeyDown(event: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!activeReference) {
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    let nextCursor: { x: number; y: number } | null = null;

    if (event.key === 'ArrowLeft') {
      nextCursor = clampToImage(cursor.x - step, cursor.y);
    } else if (event.key === 'ArrowRight') {
      nextCursor = clampToImage(cursor.x + step, cursor.y);
    } else if (event.key === 'ArrowUp') {
      nextCursor = clampToImage(cursor.x, cursor.y - step);
    } else if (event.key === 'ArrowDown') {
      nextCursor = clampToImage(cursor.x, cursor.y + step);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (toolMode === 'eyedropper') {
        samplePixelAt(cursor.x, cursor.y);
      } else {
        toggleKeyboardSelection();
      }
      return;
    } else if (event.key === 'Escape' && keyboardAnchor) {
      event.preventDefault();
      setKeyboardAnchor(null);
      return;
    }

    if (nextCursor) {
      event.preventDefault();
      setCursor(nextCursor);
      if (toolMode === 'select' && keyboardAnchor) {
        updateSelection(makeRectFromPoints(keyboardAnchor, nextCursor));
      }
    }
  }

  function handleSuggestTones() {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = selection ?? {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
    };
    const imageData = readBoundedRegionImageData(canvas, rect);
    if (!imageData) {
      return;
    }
    const suggested = suggestTonesFromImageData(imageData);
    if (suggested) {
      setSuggestionPreview(suggested);
    }
  }

  function handleApplySuggestions() {
    if (!suggestionPreview || !activeRecipe) {
      return;
    }
    setRecipes((prev) =>
      prev.map((recipe) =>
        recipe.id === activeRecipe.id
          ? {
              ...recipe,
              swatches: {
                shadow: {
                  ...recipe.swatches.shadow,
                  hex: suggestionPreview.shadow,
                },
                midtone: {
                  ...recipe.swatches.midtone,
                  hex: suggestionPreview.midtone,
                },
                highlight: {
                  ...recipe.swatches.highlight,
                  hex: suggestionPreview.highlight,
                },
              },
            }
          : recipe,
      ),
    );
    setSuggestionPreview(null);
  }

  return (
    <section className={styles.workspace} aria-label="Reference palette workspace">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>Reference palette</h1>
          <p className={styles.subtitle}>
            Import reference images, sample pixels, and build three-tone paint recipes.
          </p>
        </div>

        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => fileInputRef.current?.click()}
        >
          Import reference images
        </button>
        <input
          ref={fileInputRef}
          id={importInputId}
          aria-label="Import reference images"
          className={styles.hiddenFileInput}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          multiple
          onChange={handleFileChange}
        />
      </header>

      <div className={styles.layout}>
        <section className={styles.panel} aria-label="Reference stage">
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Reference images</h2>
            {activeReference && (
              <span className={styles.subtitle}>
                {activeReference.width} × {activeReference.height} px
              </span>
            )}
          </div>

          {importError && (
            <p className={styles.errorBanner} role="alert">
              {importError}
            </p>
          )}

          {references.length > 0 && (
            <div className={styles.refStrip} role="group" aria-label="Imported references">
              {references.map((ref) => (
                <button
                  key={ref.id}
                  type="button"
                  className={styles.thumbBtn}
                  aria-pressed={ref.id === activeReference?.id}
                  onClick={() => {
                    setActiveRefId(ref.id);
                    setSelection(null);
                    setKeyboardAnchor(null);
                    setCursor({ x: 0, y: 0 });
                    setSuggestionPreview(null);
                    setZoom(null);
                    setMagnifier((prev) =>
                      prev.visible ? { ...prev, visible: false } : prev,
                    );
                    if (stageRef.current) {
                      stageRef.current.scrollLeft = 0;
                      stageRef.current.scrollTop = 0;
                    }
                  }}
                >
                  <img className={styles.thumbImg} src={ref.url} alt="" />
                  <span>{ref.name}</span>
                </button>
              ))}
            </div>
          )}

          {activeReference ? (
            <>
              <div className={styles.toolbar} role="group" aria-label="Canvas tools">
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  aria-pressed={toolMode === 'eyedropper'}
                  onClick={() => {
                    setToolMode('eyedropper');
                    setMagnifier((prev) =>
                      prev.visible ? { ...prev, visible: false } : prev,
                    );
                  }}
                >
                  Eyedropper
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  aria-pressed={toolMode === 'select'}
                  onClick={() => setToolMode('select')}
                >
                  Select region
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={handleSuggestTones}
                >
                  Suggest tones
                </button>
                {selection && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSecondary}`}
                    onClick={() => updateSelection(null)}
                  >
                    Clear selection
                  </button>
                )}
              </div>
              <div className={styles.zoomBar} role="group" aria-label="Zoom controls">
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  disabled={zoom !== null && zoom <= ZOOM_LEVELS[0]}
                  onClick={handleZoomOut}
                >
                  Zoom out
                </button>
                <span className={styles.zoomReadout} data-testid="zoom-readout">
                  {zoom === null ? 'Fit' : `${Math.round(zoom * 100)}%`}
                </span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  disabled={zoom !== null && zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
                  onClick={handleZoomIn}
                >
                  Zoom in
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  disabled={zoom === null}
                  onClick={handleResetZoom}
                >
                  Fit / Reset
                </button>
              </div>
              <div
                ref={stageRef}
                data-testid="canvas-stage"
                className={`${styles.canvasStage} ${isPanning ? styles.canvasStagePanning : ''}`}
                onPointerDown={handleStagePointerDown}
                onPointerMove={handleStagePointerMove}
                onPointerUp={handleStagePointerUp}
                onPointerCancel={handleStagePointerUp}
              >
                <div
                  className={`${styles.canvasWrap} ${zoom !== null ? styles.canvasWrapZoomed : ''}`}
                >
                  <canvas
                    ref={canvasRef}
                    data-testid="reference-canvas"
                    className={styles.canvas}
                    width={activeReference.width}
                    height={activeReference.height}
                    style={
                      zoom !== null
                        ? {
                            width: `${Math.round(activeReference.width * zoom)}px`,
                            height: `${Math.round(activeReference.height * zoom)}px`,
                            maxWidth: 'none',
                            maxHeight: 'none',
                            imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
                          }
                        : undefined
                    }
                    tabIndex={0}
                    aria-label={`Reference canvas for ${activeReference.name}. Use arrow keys to move cursor and Enter or Space to ${toolMode === 'eyedropper' ? 'sample pixel' : 'set selection corner'}.`}
                    onKeyDown={handleCanvasKeyDown}
                    onPointerDown={handleCanvasPointerDown}
                    onPointerMove={handleCanvasPointerMove}
                    onPointerUp={handleCanvasPointerUp}
                    onPointerCancel={handleCanvasPointerUp}
                    onPointerLeave={handleCanvasPointerLeave}
                  />
                  <div
                    className={styles.cursorMarker}
                    aria-hidden="true"
                    style={{
                      left: `${((cursor.x + 0.5) / activeReference.width) * 100}%`,
                      top: `${((cursor.y + 0.5) / activeReference.height) * 100}%`,
                    }}
                  />
                  {selection && (
                    <div
                      className={styles.selectionOverlay}
                      aria-hidden="true"
                      style={{
                        left: `${(selection.x / activeReference.width) * 100}%`,
                        top: `${(selection.y / activeReference.height) * 100}%`,
                        width: `${(selection.width / activeReference.width) * 100}%`,
                        height: `${(selection.height / activeReference.height) * 100}%`,
                      }}
                    />
                  )}
                  {toolMode === 'select' && magnifier.visible && (
                    <div
                      data-testid="region-magnifier"
                      className={styles.magnifier}
                      aria-hidden="true"
                      style={{
                        left:
                          magnifier.x / activeReference.width > 0.68
                            ? `calc(${((magnifier.x + 0.5) / activeReference.width) * 100}% - 150px)`
                            : `calc(${((magnifier.x + 0.5) / activeReference.width) * 100}% + 16px)`,
                        top:
                          magnifier.y / activeReference.height > 0.68
                            ? `calc(${((magnifier.y + 0.5) / activeReference.height) * 100}% - 160px)`
                            : `calc(${((magnifier.y + 0.5) / activeReference.height) * 100}% + 16px)`,
                      }}
                    >
                      <div className={styles.magnifierViewport}>
                        <canvas
                          ref={magnifierCanvasRef}
                          data-testid="region-magnifier-canvas"
                          className={styles.magnifierCanvas}
                          width={MAGNIFIER_SIZE}
                          height={MAGNIFIER_SIZE}
                        />
                        <div
                          data-testid="magnifier-crosshair"
                          className={styles.magnifierCrosshair}
                        />
                        <div className={styles.magnifierCenterBox} />
                      </div>
                      <div className={styles.magnifierMeta}>
                        <span>
                          {magnifier.x}, {magnifier.y}
                        </span>
                        <span
                          className={styles.magnifierSwatch}
                          style={{ backgroundColor: magnifier.hex }}
                        />
                        <span>{magnifier.hex}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.coordBar}>
                <div className={styles.coordField}>
                  <label className={styles.label} htmlFor={`${importInputId}-cursor-x`}>
                    Cursor X
                  </label>
                  <input
                    id={`${importInputId}-cursor-x`}
                    className={styles.input}
                    type="number"
                    min={0}
                    max={activeReference.width - 1}
                    value={cursor.x}
                    onChange={(event) => {
                      const next = clampToImage(
                        Number(event.target.value) || 0,
                        cursor.y,
                      );
                      setCursor(next);
                      if (toolMode === 'select' && keyboardAnchor) {
                        updateSelection(makeRectFromPoints(keyboardAnchor, next));
                      }
                    }}
                  />
                </div>
                <div className={styles.coordField}>
                  <label className={styles.label} htmlFor={`${importInputId}-cursor-y`}>
                    Cursor Y
                  </label>
                  <input
                    id={`${importInputId}-cursor-y`}
                    className={styles.input}
                    type="number"
                    min={0}
                    max={activeReference.height - 1}
                    value={cursor.y}
                    onChange={(event) => {
                      const next = clampToImage(
                        cursor.x,
                        Number(event.target.value) || 0,
                      );
                      setCursor(next);
                      if (toolMode === 'select' && keyboardAnchor) {
                        updateSelection(makeRectFromPoints(keyboardAnchor, next));
                      }
                    }}
                  />
                </div>
                {toolMode === 'eyedropper' ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSecondary}`}
                    onClick={() => samplePixelAt(cursor.x, cursor.y)}
                  >
                    Sample pixel
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSecondary}`}
                    onClick={toggleKeyboardSelection}
                  >
                    {keyboardAnchor ? 'Finish selection' : 'Start selection'}
                  </button>
                )}
              </div>
              {suggestionPreview && (
                <section
                  className={styles.previewBox}
                  aria-label="Tone suggestion preview"
                >
                  <div className={styles.panelHeader}>
                    <h3 className={styles.panelTitle}>Suggested tones</h3>
                    <span className={styles.subtitle}>
                      {selection ? 'From selected region' : 'From whole image'}
                    </span>
                  </div>
                  <div className={styles.previewSwatches}>
                    {TONE_SLOTS.map(({ slot, label }) => (
                      <div key={slot} className={styles.previewItem}>
                        <span
                          className={styles.swatchChip}
                          style={{ backgroundColor: suggestionPreview[slot] }}
                          aria-hidden="true"
                        />
                        <div>
                          <div>{label}</div>
                          <div>{suggestionPreview[slot]}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className={styles.previewActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={!activeRecipe}
                      onClick={handleApplySuggestions}
                    >
                      Apply suggestions
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSecondary}`}
                      onClick={() => setSuggestionPreview(null)}
                    >
                      Discard
                    </button>
                  </div>
                </section>
              )}
            </>
          ) : (
            <div className={styles.emptyState}>
              Import PNG, JPEG, or WebP images to sample colors or generate tone suggestions.
            </div>
          )}
        </section>

        <section className={styles.panel} aria-label="Recipe editor">
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Recipes</h2>
            <div className={styles.recipeActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSecondary}`}
                onClick={handleCreateRecipe}
              >
                Add recipe
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                disabled={!activeRecipe}
                onClick={handleRequestDeleteRecipe}
              >
                Delete recipe
              </button>
            </div>
          </div>

          {confirmDeleteId && activeRecipe && confirmDeleteId === activeRecipe.id && (
            <div className={styles.confirmBox} role="alertdialog" aria-label="Confirm delete recipe">
              <span>
                Delete &ldquo;{activeRecipe.name || 'Untitled recipe'}&rdquo;?
              </span>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnDanger}`}
                  onClick={handleConfirmDeleteRecipe}
                >
                  Confirm delete
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={handleCancelDeleteRecipe}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {recipes.length > 0 && (
            <div className={styles.recipeList} role="group" aria-label="Saved recipes">
              {recipes.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  className={styles.recipeTab}
                  aria-pressed={recipe.id === activeRecipe?.id}
                  onClick={() => {
                    setActiveRecipeId(recipe.id);
                    setConfirmDeleteId(null);
                  }}
                >
                  {recipe.name || 'Untitled recipe'}
                </button>
              ))}
            </div>
          )}

          {activeRecipe ? (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={recipeNameInputId}>
                  Recipe name
                </label>
                <input
                  id={recipeNameInputId}
                  className={styles.input}
                  type="text"
                  value={activeRecipe.name}
                  onChange={(event) => handleRenameRecipe(event.target.value)}
                />
              </div>

              <div className={styles.toneGrid}>
                {TONE_SLOTS.map(({ slot, label }) => (
                  <ToneSwatchCard
                    key={`${activeRecipe.id}-${slot}`}
                    slot={slot}
                    label={label}
                    swatch={activeRecipe.swatches[slot]}
                    isSelected={activeTone === slot}
                    onSelectTone={setActiveTone}
                    onChangeSwatch={updateActiveSwatch}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className={styles.emptyState}>
              No recipes yet. Add a recipe to start saving shadow, midtone, and highlight swatches.
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
