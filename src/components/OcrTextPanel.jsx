import { useEffect, useMemo, useRef, useState } from 'react';
import { IconSpinner, IconText, IconWand } from './Icons.jsx';
import CopyButton from './CopyButton.jsx';
import { SYSTEM_PROMPT, buildGuidance } from '../lib/gemini.js';
import { chunkTextRanges } from '../lib/session.js';

/*
  Mostra il testo grezzo estratto dall'OCR (Markdown con gerarchia e
  segnaposti immagine) per usarlo con un LLM esterno (ChatGPT, Gemma, o la
  chat di Gemini). Per documenti lunghi il testo è diviso in "pezzi": si copia
  un pezzo per volta con le istruzioni giuste (il primo col preambolo, i
  successivi in continuazione), mantenendo la gerarchia tra un pezzo e l'altro.
*/

const CHUNK_SIZE = 6000;

export default function OcrTextPanel({
  text,
  styleHint,
  fixTypos,
  onReviseSelection,
  selectionBusy,
  selectionDetail,
  proofModelLabel,
  translationModelLabel,
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [selection, setSelection] = useState(null);
  const [notice, setNotice] = useState('');
  const textRef = useRef(null);
  const ranges = useMemo(() => chunkTextRanges(text || '', CHUNK_SIZE), [text]);
  const chunks = useMemo(() => ranges.map((range) => range.text), [ranges]);
  useEffect(() => {
    setSelection(null);
    setNotice('');
  }, [text, idx]);
  if (!text) return null;

  const total = chunks.length;
  const i = Math.min(idx, total - 1);
  const range = ranges[i];
  const targeted = typeof onReviseSelection === 'function';

  const captureSelection = (event) => {
    if (!targeted || !range) return;
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    setSelection(end > start ? {
      start: range.start + start,
      end: range.start + end,
      count: end - start,
    } : null);
    setNotice('');
  };

  const clearSelection = () => {
    setSelection(null);
    const textarea = textRef.current;
    if (textarea) textarea.setSelectionRange(0, 0);
  };

  const runSelectionAction = async (mode) => {
    if (!selection || selectionBusy) return;
    const result = await onReviseSelection({ ...selection, mode });
    setNotice(result?.message || 'Operazione completata.');
    if (result?.ok) clearSelection();
  };

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
          <span className="text-sm font-medium text-ink">
            {targeted ? 'Testo di lavoro' : 'OCR originale · riferimento'}
          </span>
          <span className="hidden text-xs text-faint sm:inline">
            {targeted
              ? `${total > 1 ? `${total} parti · ` : ''}seleziona un brano per un intervento IA puntuale`
              : `${total > 1 ? `${total} parti · ` : ''}sola lettura: il Typst è la fonte del documento`}
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
              {targeted
                ? 'Il testo selezionato viene sostituito solo dopo i controlli di sicurezza e una compilazione Typst riuscita.'
                : total > 1
                ? 'Riferimento recuperabile: le modifiche al documento si fanno nell’editor Typst.'
                : 'Riferimento recuperabile: non viene sincronizzato sopra le modifiche del Typst.'}
            </span>
          </div>

          {targeted && selection && (
            <div className="mb-3 flex flex-col gap-2 border-y border-border bg-surface-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-ink">
                  Selezione attiva · <span className="tabular-nums">{selection.count}</span> caratteri
                </div>
                <p className="mt-0.5 truncate text-xs text-faint">
                  {selectionBusy ? selectionDetail : 'Scegli il modello già configurato per il compito.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => runSelectionAction('proof')}
                  disabled={!!selectionBusy}
                  title={`Rivedi soltanto la selezione con ${proofModelLabel || 'il modello di rilettura selezionato'}`}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-50"
                >
                  {selectionBusy === 'proof' ? <IconSpinner width={13} height={13} /> : <IconWand width={13} height={13} />}
                  Rivedi selezione
                </button>
                <button
                  type="button"
                  onClick={() => runSelectionAction('translate')}
                  disabled={!!selectionBusy}
                  title={`Traduci soltanto la selezione con ${translationModelLabel || 'il modello di traduzione selezionato'}`}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary-soft px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
                >
                  {selectionBusy === 'translate' ? <IconSpinner width={13} height={13} /> : <IconText width={13} height={13} />}
                  Traduci selezione
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={!!selectionBusy}
                  className="min-h-9 px-2 py-1.5 text-xs font-medium text-muted underline decoration-border underline-offset-4 hover:text-ink disabled:opacity-50"
                >
                  Annulla
                </button>
              </div>
            </div>
          )}

          <textarea
            ref={textRef}
            readOnly
            value={chunks[i]}
            onSelect={captureSelection}
            aria-label={targeted ? 'Testo di lavoro selezionabile' : 'Testo OCR'}
            className="h-64 w-full resize-none overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed text-muted selection:bg-lime selection:text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          {targeted && !selection && !notice && (
            <p className="mt-2 text-xs text-faint">
              Evidenzia una frase o uno o più paragrafi nel riquadro: compariranno le azioni “Rivedi” e “Traduci”.
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="mt-2 rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-xs text-ink"
            >
              {notice}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
