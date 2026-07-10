import { useState } from 'react';
import { IconAlert } from './Icons.jsx';

/*
  Esito della verifica di fedeltà testuale: per ogni chunk sotto soglia mostra
  la copertura e i passaggi del testo OCR che NON risultano nell'output, così
  l'utente può reintegrarli a mano (o rigenerare) invece di scoprirlo a stampa
  avvenuta. Compare solo quando c'è qualcosa da segnalare.
*/

export default function FidelityPanel({ warnings }) {
  const [open, setOpen] = useState(false);
  if (!warnings?.length) return null;

  const worst = Math.min(...warnings.map((w) => w.coverage));
  const totalMissing = warnings.reduce((n, w) => n + w.missing.length, 0);

  return (
    <section className="overflow-hidden rounded-xl border border-warning/40 bg-warning/10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2.5 text-sm">
          <IconAlert width={16} height={16} className="shrink-0 text-warning" />
          <span className="text-ink">
            <span className="font-medium">Verifica fedeltà: </span>
            {totalMissing === 1
              ? 'un passaggio del testo sorgente potrebbe mancare'
              : `${totalMissing} passaggi del testo sorgente potrebbero mancare`}{' '}
            (copertura minima {Math.round(worst * 100)}%).
          </span>
        </span>
        <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-warning/30 px-4 py-3">
          {warnings.map((w) => (
            <div key={w.chunk}>
              <div className="mb-1 text-xs font-medium text-muted">
                {w.total > 1 ? `Chunk ${w.chunk}/${w.total} · ` : ''}
                copertura {Math.round(w.coverage * 100)}%
              </div>
              <ul className="space-y-1">
                {w.missing.map((m, i) => (
                  <li key={i} className="text-[13px] leading-snug text-ink">
                    <span className="text-faint">«</span>
                    {m.length > 220 ? m.slice(0, 220) + '…' : m}
                    <span className="text-faint">»</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-muted">
            Confronta con il testo estratto (pannello OCR) e reintegra a mano
            nell’editor, oppure rigenera il layout. La verifica è testuale:
            piccole riformulazioni possono produrre falsi positivi.
          </p>
        </div>
      )}
    </section>
  );
}
