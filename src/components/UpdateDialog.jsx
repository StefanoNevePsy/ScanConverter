import { IconX, IconSpinner } from './Icons.jsx';

/** Conferma dell'aggiornamento: versione, note, avanzamento del download. */
export default function UpdateDialog({ update, onClose }) {
  const { info, phase, progress, error, install } = update;
  const downloading = phase === 'downloading';
  const pct = Math.round(progress.pct || 0);

  return (
    <div
      className="fixed inset-0 grid place-items-center p-4"
      style={{ zIndex: 'var(--z-modal)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
    >
      <button
        aria-label="Chiudi"
        onClick={downloading ? undefined : onClose}
        className="anim-fade fixed inset-0 cursor-default bg-black/60"
      />
      <div
        className="card anim-settle relative w-full max-w-md space-y-4 p-5 shadow-2xl"
        style={{ zIndex: 'var(--z-modal)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="update-title" className="font-display text-xl text-ink">
              Aggiornamento {info?.latest}
            </h2>
            <p className="text-xs text-muted">Stai usando la versione {info?.current}.</p>
          </div>
          {!downloading && (
            <button type="button" onClick={onClose} aria-label="Chiudi" className="text-muted hover:text-ink">
              <IconX width={18} height={18} />
            </button>
          )}
        </div>

        {info?.notes && (
          <p className="max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted">
            {info.notes}
          </p>
        )}

        {downloading && (
          <div aria-live="polite">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {pct >= 100 ? 'Installazione in corso, l’app si riavvierà da sola…' : `Download… ${pct}%`}
            </p>
          </div>
        )}

        {error && <p role="alert" className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onClose} disabled={downloading}>
            Più tardi
          </button>
          <button type="button" className="button-primary" onClick={install} disabled={downloading}>
            {downloading && <IconSpinner width={14} height={14} />}
            Aggiorna e riavvia
          </button>
        </div>
      </div>
    </div>
  );
}
