import { useEffect, useMemo, useState } from 'react';
import { IconCheck, IconImage, IconAlert } from './Icons.jsx';

/*
  Anteprima delle pagine PRIMA dell'OCR: qui si raddrizzano le pagine ruotate
  (↻ a passi di 90°) e si dividono le doppie pagine (spread) in due pagine.
  Le doppie pagine sono rilevate automaticamente dal rapporto d'aspetto e
  proposte già selezionate; tutto è modificabile pagina per pagina.
*/

export default function PagesReviewPanel({ items, onConfirm, busy }) {
  // Stato locale delle modifiche, inizializzato dal rilevamento automatico.
  const [edits, setEdits] = useState(() => items.map((i) => ({ rotate: 0, split: !!i.split })));

  useEffect(() => {
    setEdits(items.map((i) => ({ rotate: 0, split: !!i.split })));
  }, [items]);

  const rotate = (i) =>
    setEdits((e) => e.map((x, k) => (k === i ? { ...x, rotate: (x.rotate + 90) % 360 } : x)));
  const toggleSplit = (i) =>
    setEdits((e) => e.map((x, k) => (k === i ? { ...x, split: !x.split } : x)));

  const finalCount = useMemo(
    () => edits.reduce((n, e) => n + (e.split ? 2 : 1), 0),
    [edits],
  );
  const autoSpreads = items.filter((i) => i.split).length;

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <IconImage width={16} height={16} className="text-primary" />
          <h2 className="text-sm font-medium text-ink">
            Controlla le pagine prima dell’estrazione
          </h2>
        </div>
        <span className="text-xs text-faint">
          {items.length} caricate → {finalCount} da estrarre
        </span>
      </header>

      {autoSpreads > 0 && (
        <p className="flex items-start gap-2 border-b border-border bg-warning/5 px-4 py-2.5 text-xs text-muted">
          <IconAlert width={14} height={14} className="mt-0.5 shrink-0 text-warning" />
          {autoSpreads === 1
            ? 'Una pagina sembra una doppia pagina (libro aperto) e verrà divisa in due.'
            : `${autoSpreads} pagine sembrano doppie pagine (libro aperto) e verranno divise in due.`}{' '}
          Puoi cambiare la scelta pagina per pagina.
        </p>
      )}

      <div className="grid max-h-[46vh] grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {items.map((it, i) => {
          const e = edits[i] || { rotate: 0, split: false };
          return (
            <div
              key={it.index}
              className="overflow-hidden rounded-lg border border-border bg-white"
            >
              <div className="relative grid aspect-[3/4] place-items-center overflow-hidden">
                <img
                  src={it.url}
                  alt={`Pagina ${i + 1}`}
                  loading="lazy"
                  className="max-h-full max-w-full object-contain transition-transform"
                  style={{ transform: e.rotate ? `rotate(${e.rotate}deg)` : undefined }}
                />
                {e.split && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-1 left-1/2 w-0 border-l-2 border-dashed border-primary"
                  />
                )}
                {e.rotate > 0 && (
                  <span className="absolute left-1 top-1 rounded bg-primary px-1 py-0.5 text-[10px] font-semibold text-primary-ink">
                    {e.rotate}°
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-1 border-t border-border bg-surface px-1.5 py-1">
                <span className="pl-1 text-[11px] tabular-nums text-faint">{i + 1}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => rotate(i)}
                    title="Ruota di 90° (in senso orario)"
                    aria-label={`Ruota pagina ${i + 1}`}
                    className="rounded px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    ↻
                  </button>
                  <button
                    onClick={() => toggleSplit(i)}
                    title="Doppia pagina: dividi in due (sinistra poi destra)"
                    aria-pressed={e.split}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                      e.split
                        ? 'bg-primary text-primary-ink'
                        : 'text-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    ⇹2
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <footer className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-faint">
          ↻ raddrizza una pagina storta · ⇹2 divide una doppia pagina in due
          (prima la sinistra, poi la destra).
        </p>
        <button
          onClick={() => onConfirm(edits)}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-60"
        >
          <IconCheck width={15} height={15} />
          Avvia estrazione ({finalCount} {finalCount === 1 ? 'pagina' : 'pagine'})
        </button>
      </footer>
    </section>
  );
}
