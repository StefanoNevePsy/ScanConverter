import { useEffect, useMemo, useState } from 'react';
import { IconAlert, IconCheck, IconGlobe, IconRefresh, IconTrash } from './Icons.jsx';
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
  onRecheckLanguage,
  repairReport,
  duplicateAudit,
  onRecheckDuplicates,
  onRemoveDuplicates,
  duplicateBusy,
  duplicateDetail,
  busy,
  detail,
  repairBusy,
  repairDetail,
  modelLabel,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [selectedDuplicates, setSelectedDuplicates] = useState(() => new Set());
  const [pageSpec, setPageSpec] = useState('');
  const recommendedIds = useMemo(
    () => audit?.items?.filter((item) => item.recommended).map((item) => item.id) || [],
    [audit],
  );
  const recommendedKey = recommendedIds.join('|');
  const duplicateIds = useMemo(
    () => duplicateAudit?.items?.filter((item) => item.recommended).map((item) => item.id) || [],
    [duplicateAudit],
  );
  const duplicateKey = duplicateIds.join('|');

  useEffect(() => {
    setSelected(new Set(recommendedIds));
  }, [recommendedKey]); // Gli id sono la forma stabile della selezione consigliata.

  useEffect(() => {
    setSelectedDuplicates(new Set(duplicateIds));
  }, [duplicateKey]);

  const toggle = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleDuplicate = (id) => {
    setSelectedDuplicates((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const working = busy || repairBusy || duplicateBusy;
  const auditCount = audit?.items?.length || 0;
  const duplicateCount = duplicateAudit?.items?.length || 0;

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-surface-2"
      >
        <IconGlobe width={16} height={16} className="shrink-0 text-faint" />
        <span className="flex-1">Traduzione</span>
        <span className="text-xs font-normal text-faint">
          {working
            ? repairDetail || detail || 'in corso…'
            : auditCount
              ? `${auditCount} da verificare`
              : duplicateCount
                ? `${duplicateCount} duplicati`
                : languageLabel(targetLang)}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          {!audit && (
            <p className="text-xs leading-relaxed text-faint">
              Crea un <strong className="text-ink">secondo documento</strong> tradotto, partendo
              dal testo OCR. L’originale resta nell’elenco, invariato. Il testo viene inviato al
              modello a frasi intere, con qualche frase di contesto non sostituibile prima e dopo
              ogni passaggio; eventuali echi esatti del contesto vengono scartati localmente.
            </p>
          )}

          {!audit && <div className="grid gap-2 sm:grid-cols-2">
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
          </div>}

          {!audit && <button
            type="button"
            className="button-primary w-full"
            onClick={onTranslate}
            disabled={working || disabled || sourceLang === targetLang}
          >
            {busy
              ? `Traduzione… ${detail}`.trimEnd()
              : `Crea la versione in ${languageLabel(targetLang)}`}
          </button>}
          {!audit && sourceLang === targetLang && (
            <p className="text-xs text-faint">
              Lingua di partenza e di arrivo coincidono: scegline due diverse.
            </p>
          )}

          {audit && (
            <div className="mt-1 border-t border-border pt-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
                    Analisi locale, senza chiamare alcun modello: aggiorna l’elenco dei passaggi
                    probabilmente rimasti in una lingua diversa da quella di destinazione.
                    Bibliografie e indici sono mostrati, ma non preselezionati. Durante la
                    ritraduzione, riferimenti, numeri e markup vengono protetti e ripristinati
                    localmente.
                  </p>
                </div>
                <button
                  type="button"
                  className="button-primary shrink-0"
                  onClick={onRecheckLanguage}
                  disabled={working || disabled || !onRecheckLanguage}
                >
                  <IconRefresh width={15} height={15} />
                  Ricontrolla lingua
                </button>
              </div>

              {auditCount > 0 && (
                <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3 text-xs">
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
                <div className="mt-3">
                  {modelLabel && (
                    <p className="mb-1 truncate text-[10px] font-semibold text-muted" title={modelLabel}>
                      Ritraduzione con {modelLabel}
                    </p>
                  )}
                  <button
                    type="button"
                    className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-50"
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
                </div>
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
                  {repairDetail || 'Ritraduzione in corso…'} I passaggi sicuri saranno salvati insieme dopo la verifica Typst.
                </p>
              )}

              {repairReport && !repairBusy && (
                <div className="mt-3 border-y border-border bg-surface-2 px-3 py-2.5 text-xs text-ink" aria-live="polite">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
                    <span>{repairReport.applied} applicati</span>
                    <span className={repairReport.skipped ? 'text-warning' : 'text-muted'}>
                      {repairReport.skipped} lasciati invariati
                    </span>
                  </div>
                  {repairReport.items?.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer font-semibold text-muted hover:text-ink">
                        Perché alcuni passaggi non sono stati applicati
                      </summary>
                      <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
                        {repairReport.items.map((item) => (
                          <li key={item.id} className="border-t border-border/70 pt-2 first:border-t-0 first:pt-0">
                            <span className="font-semibold text-warning">Pagina {item.page ?? '—'}:</span>{' '}
                            {item.reason}
                            <span className="mt-0.5 block overflow-hidden text-ellipsis text-faint [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1]">
                              {item.sample}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              <DuplicateAuditSection
                audit={duplicateAudit}
                count={duplicateCount}
                selected={selectedDuplicates}
                recommendedIds={duplicateIds}
                onToggle={toggleDuplicate}
                onSelect={setSelectedDuplicates}
                onRecheck={onRecheckDuplicates}
                onRemove={onRemoveDuplicates}
                busy={working}
                repairBusy={duplicateBusy}
                detail={duplicateDetail}
                disabled={disabled}
              />
            </div>
          )}
          {!audit && duplicateAudit && (
            <DuplicateAuditSection
              audit={duplicateAudit}
              count={duplicateCount}
              selected={selectedDuplicates}
              recommendedIds={duplicateIds}
              onToggle={toggleDuplicate}
              onSelect={setSelectedDuplicates}
              onRecheck={onRecheckDuplicates}
              onRemove={onRemoveDuplicates}
              busy={working}
              repairBusy={duplicateBusy}
              detail={duplicateDetail}
              disabled={disabled}
              sourceStage
            />
          )}
        </div>
      )}
    </section>
  );
}

function DuplicateAuditSection({
  audit,
  count,
  selected,
  recommendedIds,
  onToggle,
  onSelect,
  onRecheck,
  onRemove,
  busy,
  repairBusy,
  detail,
  disabled,
  sourceStage = false,
}) {
  if (!audit) return null;
  const duplicateType = {
    paragraph: 'paragrafo intero',
    sentence: 'frase',
    fragment: 'parte di paragrafo',
  };
  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            Duplicati
            {count > 0 && (
              <span className="rounded-full border border-warning/50 px-2 py-0.5 text-[10px] font-bold text-warning">
                {count}
              </span>
            )}
          </div>
          <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-faint">
            {sourceStage
              ? 'Controllo già sul testo OCR: intercetta code di pagina ripetute prima che entrino nella traduzione.'
              : 'Controllo locale di paragrafi, frasi e frammenti esatti ripetuti consecutivamente; gli avvisi si riallineano anche alle rimozioni manuali nel Typst.'}{' '}
            Non usa il modello e non elimina somiglianze semantiche.
          </p>
        </div>
        <button
          type="button"
          className="button-secondary shrink-0"
          onClick={onRecheck}
          disabled={busy || disabled || !onRecheck}
        >
          <IconRefresh width={15} height={15} />
          Controlla duplicati
        </button>
      </div>

      {count > 0 ? (
        <>
          <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3 text-xs">
            <button
              type="button"
              className="button-quiet min-h-8 px-1.5 py-1"
              onClick={() => onSelect(new Set(recommendedIds))}
              disabled={busy}
            >
              Seleziona tutti
            </button>
            <button
              type="button"
              className="button-quiet min-h-8 px-1.5 py-1"
              onClick={() => onSelect(new Set())}
              disabled={busy}
            >
              Nessuno
            </button>
          </div>
          <div className="mt-3 max-h-64 overflow-y-auto border-y border-border" role="list">
            {audit.items.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-start gap-3 border-b border-border/60 px-1 py-2.5 last:border-b-0 hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => onToggle(item.id)}
                  disabled={busy}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 text-[10px] font-bold uppercase tracking-wide text-faint">
                    <span>Pagina {item.page ?? '—'}</span>
                    <span>{duplicateType[item.type] || 'ripetizione'}</span>
                    <span>corrispondenza esatta</span>
                  </span>
                  <span className="mt-1 block overflow-hidden text-ellipsis text-xs leading-relaxed text-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                    {item.sample}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="button-primary mt-3 w-full"
            onClick={() => onRemove({ ids: [...selected] })}
            disabled={busy || disabled || selected.size === 0 || !onRemove}
          >
            {repairBusy ? (
              <span className="size-4 animate-spin rounded-full border border-current border-r-transparent" />
            ) : (
              <IconTrash width={15} height={15} />
            )}
            {repairBusy ? detail || 'Verifica duplicati…' : `Rimuovi ${selected.size} duplicati selezionati`}
          </button>
        </>
      ) : (
        <div className="mt-3 flex items-start gap-2 bg-lime-soft px-3 py-2.5 text-xs text-ink">
          <IconCheck width={15} height={15} className="mt-0.5 shrink-0" />
          Nessuna ripetizione esatta consecutiva rilevata.
        </div>
      )}
    </div>
  );
}
