import type { KitPart } from '../../shared/kit';
import { canAttach } from './jointMath';
import { JOINT_STEPS, type useKitAssembly } from './useKitAssembly';

export function JointPanel({ assembly, parts, selected, busy }: {
  assembly: ReturnType<typeof useKitAssembly>;
  parts: KitPart[];
  selected: KitPart | undefined;
  busy: boolean;
}) {
  const draft = assembly.draft;
  if (parts.length < 2) return null;
  const child = parts.find((part) => part.id === draft?.childId);
  const parent = parts.find((part) => part.id === draft?.parentId);
  const step = child ? Math.max(...child.model.bounds.max.map((axis, i) => axis - child.model.bounds.min[i])) / 100 || 0.1 : 0.1;

  return (
    <section className="inspector-section" aria-label="Joint attachment">
      <h2>Attachment</h2>
      {draft ? (
        <>
          <p className="hint-text">{child?.name || 'Part'} → {parent?.name || 'Parent'}</p>
          <div className="field-row">
            <label htmlFor="joint-parent">Parent</label>
            <select id="joint-parent" className="select-input" value={draft.parentId} disabled={busy || assembly.analyzing}
              onChange={(event) => assembly.selectParent(event.target.value)}>
              {parts.filter((part) => canAttach(parts, assembly.joints, draft.childId, part.id)).map((part) => (
                <option key={part.id} value={part.id}>{part.name}</option>
              ))}
            </select>
          </div>
          {draft.method === 'six-face' ? (
            <>
              <ol className="joint-steps">
                {JOINT_STEPS.map((label, index) => (
                  <li key={label} aria-current={draft.picks.length === index ? 'step' : undefined}
                    data-complete={index < draft.picks.length}>{label}</li>
                ))}
              </ol>
              {draft.preview && ['Seating depth', 'First wall clearance', 'Second wall clearance'].map((label, index) => (
                <div className="field-row" key={label}>
                  <label htmlFor={`joint-adjust-${index}`}>{label}</label>
                  <input id={`joint-adjust-${index}`} className="select-input" type="number" step={step}
                    value={draft.adjustments[index]} onChange={(event) => assembly.adjust(index, Number(event.target.value))} />
                </div>
              ))}
              {draft.picks.length > 0 && (
                <button type="button" className="btn btn--secondary btn--small" disabled={busy || assembly.analyzing} onClick={assembly.back}>Back one face</button>
              )}
            </>
          ) : (
            <>
              {draft.method === 'manual' && !draft.preview && (
                <div className="joint-manual-grid">
                  {['X', 'Y', 'Z'].map((axis, index) => (
                    <div className="joint-axis" key={axis}>
                      <span>{axis}</span>
                      <button type="button" className="btn btn--secondary btn--small" aria-label={`Move -${axis}`} disabled={busy}
                        onClick={() => assembly.adjustManual(index, -step, false)}>−</button>
                      <button type="button" className="btn btn--secondary btn--small" aria-label={`Move +${axis}`} disabled={busy}
                        onClick={() => assembly.adjustManual(index, step, false)}>+</button>
                      <button type="button" className="btn btn--secondary btn--small" aria-label={`Rotate -${axis}`} disabled={busy}
                        onClick={() => assembly.adjustManual(index, -5, true)}>↶</button>
                      <button type="button" className="btn btn--secondary btn--small" aria-label={`Rotate +${axis}`} disabled={busy}
                        onClick={() => assembly.adjustManual(index, 5, true)}>↷</button>
                    </div>
                  ))}
                  <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={assembly.keepPose}>Keep position</button>
                </div>
              )}
              {!draft.preview && (
                <div className="shadow-tools">
                  <button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={assembly.markPoint}>
                    {draft.point ? 'Move joint marker' : 'Mark joint on parent'}
                  </button>
                  <button type="button" className="btn btn--secondary btn--small" disabled={busy || !draft.point || assembly.picking}
                    onClick={assembly.showPreview}>Preview fit</button>
                </div>
              )}
            </>
          )}
          {assembly.picking && <p className="hint-text" role="status">Click the joint location on the parent.</p>}
          {assembly.analyzing && <p className="hint-text" role="status">Finding the connected planar face…</p>}
          {assembly.error && <p className="hint-text" role="alert">{assembly.error}</p>}
          <div className="shadow-tools">
            {!draft.preview && assembly.expectedId === draft.parentId && (
              <button type="button" className="btn btn--secondary btn--small" disabled={busy}
                onClick={() => assembly.setIsolated(assembly.isolated ? null : draft.parentId)}>
                {assembly.isolated ? 'Show all parts' : 'Show socket alone'}
              </button>
            )}
            {draft.preview && <button type="button" className="btn btn--primary btn--small" disabled={busy} onClick={assembly.confirm}>Confirm attachment</button>}
            <button type="button" className="btn btn--secondary btn--small" onClick={assembly.cancel}>Cancel attachment</button>
          </div>
        </>
      ) : selected && selected.id !== parts[0]?.id && (
        <div className="shadow-tools">
          <button type="button" className="btn btn--secondary btn--small" disabled={busy}
            onClick={() => assembly.begin(selected, 'authored')}>Attach current pose</button>
          <button type="button" className="btn btn--secondary btn--small" disabled={busy}
            onClick={() => assembly.begin(selected, 'six-face')}>Six-face fit</button>
          <button type="button" className="btn btn--secondary btn--small" disabled={busy}
            onClick={() => assembly.begin(selected, 'manual')}>Move and rotate</button>
        </div>
      )}
      {!draft && (assembly.canUndo || assembly.canRedo) && (
        <div className="shadow-tools">
          <button type="button" className="btn btn--secondary btn--small" disabled={busy || !assembly.canUndo}
            onClick={assembly.undo}>Undo assembly edit</button>
          <button type="button" className="btn btn--secondary btn--small" disabled={busy || !assembly.canRedo}
            onClick={assembly.redo}>Redo assembly edit</button>
        </div>
      )}
      {!draft && selected && assembly.joints.some((joint) => joint.childId === selected.id) && (
        <p className="hint-text">Attached to {parts.find((part) => part.id === assembly.joints.find((joint) => joint.childId === selected.id)?.parentId)?.name}.</p>
      )}
    </section>
  );
}
