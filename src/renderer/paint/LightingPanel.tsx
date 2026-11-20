import type { MaskBrushTool } from './lightingState';
import type { useSurfaceLighting } from './useSurfaceLighting';
import { LightingLevels } from './LightingLevels';

function Slider({
  id, label, value, min, max, unit, disabled, onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="shadow-size">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} value={value} disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))} />
      <output htmlFor={id}>{value}{unit}</output>
    </div>
  );
}

export function LightingPanel({
  lighting, busy, brushSize, onBrushSize, onChooseBrush, onSourceChange, onPreview, aiming, onAim, onAimFromCamera,
}: {
  lighting: ReturnType<typeof useSurfaceLighting>;
  busy: boolean;
  brushSize: number;
  onBrushSize: (size: number) => void;
  onChooseBrush: (tool: MaskBrushTool | null) => void;
  onSourceChange?: () => void;
  onPreview?: () => void;
  aiming?: boolean;
  onAim?: () => void;
  onAimFromCamera?: () => void;
}) {
  function startPreview() {
    if (lighting.hasShadow && !lighting.previewing) (onPreview ?? lighting.start)();
  }
  function changeLevel(setter: (value: number) => void, value: number) {
    startPreview();
    setter(value);
  }
  return (
    <section className="inspector-section" aria-label="Lighting" data-tutorial-target="light">
      <h2>Lighting</h2>
      <div className="field-row">
        <label htmlFor="lighting-source">Light source</label>
        <select id="lighting-source" className="select-input" value={lighting.source?.id ?? ''}
          disabled={busy || !lighting.sources.length} onChange={(event) => {
            onSourceChange?.();
            lighting.selectSource(event.target.value);
          }}>
          {!lighting.sources.length && <option value="">No lights</option>}
          {lighting.sources.map((source) => (
            <option key={source.id} value={source.id}>{source.name.trim() || 'Untitled light'} · {source.intensity}%</option>
          ))}
        </select>
      </div>
      <div className="shadow-tools">
        <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={() => {
          onSourceChange?.();
          startPreview();
          lighting.addSource();
        }}>Add light</button>
        <button type="button" className="btn btn--secondary btn--small" disabled={busy || !lighting.source} onClick={() => {
          onSourceChange?.();
          startPreview();
          lighting.removeSource();
        }}>Remove light</button>
      </div>
      {lighting.source && (
        <>
          <div className="field-row">
            <label htmlFor="lighting-source-name">Light name</label>
            <input id="lighting-source-name" className="select-input" value={lighting.source.name}
              disabled={busy} onChange={(event) => lighting.renameSource(event.target.value)} />
          </div>
          <Slider id="light-intensity" label="Intensity" min={0} max={100} value={lighting.intensity}
            unit="%" disabled={busy} onChange={(value) => changeLevel(lighting.setIntensity, value)} />
          <details className="light-angles">
            <summary>Light angles</summary>
            <Slider id="light-azimuth" label="Azimuth" min={0} max={359} value={lighting.azimuth}
              unit="°" disabled={busy} onChange={(value) => changeLevel(lighting.setAzimuth, value)} />
            <Slider id="light-elevation" label="Elevation" min={-90} max={90} value={lighting.elevation}
              unit="°" disabled={busy} onChange={(value) => changeLevel(lighting.setElevation, value)} />
          </details>
        </>
      )}
      {lighting.hasShadow ? (
        <>
          <div className="shadow-tools">
            <button type="button" className="btn btn--secondary btn--small" disabled={busy || !lighting.source} aria-pressed={aiming} onClick={onAim}>
              {aiming ? 'Finish aiming' : 'Aim light in 3D'}
            </button>
            <button type="button" className="btn btn--secondary btn--small" disabled={busy || !lighting.source} onClick={onAimFromCamera}>
              Aim from current view
            </button>
          </div>
          {aiming && <p className="hint-text">Drag the gold ball to aim the light. Drag elsewhere to orbit. Use arrow keys when the ball has focus.</p>}
          {lighting.hasKit && (
            <label className="hint-text">
              <input type="checkbox" checked={lighting.castShadowsBetweenParts} disabled={busy}
                onChange={(event) => {
                  if (!lighting.previewing) (onPreview ?? lighting.start)();
                  lighting.setCastShadowsBetweenParts(event.target.checked);
                }} />
              Shadows from other parts
            </label>
          )}
          <LightingLevels histogram={lighting.histogram} midtone={lighting.midtone} highlight={lighting.highlight}
            disabled={busy} onMidtone={(value) => changeLevel(lighting.setMidtone, value)}
            onHighlight={(value) => changeLevel(lighting.setHighlight, value)} />
          {lighting.error && <p className="hint-text" role="alert">{lighting.error}</p>}
          {lighting.applied && lighting.unapplied && !lighting.previewing && !lighting.refreshing && (
            <p className="hint-text" role="status">Lighting has changed. Review the current masks or regenerate them.</p>
          )}
          {lighting.loading && <p className="hint-text" role="status">Tracing light on original faces…</p>}
          {lighting.refreshing && <p className="hint-text" role="status">Updating the applied light on painted faces…</p>}
          {lighting.draft && (
            <p className="hint-text" role="status">
              {lighting.draft.midtoneFaces.toLocaleString()} midtone faces, including{' '}
              {lighting.draft.highlightFaces.toLocaleString()} highlights.
            </p>
          )}
          {lighting.manual && lighting.previewing && (
            <p className="hint-text">Manual mask edits stay visible until you replace them.</p>
          )}
          <div className="shadow-tools">
            {lighting.previewing && !lighting.error ? (
              <>
                {lighting.confirming ? (
                  <button type="button" className="btn btn--primary btn--small" onClick={() => lighting.apply(true)}
                    disabled={busy || !lighting.draft}>Replace edited masks</button>
                ) : (
                  <button type="button" className="btn btn--primary btn--small" onClick={() => lighting.apply()}
                    disabled={busy || !lighting.draft}>Apply lighting</button>
                )}
                <button type="button" className="btn btn--secondary btn--small"
                  onClick={lighting.cancel}>Cancel lighting</button>
              </>
            ) : (
              <button type="button" className="btn btn--secondary btn--small"
                disabled={busy} onClick={onPreview ?? lighting.start}>Preview lighting</button>
            )}
          </div>
          {lighting.applied && (
            <div className="field-row">
              <label htmlFor="light-mask-brush">Mask brush</label>
              <select id="light-mask-brush" className="select-input" value={lighting.brushTool ?? ''}
                disabled={busy || lighting.previewing || lighting.refreshing}
                onChange={(event) => onChooseBrush((event.target.value || null) as MaskBrushTool | null)}>
                <option value="">Off</option>
                <option value="paint-midtone">Paint midtones</option>
                <option value="erase-midtone">Erase midtones</option>
                <option value="paint-highlight">Paint highlights</option>
                <option value="erase-highlight">Erase highlights</option>
              </select>
            </div>
          )}
          {lighting.brushTool && (
            <Slider id="mask-brush-size" label="Brush size" min={1} max={240} value={brushSize}
              unit=" px" onChange={onBrushSize} />
          )}
          {(lighting.canUndoMask || lighting.canRedoMask) && (
            <div className="shadow-tools">
              <button type="button" className="btn btn--secondary btn--small"
                disabled={busy || lighting.previewing || !lighting.canUndoMask} onClick={lighting.undoMask}>Undo mask edit</button>
              <button type="button" className="btn btn--secondary btn--small"
                disabled={busy || lighting.previewing || !lighting.canRedoMask} onClick={lighting.redoMask}>Redo mask edit</button>
            </div>
          )}
        </>
      ) : <p className="hint-text">Paint a shadow coat to generate midtones and highlights.</p>}
    </section>
  );
}
