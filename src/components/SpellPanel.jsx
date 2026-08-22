import { useEffect, useState } from 'react';
import { IconSpell, IconSpinner, IconX, IconWand, IconRefresh, IconCheck, IconSearch, IconBookPlus } from './Icons.jsx';

/*
  Esito del controllo ortografico locale (dizionari it+en). Ogni parola è un
  chip selezionabile: un tocco la include/esclude dall'invio all'AI (es.
  «Bateson» è un nome, inutile farlo valutare); la lente la cerca
  nell'editor. Le escluse si possono aggiungere al dizionario personale, così
  non vengono più segnalate. «Correggi con AI» invia SOLO parola + contesto
  delle selezionate.
*/

export default function SpellPanel({
  report,
  busy,
  onFixAll,
  onRecheck,
  onLocate,
  onClose,
  onIgnore,
  onFixSpacing,
  modelLabel,
}) {
  const suspects = report?.suspects || [];
  const [skip, setSkip] = useState(() => new Set());

  // Nuovo report → riparti con tutte le parole selezionate.
  useEffect(() => {
    setSkip(new Set());
  }, [report]);

  if (!report) return null;

  const toggle = (word) =>
    setSkip((k) => {
      const next = new Set(k);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });

  const selected = suspects.filter((s) => !skip.has(s.word)).map((s) => s.word);

  return (
    <section className="card overflow-hidden">
      <header className="flex min-w-0 items-start justify-between gap-3 border-b border-border px-4 py-2.5 sm:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <IconSpell width={16} height={16} className="text-primary" />
          <h2 className="text-sm font-medium text-ink">Controllo ortografico</h2>
          <span className="text-xs text-faint">
            {report.error
              ? report.error
              : suspects.length
                ? `${selected.length}/${suspects.length} selezionate per l’AI · il libro aggiunge al dizionario`
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
          {suspects.map((s) => {
            const excluded = skip.has(s.word);
            return (
              <span
                key={s.word}
                className={`inline-flex items-center overflow-hidden rounded-full border font-mono text-xs transition-all ${
                  excluded
                    ? 'border-border bg-surface-2 text-faint line-through opacity-60'
                    : 'border-warning/50 bg-warning/10 text-ink'
                }`}
              >
                <button
                  onClick={() => toggle(s.word)}
                  title={
                    excluded
                      ? 'Esclusa: tocca per reincludere nell’invio all’AI'
                      : `Inclusa nell’invio all’AI: tocca per escludere · «${s.context}»`
                  }
                  className="py-1 pl-2.5 pr-1.5 transition-colors hover:bg-warning/20"
                >
                  {s.word}
                  {s.count > 1 && <span className="ml-1 text-faint">×{s.count}</span>}
                </button>
                <button
                  onClick={() => onLocate(s)}
                  title="Seleziona nel Typst ed evidenzia nel PDF"
                  aria-label={`Apri «${s.word}» nel documento`}
                  className="border-l border-border/50 px-1.5 py-1 text-muted transition-colors hover:text-ink"
                >
                  <IconSearch width={11} height={11} />
                </button>
                <button
                  type="button"
                  onClick={() => onIgnore([s.word])}
                  title={`Aggiungi «${s.word}» al dizionario personale e non segnalarla più`}
                  aria-label={`Aggiungi «${s.word}» al dizionario personale`}
                  className="border-l border-border/50 px-1.5 py-1 text-muted transition-colors hover:bg-lime-soft hover:text-ink"
                >
                  <IconBookPlus width={12} height={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        !report.error && (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
            <IconCheck width={15} height={15} className="text-success" />
            Nessuna parola sconosciuta ai dizionari italiano e inglese.
          </p>
        )
      )}

      <footer className="flex min-w-0 flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            onClick={onFixSpacing}
            disabled={busy}
            title="Rimuove spazi prima della punteggiatura, li aggiunge dove mancano, sistema parentesi e trattini — deterministico, senza AI"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            Spazi e punteggiatura
          </button>
          <button
            onClick={onRecheck}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <IconRefresh width={14} height={14} />
            Ricontrolla
          </button>
          {skip.size > 0 && (
            <button
              onClick={() => onIgnore([...skip])}
              disabled={busy}
              title="Le parole escluse non verranno più segnalate (dizionario personale, salvato sul dispositivo)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              Non segnalare più ({skip.size})
            </button>
          )}
        </div>
        {suspects.length > 0 && (
          <div className="flex min-w-0 max-w-full flex-col items-stretch gap-1 sm:items-end">
            <button
              onClick={() => onFixAll(selected)}
              disabled={busy || !selected.length}
              title={`Usa ${modelLabel || 'il modello di rilettura selezionato'}`}
              className="inline-flex max-w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-60"
            >
              {busy ? <IconSpinner width={14} height={14} /> : <IconWand width={14} height={14} />}
              {busy ? 'Correggo…' : `Correggi ${selected.length} con AI`}
            </button>
            {modelLabel && (
              <span className="max-w-64 truncate text-[10px] text-faint">{modelLabel}</span>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}
