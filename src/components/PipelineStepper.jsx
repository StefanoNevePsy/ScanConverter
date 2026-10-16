import { IconCheck, IconAlert } from './Icons.jsx';

/**
 * Le tre fasi del documento, con nomi che dicono cosa succede DAVVERO nel
 * workflow scelto: «Impaginazione» con un modello, «Ricomposizione» con le
 * regole, «Testo sotto le pagine» per la scansione ricercabile.
 */
export const WORKFLOW_STEPS = {
  legacy: [
    { id: 'ocr', label: 'Lettura', hint: 'testo dalle pagine' },
    { id: 'format', label: 'Impaginazione', short: 'Layout', hint: 'un modello scrive il Typst' },
    { id: 'compile', label: 'PDF', hint: 'composizione tipografica' },
  ],
  strict: [
    { id: 'ocr', label: 'Lettura', hint: 'testo dalle pagine' },
    { id: 'format', label: 'Ricomposizione', short: 'Testo', hint: 'testo fedele, regole fisse' },
    { id: 'compile', label: 'PDF', hint: 'composizione tipografica' },
  ],
  scan: [
    { id: 'ocr', label: 'Lettura', hint: 'testo dalle pagine' },
    { id: 'format', label: 'Testo sotto le pagine', short: 'Testo', hint: 'invisibile, cercabile' },
    { id: 'compile', label: 'PDF ricercabile', short: 'PDF', hint: 'pagine originali' },
  ],
};

const NUMERALS = ['I', 'II', 'III'];
const STATE_LABEL = { pending: 'in attesa', active: 'in corso', done: 'completata', error: 'errore' };

export default function PipelineStepper({ status, workflow = 'legacy', detail }) {
  const steps = WORKFLOW_STEPS[workflow] || WORKFLOW_STEPS.legacy;
  return (
    <ol aria-label="Avanzamento del documento" className="stepper">
      {steps.map((step, i) => {
        const state = status[step.id] || 'pending';
        return (
          <li
            key={step.id}
            className={`stepper-step is-${state}`}
            aria-current={state === 'active' ? 'step' : undefined}
            aria-label={`Fase ${i + 1} di ${steps.length}: ${step.label}, ${STATE_LABEL[state]}`}
          >
            <span className="stepper-mark" aria-hidden="true">
              {state === 'done' ? (
                <IconCheck key="done" className="anim-stamp" width={14} height={14} />
              ) : state === 'error' ? (
                <IconAlert width={14} height={14} />
              ) : (
                NUMERALS[i]
              )}
            </span>
            <span className="min-w-0">
              <span className="stepper-label">
                <span className="stepper-long">{step.label}</span>
                <span className="stepper-short">{step.short || step.label}</span>
              </span>
              <span className="stepper-hint">
                {state === 'active' && detail ? detail : step.hint}
              </span>
            </span>
            {/* Il filetto sotto la fase: si traccia mentre lavora, pieno a fase conclusa. */}
            <span className="stepper-rule" aria-hidden="true">
              {(state === 'done' || state === 'active') && <i key={state} />}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
