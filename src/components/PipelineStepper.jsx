import { STEPS } from '../hooks/usePipeline.js';
import { IconCheck, IconSpinner, IconAlert } from './Icons.jsx';

/**
 * Indicatore delle tre fasi: [1/3] Estrazione → [2/3] Formattazione →
 * [3/3] Compilazione. Mostra lo stato attivo/completato/errore di ciascuna.
 */
export default function PipelineStepper({ status, compact = false }) {
  return (
    <ol
      className={`flex ${compact ? 'items-center gap-2' : 'flex-col gap-3 sm:flex-row sm:items-stretch sm:gap-0'}`}
    >
      {STEPS.map((step, i) => {
        const state = status[step.id]; // pending | active | done | error
        return (
          <li
            key={step.id}
            className={`flex ${compact ? 'items-center' : 'flex-1 items-start'} gap-3`}
          >
            <StepBadge index={i + 1} state={state} />
            <div className={compact ? 'hidden md:block' : ''}>
              <div
                className={`text-sm font-medium leading-tight ${
                  state === 'pending' ? 'text-faint' : 'text-ink'
                }`}
              >
                <span className="tabular-nums text-faint">[{i + 1}/3]</span>{' '}
                {step.label}
                {state === 'active' && !compact && (
                  <span className="dots text-primary" aria-hidden="true" />
                )}
              </div>
              {!compact && (
                <div className="mt-0.5 text-xs text-faint">{step.hint}</div>
              )}
            </div>
            {!compact && i < STEPS.length - 1 && (
              <div
                className="mx-2 hidden h-px flex-1 self-center sm:block"
                style={{
                  background:
                    state === 'done'
                      ? 'var(--color-primary)'
                      : 'var(--color-border)',
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepBadge({ index, state }) {
  const cls = {
    pending: 'border-border text-faint',
    active: 'border-primary text-primary',
    done: 'border-primary bg-primary text-primary-ink',
    error: 'border-danger text-danger',
  }[state];

  return (
    <span
      className={`grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold tabular-nums transition-colors ${cls}`}
    >
      {state === 'done' ? (
        <IconCheck width={16} height={16} />
      ) : state === 'active' ? (
        <IconSpinner width={16} height={16} />
      ) : state === 'error' ? (
        <IconAlert width={16} height={16} />
      ) : (
        index
      )}
    </span>
  );
}
