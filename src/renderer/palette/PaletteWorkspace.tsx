import React, { useEffect, useId, useRef, useState } from 'react';
import {
  mapClientToCanvasPixel,
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
  const urlsToRevokeRef = useRef<string[]>([]);

  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [recipes, setRecipes] = useState<PaintRecipe[]>(() => [
    createEmptyRecipe(1),
  ]);
  const [activeRecipeId, setActiveRecipeId] = useState<string>('recipe-1');
  const [activeTone, setActiveTone] = useState<ToneSlot>('shadow');
  const [toolMode, setToolMode] = useState<'eyedropper' | 'select'>('eyedropper');
  const [selection, setSelection] = useState<PixelRect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [suggestionPreview, setSuggestionPreview] =
    useState<ToneSuggestions | null>(null);

  const activeReference =
    references.find((ref) => ref.id === activeRefId) ?? references[0] ?? null;

  const activeRecipe =
    recipes.find((recipe) => recipe.id === activeRecipeId) ?? recipes[0];

  useEffect(() => {
    return () => {
      for (const url of urlsToRevokeRef.current) {
        URL.revokeObjectURL(url);
      }
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

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) {
      return;
    }
    const files = Array.from(fileList);
    const supported = files.filter(isSupportedImageFile);
    const rejectedCount = files.length - supported.length;

    if (supported.length === 0) {
      setImportError('Select PNG, JPEG, or WebP image files.');
      event.target.value = '';
      return;
    }

    setImportError(
      rejectedCount > 0
        ? 'Skipped unsupported files. Only PNG, JPEG, and WebP images are supported.'
        : null,
    );

    try {
      const loaded = await Promise.all(
        supported.map((file) =>
          loadReferenceFile(file, `ref-${nextRefId.current++}`),
        ),
      );
      for (const item of loaded) {
        urlsToRevokeRef.current.push(item.url);
      }
      setReferences((prev) => [...prev, ...loaded]);
      setActiveRefId((prev) => prev ?? loaded[0].id);
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Failed to import reference image.',
      );
    } finally {
      event.target.value = '';
    }
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

  function handleCanvasPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const { x, y } = mapClientToCanvasPixel(canvas, event.clientX, event.clientY);

    if (toolMode === 'select') {
      setDragStart({ x, y });
      setSelection({ x, y, width: 1, height: 1 });
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const data = ctx.getImageData(x, y, 1, 1).data;
    const hex = rgbToHex(data[0], data[1], data[2]);
    updateActiveSwatch(activeTone, { hex });
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || toolMode !== 'select' || !dragStart) {
      return;
    }
    const { x, y } = mapClientToCanvasPixel(canvas, event.clientX, event.clientY);
    const left = Math.min(dragStart.x, x);
    const top = Math.min(dragStart.y, y);
    const right = Math.max(dragStart.x, x);
    const bottom = Math.max(dragStart.y, y);
    setSelection({
      x: left,
      y: top,
      width: Math.max(1, right - left + 1),
      height: Math.max(1, bottom - top + 1),
    });
  }

  function handleCanvasPointerUp() {
    if (dragStart) {
      setDragStart(null);
    }
  }

  function handleSuggestTones() {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const rect = selection ?? {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
    };
    const imageData = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
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
                    onClick={() => setSelection(null)}
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
                    aria-label={`Reference canvas for ${activeReference.name}`}
                    onPointerDown={handleCanvasPointerDown}
                    onPointerMove={handleCanvasPointerMove}
                    onPointerUp={handleCanvasPointerUp}
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
              Import PNG, JPEG, or WebP images to sample colors or generate tone suggestions.
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
