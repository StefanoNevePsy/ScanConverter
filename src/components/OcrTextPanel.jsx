import { useMemo, useState } from 'react';
import { IconText } from './Icons.jsx';
import CopyButton from './CopyButton.jsx';
import { SYSTEM_PROMPT, buildGuidance } from '../lib/gemini.js';
import { chunkDocument } from '../lib/session.js';

/*
  Mostra il testo grezzo estratto dall'OCR (Markdown con gerarchia e
  segnaposti immagine) per usarlo con un LLM esterno (ChatGPT, Gemma, o la
  chat di Gemini). Per documenti lunghi il testo è diviso in "pezzi": si copia
  un pezzo per volta con le istruzioni giuste (il primo col preambolo, i
  successivi in continuazione), mantenendo la gerarchia tra un pezzo e l'altro.
*/

const CHUNK_SIZE = 6000;

export default function OcrTextPanel({ text, styleHint, fixTypos }) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const chunks = useMemo(() => chunkDocument(text || '', CHUNK_SIZE), [text]);
  if (!text) return null;

  const total = chunks.length;
  const i = Math.min(idx, total - 1);

  const promptFor = (n) => {
    if (n === 0) {
      return (
        SYSTEM_PROMPT +
        '\n\n' +
        buildGuidance(styleHint, { fixTypos }) +
        (total > 1
          ? '\n\nNOTA: il documento verrà fornito in ' +
            total +
            ' parti. Questa è la PARTE 1: genera il preambolo Typst completo ' +
            '(#set/#show) e il corpo di questa parte. Alle parti successive ' +
            'continuerai SENZA ripetere il preambolo.'
          : '') +
        '\n\n--- TESTO OCR' +
        (total > 1 ? ' (parte 1/' + total + ')' : '') +
        ' ---\n\n' +
        chunks[0] +
        '\n\n--- FINE ---\nRestituisci SOLO il codice Typst, senza spiegazioni.'
      );
    }
    return (
      'CONTINUA il documento Typst della tua risposta precedente. NON ripetere ' +
      'il preambolo (#set/#show già dati) e NON ripartire da "= 1": prosegui il ' +
      'corpo mantenendo ESATTAMENTE i livelli di titolo (## → ==, ### → ===). ' +
      'Converti `![didascalia](/figures/fig-N.png)` in ' +
      '`#figure(image("/figures/fig-N.png", width: 80%), caption: [didascalia])`.' +
      '\n\n--- TESTO OCR (parte ' +
      (n + 1) +
      '/' +
      total +
      ') ---\n\n' +
      chunks[n] +
      '\n\n--- FINE ---\nRestituisci SOLO il corpo Typst (nessun preambolo).'
    );
  };

  return (
    <section className="card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/50"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2.5">
          <IconText width={16} height={16} className="text-annote" />
          <span className="text-sm font-medium text-ink">Testo OCR (per LLM esterni)</span>
          <span className="hidden text-xs text-faint sm:inline">
            {total > 1 ? `${total} parti · ` : ''}copialo per generare il Typst con ChatGPT / Gemma
          </span>
        </span>
        <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          {total > 1 && (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs font-medium text-muted">
                Parte {i + 1} di {total}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIdx(Math.max(0, i - 1))}
                  disabled={i === 0}
                  className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-40"
                >
                  ‹ Prec
                </button>
                <button
                  onClick={() => setIdx(Math.min(total - 1, i + 1))}
                  disabled={i === total - 1}
                  className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-40"
                >
                  Succ ›
                </button>
              </div>
            </div>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <CopyButton
              getText={() => chunks[i]}
              label={total > 1 ? 'Copia solo testo (parte)' : 'Copia testo OCR'}
              className="border border-border bg-surface-2 text-ink hover:bg-surface-3"
            />
            <CopyButton
              getText={() => promptFor(i)}
              label={total > 1 ? `Copia prompt parte ${i + 1}` : 'Copia prompt + testo'}
              className="bg-primary text-primary-ink hover:bg-primary-strong"
            />
            <span className="text-xs text-faint">
              {total > 1
                ? 'Incolla ogni parte nella stessa chat, in ordine; poi unisci il Typst nell’editor.'
                : 'Poi incolla il Typst generato nell’editor e premi “Genera PDF”.'}
            </span>
          </div>
          <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed text-muted whitespace-pre-wrap">
            {chunks[i]}
          </pre>
        </div>
      )}
    </section>
  );
}
