export function EdgePanel({ edge, busy, chooseTool, beginPreview, brushSize, setBrushSize }: {
  edge: ReturnType<typeof import('./useEdgeHighlight').useEdgeHighlight>;
  busy: boolean;
  chooseTool: (tool: 'brush' | 'erase' | null) => void;
  beginPreview: () => void;
  brushSize: number;
  setBrushSize: (size: number) => void;
}) {
  return (
    <section className="inspector-section" aria-label="Edge highlights">
      <h2>Edge highlights</h2>
      {!edge.regionHasShadow ? <p className="hint-text">Select a region with a painted shadow coat.</p> : (
        <>
          {edge.previewing ? (
            <>
              <div className="shadow-size">
                <label htmlFor="edge-sensitivity">Sensitivity</label>
                <input id="edge-sensitivity" type="range" min={0} max={100} value={edge.sensitivity}
                  onChange={(event) => edge.setSensitivity(Number(event.target.value))} />
                <output htmlFor="edge-sensitivity">{edge.sensitivity}%</output>
              </div>
              <div className="shadow-size">
                <label htmlFor="edge-width">Band width</label>
                <input id="edge-width" type="range" min={0.05} max={8} step={0.05} value={edge.width}
                  onChange={(event) => edge.setWidth(Number(event.target.value))} />
                <output htmlFor="edge-width">{edge.width}%</output>
              </div>
              <p className="hint-text" role={edge.failure ? 'alert' : 'status'}>
                {edge.failure ?? (edge.loading ? 'Finding raised edges…' : `${edge.suggested.toLocaleString()} faces in the suggested band`)}
              </p>
              {edge.confirming && <p className="hint-text">Replace manual edge edits in this region?</p>}
              <div className="shadow-tools">
                <button type="button" className="btn btn--primary btn--small" disabled={busy || edge.loading || Boolean(edge.failure)}
                  onClick={() => edge.apply(edge.confirming)}>
                  {edge.confirming ? 'Replace edge edits' : 'Apply edges'}
                </button>
                <button type="button" className="btn btn--secondary btn--small" onClick={edge.cancel}>Cancel edges</button>
              </div>
            </>
          ) : (
            <div className="shadow-tools">
              <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={beginPreview}>Suggest edges</button>
              <button type="button" className="btn btn--secondary btn--small" disabled={busy} aria-pressed={edge.tool === 'brush'}
                onClick={() => chooseTool(edge.tool === 'brush' ? null : 'brush')}>Brush edges</button>
              <button type="button" className="btn btn--secondary btn--small" disabled={busy} aria-pressed={edge.tool === 'erase'}
                onClick={() => chooseTool(edge.tool === 'erase' ? null : 'erase')}>Erase edges</button>
            </div>
          )}
          {edge.tool && (
            <div className="shadow-size">
              <label htmlFor="edge-brush-size">Edge brush size</label>
              <input id="edge-brush-size" type="range" min={1} max={240} value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))} disabled={busy} />
              <output htmlFor="edge-brush-size">{brushSize} px</output>
            </div>
          )}
        </>
      )}
      {(edge.canUndo || edge.canRedo) && (
        <div className="shadow-tools">
          <button type="button" className="btn btn--secondary btn--small" disabled={busy || edge.previewing || !edge.canUndo}
            onClick={edge.undo}>Undo edge edit</button>
          <button type="button" className="btn btn--secondary btn--small" disabled={busy || edge.previewing || !edge.canRedo}
            onClick={edge.redo}>Redo edge edit</button>
        </div>
      )}
    </section>
  );
}
