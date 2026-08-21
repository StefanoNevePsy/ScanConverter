import { useState } from 'react';
import { IconGlobe } from './Icons.jsx';
import { LANGUAGES, languageLabel } from '../lib/translate.js';

/*
  Traduzione del documento come biforcazione, non come trasformazione.

  Il pannello dice esplicitamente che l'originale non viene toccato, perché è
  la domanda che chiunque si pone prima di premere: se il testo sparisse
  sostituito dalla traduzione, ore di correzioni OCR se ne andrebbero con
  esso. Qui nasce un secondo documento, e l'elenco delle sessioni li mostra
  entrambi.
*/

export default function TranslatePanel({
  targetLang,
  sourceLang,
  onLanguageChange,
  onTranslate,
  busy,
  detail,
  disabled,
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-surface-2"
      >
        <IconGlobe width={16} height={16} className="shrink-0 text-faint" />
        <span className="flex-1">Traduci</span>
        <span className="text-xs font-normal text-faint">
          {busy ? detail || 'in corso…' : languageLabel(targetLang)}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          <p className="text-xs leading-relaxed text-faint">
            Crea un <strong className="text-ink">secondo documento</strong> tradotto, partendo
            dal testo OCR. L’originale resta nell’elenco, invariato. Il testo viene inviato al
            modello a frasi intere, con qualche frase di contesto prima e dopo ogni passaggio.
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-faint">
              Lingua del documento
              <select
                className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink transition-colors focus:border-primary focus:outline-none"
                value={sourceLang}
                onChange={(e) => onLanguageChange({ sourceLang: e.target.value })}
                disabled={busy}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-faint">
              Tradurre in
              <select
                className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink transition-colors focus:border-primary focus:outline-none"
                value={targetLang}
                onChange={(e) => onLanguageChange({ targetLang: e.target.value })}
                disabled={busy}
              >
                {LANGUAGES.filter((l) => l.code !== 'auto').map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </label>
          </div>

          <button
            type="button"
            className="button-primary w-full"
            onClick={onTranslate}
            disabled={busy || disabled || sourceLang === targetLang}
          >
            {busy
              ? `Traduzione… ${detail}`.trimEnd()
              : `Crea la versione in ${languageLabel(targetLang)}`}
          </button>
          {sourceLang === targetLang && (
            <p className="text-xs text-faint">
              Lingua di partenza e di arrivo coincidono: scegline due diverse.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
