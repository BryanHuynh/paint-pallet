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
  const nextRefId = useRef(1);
  const isMountedRef = useRef(true);
  const urlsToRevokeRef = useRef<string[]>([]);

  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isDraggingImages, setIsDraggingImages] = useState(false);

  const [recipes, setRecipes] = useState<PaintRecipe[]>(() => [
    createEmptyRecipe(1),
  ]);
  const [activeRecipeId, setActiveRecipeId] = useState<string>('recipe-1');
  const [activeTone, setActiveTone] = useState<ToneSlot>('shadow');
  const [toolMode, setToolMode] = useState<'eyedropper' | 'select'>('eyedropper');
  const [selection, setSelection] = useState<PixelRect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [keyboardAnchor, setKeyboardAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [suggestionPreview, setSuggestionPreview] =
    useState<ToneSuggestions | null>(null);

  const activeReference =
    references.find((ref) => ref.id === activeRefId) ?? references[0] ?? null;

  const activeRecipe =
    recipes.find((recipe) => recipe.id === activeRecipeId) ?? recipes[0];

  useEffect(() => {
    if (!dragStart) {
      return;
    }
    const endDrag = () => {
      setDragStart(null);
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [dragStart]);

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

  async function importReferenceFiles(files: File[]) {
    if (files.length === 0) return;
    const supported = files.filter(isSupportedImageFile);
    const unsupportedNames = files
      .filter((file) => !isSupportedImageFile(file))
      .map((file) => file.name);

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

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void importReferenceFiles(files);
  }

  function handleImageDragOver(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDraggingImages(true);
  }

  function handleImageDragLeave(event: React.DragEvent<HTMLElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDraggingImages(false);
  }

  function handleImageDrop(event: React.DragEvent<HTMLElement>) {
    const { files, types } = event.dataTransfer;
    if (!files.length && !types.includes('Files')) return;
    event.preventDefault();
    setIsDraggingImages(false);
    void importReferenceFiles(Array.from(files));
  }

  function handleCreateRecipe() {
    const nextIndex = recipes.length + 1;
    const next = createEmptyRecipe(nextIndex);
    setRecipes((prev) => [...prev, next]);
    setActiveRecipeId(next.id);
  }

  function handleRenameRecipe(name: string) {
    setRecipes((prev) =>
      prev.map((recipe) =>
        recipe.id === activeRecipe.id ? { ...recipe, name } : recipe,
      ),
    );
  }

  function updateActiveSwatch(slot: ToneSlot, patch: Partial<SwatchEntry>) {
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

  function samplePixelAt(x: number, y: number) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const clamped = clampToImage(x, y);
    const data = ctx.getImageData(clamped.x, clamped.y, 1, 1).data;
    const hex = rgbToHex(data[0], data[1], data[2]);
    updateActiveSwatch(activeTone, { hex });
  }

  function handleCanvasPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
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
      updateSelection({ x, y, width: 1, height: 1 });
      return;
    }

    samplePixelAt(x, y);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || toolMode !== 'select' || !dragStart) {
      return;
    }
    const { x, y } = mapClientToCanvasPixel(canvas, event.clientX, event.clientY);
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
    if (!suggestionPreview) {
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
        <section
          className={isDraggingImages ? `${styles.panel} ${styles.dropActive}` : styles.panel}
          aria-label="Reference stage"
          onDragOver={handleImageDragOver}
          onDragLeave={handleImageDragLeave}
          onDrop={handleImageDrop}
        >
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
                  onClick={() => setToolMode('eyedropper')}
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
              <div className={styles.canvasStage}>
                <div className={styles.canvasWrap}>
                  <canvas
                    ref={canvasRef}
                    data-testid="reference-canvas"
                    className={styles.canvas}
                    width={activeReference.width}
                    height={activeReference.height}
                    tabIndex={0}
                    aria-label={`Reference canvas for ${activeReference.name}. Use arrow keys to move cursor and Enter or Space to ${toolMode === 'eyedropper' ? 'sample pixel' : 'set selection corner'}.`}
                    onKeyDown={handleCanvasKeyDown}
                    onPointerDown={handleCanvasPointerDown}
                    onPointerMove={handleCanvasPointerMove}
                    onPointerUp={handleCanvasPointerUp}
                    onPointerCancel={handleCanvasPointerUp}
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
              Drop PNG, JPEG, or WebP images here, or use Import reference images.
            </div>
          )}
        </section>

        <section className={styles.panel} aria-label="Recipe editor">
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Recipes</h2>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={handleCreateRecipe}
            >
              Add recipe
            </button>
          </div>

          <div className={styles.recipeList} role="group" aria-label="Saved recipes">
            {recipes.map((recipe) => (
              <button
                key={recipe.id}
                type="button"
                className={styles.recipeTab}
                aria-pressed={recipe.id === activeRecipe.id}
                onClick={() => setActiveRecipeId(recipe.id)}
              >
                {recipe.name || 'Untitled recipe'}
              </button>
            ))}
          </div>

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
        </section>
      </div>
    </section>
  );
}
