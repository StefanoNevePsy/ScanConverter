import { useRef, useState } from 'react';
import { IconSpell, IconSpinner, IconX, IconWand, IconRefresh, IconCheck, IconSearch, IconBookPlus, IconChevronDown, IconChevronUp, IconDownload, IconUpload } from './Icons.jsx';
import { exportSpellIgnore, importSpellIgnore, loadSpellIgnore } from '../lib/storage.js';
import { saveTextFile } from '../lib/download.js';

/*
  Esito del controllo ortografico locale (dizionari it+en).

  La correzione una parola alla volta si fa nell'editor, con la barra di
  revisione: qui restano le decisioni di INSIEME, quelle per cui serve vedere
  tutte le parole insieme — escludere in blocco i nomi propri, riempire il
  dizionario personale, mandare all'AI solo quelle scelte. Perciò l'elenco
  completo c'è sempre, ma parte chiuso: da aperto occupava lo schermo e
  costringeva a scorrere su e giù per ogni singola parola.

  Ogni parola è un chip: un tocco la include/esclude dall'invio all'AI (es.
  «Bateson» è un nome, inutile farlo valutare); la lente la cerca nell'editor;
  il libro la aggiunge al dizionario personale.
*/

export default function SpellPanel({
  report,
  busy,
  skip,
  onToggleSkip,
  expanded,
  onToggleExpanded,
  reviewing,
  onReview,
  onFixAll,
  onRecheck,
  onLocate,
  onClose,
  onIgnore,
  onFixSpacing,
  modelLabel,
}) {
  const suspects = report?.suspects || [];
  const skipped = skip || new Set();
  const fileRef = useRef(null);
  const [dictionaryNotice, setDictionaryNotice] = useState('');
  const [dictionarySize, setDictionarySize] = useState(() => loadSpellIgnore().length);

  const addToDictionary = (words) => {
    onIgnore(words);
    setDictionarySize(loadSpellIgnore().length);
  };

  const exportDictionary = async () => {
    try {
      await saveTextFile(exportSpellIgnore(), 'dizionario-scanconverter.txt');
      setDictionaryNotice(`Dizionario esportato: ${dictionarySize} parole.`);
    } catch (e) {
      setDictionaryNotice(e.message || 'Esportazione non riuscita.');
    }
  };

  const importDictionary = async (file) => {
    if (!file) return;
    try {
      const { added, total } = importSpellIgnore(await file.text());
      setDictionarySize(total);
      setDictionaryNotice(
        added
          ? `Importate ${added} parole nuove: il dizionario ne contiene ${total}. Ricontrolla per applicarle.`
          : `Nessuna parola nuova: erano già tutte nel dizionario (${total}).`,
      );
    } catch (e) {
      setDictionaryNotice(e.message || 'Importazione non riuscita.');
    }
  };

  if (!report) return null;

  const selected = suspects.filter((s) => !skipped.has(s.word)).map((s) => s.word);

  return (
    <section className="card overflow-hidden">
      {/* Su schermo stretto i comandi vanno a capo su una riga propria: con tre
          pulsanti accanto al titolo il riassunto si riduceva a una parola per
          riga. */}
      <header className="flex min-w-0 flex-col items-stretch justify-between gap-2 border-b border-border px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
          <IconSpell width={16} height={16} className="shrink-0 text-primary" />
          <h2 className="text-sm font-medium text-ink">Controllo ortografico</h2>
          <span className="min-w-0 text-xs text-faint">
            {report.error
              ? report.error
              : suspects.length
                ? `${selected.length}/${suspects.length} selezionate per l’AI · il libro aggiunge al dizionario`
                : 'nessun sospetto'}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {suspects.length > 0 && onReview && (
            <button
              type="button"
              onClick={onReview}
              title="Rivedi i sospetti uno alla volta nel testo, in ordine di documento"
              className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                reviewing
                  ? 'border border-warning/50 bg-warning/15 text-ink'
                  : 'bg-primary text-primary-ink hover:bg-primary-strong'
              }`}
            >
              <IconSearch width={13} height={13} />
              {reviewing ? 'Revisione aperta' : 'Rivedi nel testo'}
            </button>
          )}
          {suspects.length > 0 && (
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={!!expanded}
              title={expanded
                ? 'Nascondi l’elenco completo'
                : 'Mostra l’elenco completo per escludere parole in blocco e riempire il dizionario'}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink"
            >
              {expanded ? <IconChevronUp width={13} height={13} /> : <IconChevronDown width={13} height={13} />}
              {expanded ? 'Nascondi elenco' : `Elenco completo (${suspects.length})`}
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Chiudi controllo ortografico"
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink transition-colors"
          >
            <IconX width={14} height={14} />
          </button>
        </div>
      </header>

      {suspects.length > 0 ? (
        expanded && (
          <div className="flex flex-wrap gap-1.5 px-4 py-3">
            {suspects.map((s) => {
              const excluded = skipped.has(s.word);
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
                    onClick={() => onToggleSkip?.(s.word)}
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
                    onClick={() => addToDictionary([s.word])}
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
        )
      ) : (
        !report.error && (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
            <IconCheck width={15} height={15} className="text-success" />
            Nessuna parola sconosciuta ai dizionari italiano e inglese.
          </p>
        )
      )}

      {/* Il dizionario personale vale per TUTTI i documenti, anche quelli che
          arriveranno: esportarlo è il modo di portarselo su un altro computer
          e di non ricominciare da capo a segnare gli stessi nomi propri. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <span className="text-xs text-muted">
          Dizionario personale · <span className="tabular-nums text-ink">{dictionarySize}</span> parole
        </span>
        <button
          type="button"
          onClick={exportDictionary}
          disabled={!dictionarySize}
          title="Salva le parole del dizionario in un file di testo, una per riga"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          <IconDownload width={13} height={13} />
          Esporta
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Aggiungi al dizionario le parole di un file esportato (una per riga)"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink"
        >
          <IconUpload width={13} height={13} />
          Importa
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.json,text/plain,application/json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            importDictionary(file);
          }}
        />
        {dictionaryNotice && (
          <span role="status" className="min-w-0 text-xs text-ink">{dictionaryNotice}</span>
        )}
      </div>

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
          {skipped.size > 0 && (
            <button
              onClick={() => addToDictionary([...skipped])}
              disabled={busy}
              title="Le parole escluse non verranno più segnalate (dizionario personale, salvato sul dispositivo)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              Non segnalare più ({skipped.size})
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
