import type { PaintRecipe } from '../palette/types';
import type { useConnectedFill } from './useConnectedFill';
import type { useShadowPainting } from './useShadowPainting';

export function ShadowPanel({
  paint,
  fill,
  onApplyFill,
  onToolChange,
  recipes,
  busy,
}: {
  paint: ReturnType<typeof useShadowPainting>;
  fill: ReturnType<typeof useConnectedFill>;
  onApplyFill: () => void;
  onToolChange: ReturnType<typeof useShadowPainting>['setTool'];
  recipes: PaintRecipe[];
  busy: boolean;
}) {
  const { region, recipe, strokePending } = paint;
  const locked = busy || strokePending;

  return (
    <section className="inspector-section" aria-label="Shadow coat">
      <h2>Shadow coat</h2>
      {region ? (
        <>
          <div className="field-row">
            <label htmlFor="paint-region">Region</label>
            <select id="paint-region" className="select-input" value={region.id}
              disabled={locked} onChange={(event) => {
                fill.cancel();
                paint.setRegionId(event.target.value);
              }}>
              {paint.regions.map((item) => (
                <option key={item.id} value={item.id}>{item.name.trim() || 'Untitled region'}</option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <label htmlFor="paint-region-name">Region name</label>
            <input id="paint-region-name" className="select-input" value={region.name}
              disabled={locked} onChange={(event) => paint.updateRegion({ name: event.target.value })} />
          </div>
          <div className="field-row">
            <label htmlFor="paint-region-recipe">Recipe</label>
            <select id="paint-region-recipe" className="select-input" value={recipe?.id ?? ''}
              disabled={locked} onChange={(event) => paint.updateRegion({ recipeId: event.target.value })}>
              <option value="">Choose a recipe</option>
              {recipes.map((item) => <option key={item.id} value={item.id}>{item.name || 'Untitled recipe'}</option>)}
            </select>
          </div>
        </>
      ) : <p className="hint-text">Add a region and choose its paint recipe.</p>}
      <button type="button" className="btn btn--secondary btn--small" disabled={locked} onClick={() => { fill.cancel(); paint.createRegion(); }}>
        Add region
      </button>

      {region && (
        <>
          <div className="shadow-tools" role="group" aria-label="Shadow tools">
            <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === null}
              disabled={locked} onClick={() => { fill.cancel(); onToolChange(null); }}>Inspect</button>
            <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === 'brush'}
              disabled={locked || !recipe} onClick={() => { fill.cancel(); onToolChange('brush'); }}>Brush</button>
            <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === 'erase'}
              disabled={locked || !recipe} onClick={() => { fill.cancel(); onToolChange('erase'); }}>Erase</button>
            {fill.available && (
              <button type="button" className="btn btn--secondary btn--small" aria-pressed={paint.tool === 'fill'}
                disabled={locked || !recipe} onClick={() => onToolChange('fill')}>Fill</button>
            )}
          </div>
          {recipe && paint.tool === 'fill' && (
            <>
              <div className="shadow-size">
                <label htmlFor="fill-crease">Cross creases up to</label>
                <input id="fill-crease" type="range" min={0} max={180} value={fill.creaseDegrees}
                  onChange={(event) => fill.setCreaseDegrees(Number(event.target.value))} />
                <output htmlFor="fill-crease">{fill.creaseDegrees}°</output>
              </div>
              <p className="hint-text" role="status">
                {fill.loading ? 'Preparing connected surface preview…'
                  : fill.error ?? (fill.seeded
                    ? `${fill.added.toLocaleString()} new faces in preview`
                    : 'Click the surface where the fill should start.')}
              </p>
              {fill.seeded && (
                <div className="shadow-tools">
                  <button type="button" className="btn btn--primary btn--small"
                    disabled={locked || !fill.added || fill.loading} onClick={onApplyFill}>Apply fill</button>
                  <button type="button" className="btn btn--secondary btn--small"
                    onClick={fill.cancel}>Cancel fill</button>
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
              disabled={locked || !paint.canUndo} onClick={paint.undo}>Undo stroke</button>
            <button type="button" className="btn btn--secondary btn--small"
              disabled={locked || !paint.canRedo} onClick={paint.redo}>Redo stroke</button>
          </div>
          <output className="hint-text" aria-label="Painted faces">{paint.paintedFaces.toLocaleString()} painted faces</output>
        </>
      )}
    </section>
  );
}
