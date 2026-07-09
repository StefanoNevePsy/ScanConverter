import { useState } from 'react';
import { IconText } from './Icons.jsx';
import CopyButton from './CopyButton.jsx';
import { SYSTEM_PROMPT, buildGuidance } from '../lib/gemini.js';

/*
  Mostra il testo grezzo estratto dall'OCR (Markdown con gerarchia e
  segnaposti immagine). Permette di copiarlo per usarlo con un LLM esterno
  (ChatGPT, Gemma in locale sul tablet, ecc.) e poi incollare il Typst
  risultante nell'editor.
*/

export default function OcrTextPanel({ text, styleHint }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  // Prompt completo pronto da incollare in un LLM esterno: include le
  // istruzioni tecniche (font, gerarchia, tabelle, vincoli Typst) e le scelte
  // di impaginazione correnti — così il codice generato altrove compila e
  // rispetta la formattazione scelta.
  const fullPrompt =
    SYSTEM_PROMPT +
    '\n\n' +
    buildGuidance(styleHint) +
    '\n\n--- TESTO ESTRATTO DALL’OCR ---\n\n' +
    text +
    '\n\n--- FINE ---\nRestituisci SOLO il codice Typst, senza spiegazioni.';

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
            copialo per generare il Typst con ChatGPT / Gemma
          </span>
        </span>
        <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <CopyButton
              getText={() => text}
              label="Copia testo OCR"
              className="border border-border bg-surface-2 text-ink hover:bg-surface-3"
            />
            <CopyButton
              getText={() => fullPrompt}
              label="Copia prompt + testo"
              className="bg-primary text-primary-ink hover:bg-primary-strong"
            />
            <span className="text-xs text-faint">
              Poi incolla il Typst generato nell’editor e premi “Genera PDF”.
            </span>
          </div>
          <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed text-muted whitespace-pre-wrap">
            {text}
          </pre>
        </div>
      )}
    </section>
  );
}
