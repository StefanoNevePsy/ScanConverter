import { useEffect, useMemo, useState } from 'react';
import { IconAlert, IconCheck, IconGlobe, IconRefresh } from './Icons.jsx';
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
  audit,
  onRetranslate,
  busy,
  detail,
  repairBusy,
  repairDetail,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [pageSpec, setPageSpec] = useState('');
  const recommendedIds = useMemo(
    () => audit?.items?.filter((item) => item.recommended).map((item) => item.id) || [],
    [audit],
  );
  const recommendedKey = recommendedIds.join('|');

  useEffect(() => {
    setSelected(new Set(recommendedIds));
  }, [recommendedKey]); // Gli id sono la forma stabile della selezione consigliata.

  const toggle = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const working = busy || repairBusy;
  const auditCount = audit?.items?.length || 0;

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
          {working
            ? repairDetail || detail || 'in corso…'
            : auditCount
              ? `${auditCount} da verificare`
              : languageLabel(targetLang)}
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
                disabled={working}
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
                disabled={working}
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
            disabled={working || disabled || sourceLang === targetLang}
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

          {audit && (
            <div className="mt-1 border-t border-border pt-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                    Controllo lingua
                    {auditCount > 0 && (
                      <span className="rounded-full border border-warning/50 px-2 py-0.5 text-[10px] font-bold text-warning">
                        {auditCount}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-faint">
                    Analisi locale: individua paragrafi probabilmente rimasti in un’altra lingua.
                    Bibliografie e indici sono mostrati, ma non preselezionati.
                  </p>
                </div>
                {auditCount > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      className="button-quiet min-h-8 px-1.5 py-1"
                      onClick={() => setSelected(new Set(recommendedIds))}
                      disabled={working}
                    >
                      Consigliati
                    </button>
                    <button
                      type="button"
                      className="button-quiet min-h-8 px-1.5 py-1"
                      onClick={() => setSelected(new Set())}
                      disabled={working}
                    >
                      Nessuno
                    </button>
                  </div>
                )}
              </div>

              {auditCount ? (
                <div className="mt-3 max-h-72 overflow-y-auto border-y border-border" role="list">
                  {audit.items.map((item) => (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-start gap-3 border-b border-border/60 px-1 py-2.5 last:border-b-0 hover:bg-surface-2"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        disabled={working}
                        className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold uppercase tracking-wide text-faint">
                          <span>Pagina {item.page ?? '—'}</span>
                          <span>{languageLabel(item.detectedLang)}</span>
                          <span>{item.confidence >= 0.85 ? 'confidenza alta' : 'confidenza media'}</span>
                          {!item.recommended && (
                            <span className="inline-flex items-center gap-1 text-warning">
                              <IconAlert width={11} height={11} /> riferimento
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block overflow-hidden text-ellipsis text-xs leading-relaxed text-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                          {item.sample}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-lime-soft px-3 py-2.5 text-xs text-ink">
                  <IconCheck width={15} height={15} className="mt-0.5 shrink-0" />
                  Nessun passaggio chiaramente fuori dalla lingua di destinazione.
                </div>
              )}

              {auditCount > 0 && (
                <button
                  type="button"
                  className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-50"
                  onClick={() => onRetranslate({ ids: [...selected] })}
                  disabled={working || disabled || selected.size === 0}
                >
                  {repairBusy ? (
                    <span className="size-4 animate-spin rounded-full border border-current border-r-transparent" />
                  ) : (
                    <IconRefresh width={15} height={15} />
                  )}
                  {repairBusy ? repairDetail || 'Ritraduzione…' : `Ritraduci ${selected.size} passaggi selezionati`}
                </button>
              )}

              <div className="mt-4 border-t border-border pt-3">
                <label htmlFor="translate-pages" className="text-xs font-semibold text-ink">
                  Oppure indica pagine precise
                </label>
                <p id="translate-pages-hint" className="mt-0.5 text-xs text-faint">
                  Formato: 251, 285-286, 306. Verranno ritradotti solo i passaggi rilevati fuori lingua in quelle pagine.
                </p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    id="translate-pages"
                    aria-describedby="translate-pages-hint"
                    value={pageSpec}
                    onChange={(event) => setPageSpec(event.target.value)}
                    placeholder="251, 285-286, 306"
                    disabled={working}
                    className="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-base text-ink placeholder:text-faint focus:border-primary focus:outline-none sm:text-sm"
                  />
                  <button
                    type="button"
                    className="button-secondary shrink-0"
                    onClick={() => onRetranslate({ pages: pageSpec })}
                    disabled={working || disabled || !pageSpec.trim()}
                  >
                    Ritraduci pagine
                  </button>
                </div>
              </div>

              {repairBusy && (
                <p className="mt-2 text-xs text-muted" aria-live="polite">
                  {repairDetail || 'Ritraduzione in corso…'} Nessuna modifica sarà salvata prima della verifica Typst.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
