import { useEffect, useRef } from 'react';

export const tutorialSteps = [
  {
    id: 'model', tab: 'model', title: 'Open a model',
    instruction: 'Open an STL or OBJ, or try the Field Robot. Use Orientation to set which way the model faces.',
  },
  {
    id: 'recipe', tab: 'palette', title: 'Build a paint recipe',
    instruction: 'Add a recipe in Palette. Choose a shadow, midtone, and highlight color for one material.',
  },
  {
    id: 'paint', tab: 'model', title: 'Paint the shadow coat',
    instruction: 'Choose your recipe in Shadow coat. Drag the Brush over a surface, or use Fill to color a connected area.',
  },
  {
    id: 'light', tab: 'model', title: 'Place the lights',
    instruction: 'Aim a light and adjust Lighting Levels to place the midtones and highlights. Preview the result, then apply it.',
  },
  {
    id: 'finish', tab: 'model', title: 'Save your model and guide',
    instruction: 'Use the Project menu to save your editable project and export a PDF painting guide.',
  },
] as const;

export function ModelTutorial({
  index, onStep, onClose, onPractice, onProjectMenu, hasModel, busy,
}: {
  index: number;
  onStep: (index: number) => void;
  onClose: () => void;
  onPractice?: () => void;
  onProjectMenu?: () => void;
  hasModel: boolean;
  busy: boolean;
}) {
  const step = tutorialSteps[index];
  const isLast = index === tutorialSteps.length - 1;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <section className="model-tutorial" aria-label="Model painting tutorial">
      <div className="model-tutorial__progress">
        <span>Tutorial</span>
        <progress value={index + 1} max={tutorialSteps.length}
          aria-label={`Tutorial step ${index + 1} of ${tutorialSteps.length}`} />
        <span aria-hidden="true">{index + 1} of {tutorialSteps.length}</span>
      </div>
      <div className="model-tutorial__lesson" aria-live="polite" aria-atomic="true">
        <h2 ref={heading} tabIndex={-1}>{step.title}</h2>
        <p>{step.id === 'model' && (!onPractice || hasModel)
          ? 'Open an STL or OBJ. Use Orientation to set which way the model faces.'
          : step.instruction}</p>
      </div>
      <div className="model-tutorial__actions">
        {step.id === 'model' && !hasModel && onPractice && (
          <button type="button" className="btn btn--secondary btn--small" disabled={busy}
            onClick={onPractice}>Use practice model</button>
        )}
        {isLast && hasModel && onProjectMenu && (
          <button type="button" className="btn btn--secondary btn--small" onClick={onProjectMenu}>
            Open Project menu
          </button>
        )}
        <button type="button" className="btn btn--secondary btn--small" disabled={index === 0}
          onClick={() => onStep(index - 1)}>Back</button>
        <button type="button" className="btn btn--primary btn--small"
          onClick={() => isLast ? onClose() : onStep(index + 1)}>{isLast ? 'Finish' : 'Next'}</button>
        <button type="button" className="btn btn--secondary btn--small" aria-label="Exit tutorial"
          onClick={onClose}>Exit</button>
      </div>
    </section>
  );
}
