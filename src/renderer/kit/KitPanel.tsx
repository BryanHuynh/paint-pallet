import type { KitPart } from '../../shared/kit';

export function KitPanel({ parts, selected, busy, choose, add, rename, remove, isolated, toggleIsolation, toggleVisibility }: {
  parts: KitPart[];
  selected: KitPart | undefined;
  busy: boolean;
  choose: (part: KitPart) => void;
  add: () => void;
  rename: (name: string) => void;
  remove: (part: KitPart) => void;
  isolated: boolean;
  toggleIsolation: () => void;
  toggleVisibility: () => void;
}) {
  const bytes = parts.reduce((total, part) => total + part.model.fileSizeBytes, 0);
  return (
    <section className="inspector-section" aria-label="Assembly">
      <h2>Assembly</h2>
      <div className="field-row">
        <label htmlFor="kit-part">Inspect part</label>
        <select id="kit-part" className="select-input" value={selected?.id ?? ''} disabled={busy}
          onChange={(event) => {
            const next = parts.find((part) => part.id === event.target.value);
            if (next) choose(next);
          }}>
          {parts.map((part, index) => (
            <option key={part.id} value={part.id}>{part.name || 'Untitled part'}{index === 0 ? ' · Anchor' : part.staged ? ' · Staged' : ''}</option>
          ))}
        </select>
      </div>
      {selected && (
        <div className="field-row">
          <label htmlFor="kit-part-name">Part name</label>
          <input id="kit-part-name" className="select-input" value={selected.name} disabled={busy}
            onChange={(event) => rename(event.target.value)} />
        </div>
      )}
      <div className="shadow-tools">
        <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={add}>Add kit parts</button>
        {selected && parts.length > 1 && (
          <>
            <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={toggleIsolation}>
              {isolated ? 'Show assembly' : 'Isolate part'}
            </button>
            <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={toggleVisibility}>
              {selected.hidden ? 'Show part' : 'Hide part'}
            </button>
          </>
        )}
        {selected?.staged && (
          <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={() => remove(selected)}>
            Remove staged part
          </button>
        )}
      </div>
      {parts.length > 1 && (
        <p className="hint-text">{parts.length} parts · {(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB of 2 GiB</p>
      )}
    </section>
  );
}
