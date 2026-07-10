import { IconSpell, IconSpinner, IconX, IconWand, IconRefresh, IconCheck } from './Icons.jsx';

/*
  Esito del controllo ortografico locale (dizionari it+en): le parole ignote
  a entrambi i dizionari, con conteggio. Un tocco sulla parola la cerca
  nell'editor (per la correzione manuale); «Correggi con AI» invia SOLO
  parola + contesto a un modello veloce e applica le sostituzioni.
*/

export default function SpellPanel({ report, busy, onFixAll, onRecheck, onLocate, onClose }) {
  if (!report) return null;
  const suspects = report.suspects || [];

  return (
    <section className="card overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <IconSpell width={16} height={16} className="text-primary" />
          <h2 className="text-sm font-medium text-ink">Controllo ortografico</h2>
          <span className="text-xs text-faint">
            {report.error
              ? report.error
              : suspects.length
                ? `${suspects.length} parole sospette (refusi OCR, nomi propri o termini tecnici)`
                : 'nessun sospetto'}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Chiudi controllo ortografico"
          className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink transition-colors"
        >
          <IconX width={14} height={14} />
        </button>
      </header>

      {suspects.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {suspects.map((s) => (
            <button
              key={s.word}
              onClick={() => onLocate(s.word)}
              title={`Cerca nell'editor · contesto: «${s.context}»`}
              className="rounded-full border border-warning/50 bg-warning/10 px-2.5 py-1 font-mono text-xs text-ink transition-colors hover:bg-warning/20"
            >
              {s.word}
              {s.count > 1 && <span className="ml-1 text-faint">×{s.count}</span>}
            </button>
          ))}
        </div>
      ) : (
        !report.error && (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
            <IconCheck width={15} height={15} className="text-success" />
            Nessuna parola sconosciuta ai dizionari italiano e inglese.
          </p>
        )
      )}

      <footer className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-faint">
          Tocca una parola per trovarla nell’editor. «Correggi con AI» invia
          solo parola + contesto a un modello veloce: i nomi propri restano.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onRecheck}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <IconRefresh width={14} height={14} />
            Ricontrolla
          </button>
          {suspects.length > 0 && (
            <button
              onClick={onFixAll}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-60"
            >
              {busy ? <IconSpinner width={14} height={14} /> : <IconWand width={14} height={14} />}
              {busy ? 'Correggo…' : 'Correggi tutte con AI'}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
