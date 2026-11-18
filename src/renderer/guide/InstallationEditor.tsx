import type { InstallationPlan, KitJoint, KitPart } from '../../shared/kit';

export function InstallationEditor({ parts, joints, plan, onChange, disabled }: {
  parts: readonly KitPart[];
  joints: readonly KitJoint[];
  plan: InstallationPlan;
  onChange: (plan: InstallationPlan) => void;
  disabled: boolean;
}) {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const jointByPart = new Map(joints.map((joint) => [joint.childId, joint]));
  function move(index: number, by: number) {
    const to = index + by;
    if (to < 0 || to >= plan.order.length) return;
    const order = [...plan.order];
    [order[index], order[to]] = [order[to], order[index]];
    onChange({ ...plan, order });
  }

  return (
    <details className="guide-installation">
      <summary>Installation sequence and part views</summary>
      <ol className="guide-installation__steps">
        {plan.order.map((id, index) => {
          const joint = jointByPart.get(id);
          const name = byId.get(id)?.name || 'Untitled part';
          const parent = joint && byId.get(joint.parentId)?.name;
          return (
            <li key={id}>
              <div className="guide-installation__step">
                <span>{name} → {parent || 'Untitled parent'}</span>
                <button type="button" className="btn btn--secondary btn--small" aria-label={`Move ${name} earlier`}
                  disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button>
                <button type="button" className="btn btn--secondary btn--small" aria-label={`Move ${name} later`}
                  disabled={disabled || index === plan.order.length - 1} onClick={() => move(index, 1)}>↓</button>
              </div>
              <label className="guide-installation__note">
                <span>Notes for {name}</span>
                <textarea rows={2} value={plan.notes[id] ?? ''} disabled={disabled}
                  onChange={(event) => onChange({ ...plan, notes: { ...plan.notes, [id]: event.target.value } })} />
              </label>
            </li>
          );
        })}
      </ol>
      <fieldset>
        <legend>Include isolated paint views</legend>
        {parts.map((part) => (
          <label key={part.id}>
            <input type="checkbox" checked={plan.isolatedViews.includes(part.id)} disabled={disabled}
              onChange={(event) => onChange({ ...plan, isolatedViews: event.target.checked
                ? [...plan.isolatedViews, part.id] : plan.isolatedViews.filter((id) => id !== part.id) })} /> {part.name || 'Untitled part'}
          </label>
        ))}
      </fieldset>
    </details>
  );
}
