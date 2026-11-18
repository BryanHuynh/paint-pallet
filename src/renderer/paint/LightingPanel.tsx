import type { MaskBrushTool } from './lightingState';
import type { useSurfaceLighting } from './useSurfaceLighting';

function Slider({
  id, label, value, min, max, unit, onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="shadow-size">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} value={value}
        onChange={(event) => onChange(Number(event.target.value))} />
      <output htmlFor={id}>{value}{unit}</output>
    </div>
  );
}

export function LightingPanel({
  lighting, busy, brushSize, onBrushSize, onChooseBrush, onSelectSnapshot, onAddSnapshot, onPreview,
}: {
  lighting: ReturnType<typeof useSurfaceLighting>;
  busy: boolean;
  brushSize: number;
  onBrushSize: (size: number) => void;
  onChooseBrush: (tool: MaskBrushTool | null) => void;
  onSelectSnapshot?: (id: string) => void;
  onAddSnapshot?: (duplicate: boolean) => void;
  onPreview?: () => void;
}) {
  return (
    <section className="inspector-section" aria-label="Lighting">
      <h2>Lighting</h2>
      <div className="field-row">
        <label htmlFor="lighting-snapshot">Snapshot</label>
        <select id="lighting-snapshot" className="select-input" value={lighting.snapshot.id}
          disabled={busy} onChange={(event) => (onSelectSnapshot ?? lighting.selectSnapshot)(event.target.value)}>
          {lighting.snapshots.map((snapshot) => (
            <option key={snapshot.id} value={snapshot.id}>{snapshot.name.trim() || 'Untitled snapshot'}</option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <label htmlFor="lighting-snapshot-name">Snapshot name</label>
        <input id="lighting-snapshot-name" className="select-input" value={lighting.snapshot.name}
          disabled={busy} onChange={(event) => lighting.renameSnapshot(event.target.value)} />
      </div>
      <div className="shadow-tools">
        <button type="button" className="btn btn--secondary btn--small"
          disabled={busy} onClick={() => (onAddSnapshot ?? lighting.addSnapshot)(false)}>New snapshot</button>
        <button type="button" className="btn btn--secondary btn--small"
          disabled={busy} onClick={() => (onAddSnapshot ?? lighting.addSnapshot)(true)}>Duplicate snapshot</button>
      </div>
      {lighting.hasShadow ? (
        <>
          <Slider id="light-azimuth" label="Azimuth" min={0} max={359} value={lighting.azimuth}
            unit="°" onChange={lighting.setAzimuth} />
          <Slider id="light-elevation" label="Elevation" min={-90} max={90} value={lighting.elevation}
            unit="°" onChange={lighting.setElevation} />
          <Slider id="light-midtone" label="Midtone cutoff" min={0} max={100} value={lighting.midtone}
            unit="%" onChange={lighting.setMidtone} />
          <Slider id="light-highlight" label="Highlight cutoff" min={0} max={100} value={lighting.highlight}
            unit="%" onChange={lighting.setHighlight} />
          {lighting.error && <p className="hint-text" role="alert">{lighting.error}</p>}
          {lighting.loading && <p className="hint-text" role="status">Tracing light on original faces…</p>}
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
                disabled={busy || lighting.previewing}
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
