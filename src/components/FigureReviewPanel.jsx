import { useMemo, useState } from 'react';
import { IconCheck, IconAlert, IconImage } from './Icons.jsx';

/*
  Revisione delle figure dopo l'OCR: la pipeline è in pausa e l'utente sceglie
  quali ritagli tenere. Gli artefatti probabili (numeri di pagina scritti a
  mano, timbri, scarabocchi ai margini) sono pre-deselezionati e contrassegnati.
*/

export default function FigureReviewPanel({ items, onConfirm }) {
  // Selezione locale, inizializzata dalla proposta della pipeline.
  const [keep, setKeep] = useState(() => new Set(items.filter((i) => i.keep).map((i) => i.path)));

  const toggle = (path) =>
    setKeep((k) => {
      const next = new Set(k);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const junkCount = useMemo(() => items.filter((i) => i.junk).length, [items]);

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <IconImage width={16} height={16} className="text-primary" />
          <h2 className="text-sm font-medium text-ink">
            Immagini trovate: scegli quali tenere
          </h2>
        </div>
        <span className="text-xs text-faint">
          {keep.size}/{items.length} selezionate
        </span>
      </header>

      {junkCount > 0 && (
        <p className="flex items-start gap-2 border-b border-border bg-warning/5 px-4 py-2.5 text-xs text-muted">
          <IconAlert width={14} height={14} className="mt-0.5 shrink-0 text-warning" />
          {junkCount === 1
            ? 'Un ritaglio sembra un artefatto della scansione (numero di pagina, timbro, segno a mano) ed è stato deselezionato.'
            : `${junkCount} ritagli sembrano artefatti della scansione (numeri di pagina, timbri, segni a mano) e sono stati deselezionati.`}{' '}
          Tocca una miniatura per cambiarne lo stato.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3 p-4 sm:grid-cols-4 md:grid-cols-6">
        {items.map((it) => {
          const selected = keep.has(it.path);
          return (
            <button
              key={it.path}
              type="button"
              onClick={() => toggle(it.path)}
              aria-pressed={selected}
              className={`group relative overflow-hidden rounded-lg border-2 bg-white transition-all ${
                selected
                  ? 'border-primary shadow-sm'
                  : 'border-border opacity-45 grayscale hover:opacity-70'
              }`}
              title={selected ? 'Selezionata: tocca per rimuovere' : 'Rimossa: tocca per tenere'}
            >
              <img
                src={it.url}
                alt=""
                className="aspect-square w-full object-contain p-1"
                loading="lazy"
              />
              <span
                className={`absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full text-white ${
                  selected ? 'bg-primary' : 'bg-surface-3 text-faint'
                }`}
                aria-hidden="true"
              >
                {selected && <IconCheck width={12} height={12} />}
              </span>
              {it.junk && (
                <span className="absolute bottom-0 inset-x-0 bg-warning/90 px-1 py-0.5 text-center text-[10px] font-medium leading-tight text-black">
                  artefatto?
                </span>
              )}
            </button>
          );
        })}
      </div>

      <footer className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-faint">
          Le immagini rimosse spariscono dal testo e dal PDF finale. La
          dimensione nel PDF rispecchia quella nell’originale.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setKeep(new Set(items.map((i) => i.path)))}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink"
          >
            Tieni tutte
          </button>
          <button
            type="button"
            onClick={() => onConfirm([...keep])}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong"
          >
            <IconCheck width={15} height={15} />
            Continua {keep.size ? `con ${keep.size} figure` : 'senza figure'}
          </button>
        </div>
      </footer>
    </section>
  );
}
