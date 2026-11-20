import type { PaintRecipe } from '../palette/types';
import type { useConnectedFill } from './useConnectedFill';
import type { useShadowPainting } from './useShadowPainting';

export function ShadowPanel({
  paint,
  fill,
  onApplyFill,
  onCancelFill,
  previewBeforeFill,
  setPreviewBeforeFill,
  repaintFill,
  setRepaintFill,
  onToolChange,
  recipes,
  onRecipeChange,
  busy,
}: {
  paint: ReturnType<typeof useShadowPainting>;
  fill: ReturnType<typeof useConnectedFill>;
  onApplyFill: () => void;
  onCancelFill: () => void;
  previewBeforeFill: boolean;
  setPreviewBeforeFill: (value: boolean) => void;
  repaintFill: boolean;
  setRepaintFill: (value: boolean) => void;
  onToolChange: ReturnType<typeof useShadowPainting>['setTool'];
  recipes: PaintRecipe[];
  onRecipeChange: (id: string) => void;
  busy: boolean;
}) {
  const { recipe, strokePending } = paint;
  const locked = busy || strokePending;

  return (
    <section className="inspector-section" aria-label="Shadow coat" data-tutorial-target="paint">
      <h2>Shadow coat</h2>
      {recipe ? (
        <div className="field-row">
          <label htmlFor="paint-recipe">Recipe</label>
          <select id="paint-recipe" className="select-input" value={recipe.id}
            disabled={locked} onChange={(event) => {
              onCancelFill();
              onRecipeChange(event.target.value);
            }}>
            {recipes.map((item) => <option key={item.id} value={item.id}>{item.name || 'Untitled recipe'}</option>)}
          </select>
        </div>
      ) : <p className="hint-text">Add a recipe in the Palette to start painting.</p>}

      {recipe && (
        <>
          <div className="shadow-tools" role="group" aria-label="Shadow tools">
            <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === null}
              disabled={locked} onClick={() => { onCancelFill(); onToolChange(null); }}>Inspect</button>
            <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === 'brush'}
              disabled={locked} onClick={() => { onCancelFill(); onToolChange('brush'); }}>Brush</button>
            <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === 'erase'}
              disabled={locked} onClick={() => { onCancelFill(); onToolChange('erase'); }}>Erase</button>
            {fill.available && (
              <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === 'fill'}
                disabled={locked} onClick={() => onToolChange('fill')}>Fill</button>
            )}
          </div>
          {paint.tool === 'fill' && (
            <>
              <div className="shadow-size">
                <label htmlFor="fill-crease">Cross creases up to</label>
                <input id="fill-crease" type="range" min={0} max={180} value={fill.creaseDegrees}
                  onChange={(event) => fill.setCreaseDegrees(Number(event.target.value))} />
                <output htmlFor="fill-crease">{fill.creaseDegrees}°</output>
              </div>
              <label className="hint-text">
                <input type="checkbox" checked={repaintFill} disabled={locked}
                  onChange={(event) => setRepaintFill(event.target.checked)} />
                Repaint existing color
              </label>
              <label className="hint-text">
                <input type="checkbox" checked={previewBeforeFill} disabled={locked}
                  onChange={(event) => setPreviewBeforeFill(event.target.checked)} />
                Preview before filling
              </label>
              <p className="hint-text" role="status">
                {fill.loading ? previewBeforeFill ? 'Preparing connected surface preview…' : 'Filling connected surface…'
                  : fill.error ?? (fill.seeded && previewBeforeFill
                    ? `${fill.added.toLocaleString()} ${repaintFill ? '' : 'new '}${fill.added === 1 ? 'face' : 'faces'} to fill`
                    : previewBeforeFill ? 'Click a surface to preview the fill.' : 'Click a surface to fill it. Undo reverses the fill.')}
              </p>
              {fill.seeded && (previewBeforeFill || fill.loading) && (
                <div className="shadow-tools">
                  {previewBeforeFill && <button type="button" className="btn btn--primary btn--small"
                    disabled={locked || !fill.added || fill.loading} onClick={onApplyFill}>Apply fill</button>}
                  <button type="button" className="btn btn--secondary btn--small"
                    onClick={onCancelFill}>Cancel fill</button>
                </div>
              )}
            </>
          )}
          {recipe && paint.tool && paint.tool !== 'fill' && (
            <>
              <div className="shadow-size">
                <label htmlFor="shadow-brush-size">Brush size</label>
                <input
                  id="shadow-brush-size"
                  type="range"
                  min={1}
                  max={240}
                  value={paint.brushSize}
                  onChange={(event) => paint.setBrushSize(Number(event.target.value))}
                  disabled={locked}
                  aria-valuetext={`${paint.brushSize} pixels`}
                />
                <output htmlFor="shadow-brush-size">{paint.brushSize} px</output>
              </div>
              <p className="hint-text">Drag to {paint.tool === 'brush' ? 'paint' : 'erase'}. Alt-drag to orbit.</p>
            </>
          )}
          <div className="shadow-tools">
            <button type="button" className="btn btn--secondary btn--small"
              disabled={locked || !paint.canUndo} onClick={() => { onCancelFill(); paint.undo(); }}>Undo stroke</button>
            <button type="button" className="btn btn--secondary btn--small"
              disabled={locked || !paint.canRedo} onClick={() => { onCancelFill(); paint.redo(); }}>Redo stroke</button>
          </div>
          <output className="hint-text" aria-label="Painted faces">{paint.paintedFaces.toLocaleString()} painted faces</output>
        </>
      )}
    </section>
  );
}
