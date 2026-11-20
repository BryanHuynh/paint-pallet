import { useId, useMemo, type CSSProperties } from 'react';

function LevelsControl({
  name, rangeId, value, disabled, onChange,
}: { name: string; rangeId: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return (
    <label className="levels-value">
      <span>{name}</span>
      <span className="levels-value__input">
        <input type="number" aria-label={name + ' percent'} min={0} max={100} step={1} value={value} disabled={disabled}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) onChange(Math.max(0, Math.min(100, Math.round(next))));
          }}
          aria-controls={rangeId} />
        <span aria-hidden="true">%</span>
      </span>
    </label>
  );
}

export function LightingLevels({
  histogram, midtone, highlight, disabled, onMidtone, onHighlight,
}: {
  histogram?: Uint32Array;
  midtone: number;
  highlight: number;
  disabled: boolean;
  onMidtone: (value: number) => void;
  onHighlight: (value: number) => void;
}) {
  const id = useId();
  const heights = useMemo(() => {
    if (!histogram) return [];
    // Full shadow can dominate the histogram. Scale by the lit bins so the
    // distribution around the two movable cutoffs remains readable.
    const peak = Math.max(1, ...histogram.subarray(1));
    return Array.from(histogram, (count) => Math.min(100, count / peak * 100));
  }, [histogram]);
  const cutoffStyle = { '--levels-midtone': `${midtone}%`, '--levels-highlight': `${highlight}%` } as CSSProperties;
  return (
    <fieldset className="lighting-levels" disabled={disabled} style={cutoffStyle}>
      <legend>Lighting levels</legend>
      <div className="levels-graph">
        <div className="levels-plot" role="img"
          title={histogram ? 'Painted faces by exposure. The darkest bar can exceed the chart scale.' : undefined}
          aria-label={histogram ? 'Distribution of light exposure on painted faces' : 'Light exposure histogram. Preview lighting to measure it.'}>
          {heights.map((height, index) => <span key={index} style={{ height: `${height}%` }} aria-hidden="true" />)}
          <i className="levels-line levels-line--midtone" aria-hidden="true" />
          <i className="levels-line levels-line--highlight" aria-hidden="true" />
        </div>
        <div className="levels-track">
          <input id={`${id}-midtone`} type="range" min={0} max={100} value={midtone}
            className="levels-handle levels-handle--midtone" aria-label="Midtone cutoff"
            aria-valuetext={`${midtone}% exposure`} onChange={(event) => onMidtone(Number(event.target.value))} />
          <input id={`${id}-highlight`} type="range" min={0} max={100} value={highlight}
            className="levels-handle levels-handle--highlight" aria-label="Highlight cutoff"
            aria-valuetext={`${highlight}% exposure`} onChange={(event) => onHighlight(Number(event.target.value))} />
        </div>
      </div>
      <div className="levels-legend" aria-hidden="true">
        <span>Shadows</span><span>Midtones</span><span>Highlights</span>
      </div>
      <div className="levels-values">
        <LevelsControl name="Midtones start" rangeId={`${id}-midtone`} value={midtone} disabled={disabled} onChange={onMidtone} />
        <LevelsControl name="Highlights start" rangeId={`${id}-highlight`} value={highlight} disabled={disabled} onChange={onHighlight} />
      </div>
    </fieldset>
  );
}
