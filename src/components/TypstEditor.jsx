import { useEffect, useMemo, useRef, useState } from 'react';
import { IconRefresh, IconSpinner, IconAlert, IconSearch, IconX, IconWand, IconSpell, IconText, IconArrowLeft } from './Icons.jsx';
import CopyButton from './CopyButton.jsx';
import { findEditorMatches, scrollTextareaOffsetIntoView } from '../lib/editorScroll.js';

/**
 * Editor a colonna sinistra: codice Typst generato e modificabile dall'utente,
 * con numeri di riga, ricerca/sostituzione (Ctrl+F) per modifiche puntiformi
 * e correzione AI degli errori di compilazione.
 */
export default function TypstEditor({
  value,
  onChange,
  onCompile,
  onAutofix,
  onAiFix,
  aiFixing,
  onSpellcheck,
  spellBusy,
  onProofread,
  proofreadBusy,
  proofreadDetail,
  proofModelLabel,
  onReviseSelection,
  selectionBusy,
  selectionDetail,
  translationModelLabel,
  reviewReturnLabel,
  onReturnToReview,
  searchRequest,
  onSearchMatch,
  compiling,
  error,
  disabled,
}) {
  const taRef = useRef(null);
  const gutterRef = useRef(null);
  const searchRef = useRef(null);
  const pendingJumpRef = useRef(false);
  const pendingJumpOccurrenceRef = useRef(0);
  const activeMatchRef = useRef(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replaceStr, setReplaceStr] = useState('');
  const [current, setCurrent] = useState(0);
  const [wholeWord, setWholeWord] = useState(false);
  const [editorSelection, setEditorSelection] = useState(null);
  const [selectionNotice, setSelectionNotice] = useState('');

  const lineCount = useMemo(
    () => Math.max(value.split('\n').length, 1),
    [value],
  );

  // Posizioni (indici) delle occorrenze, case-insensitive.
  const matches = useMemo(() => {
    return findEditorMatches(value, query, wholeWord);
  }, [value, query, wholeWord]);

  useEffect(() => {
    if (current >= matches.length) setCurrent(0);
  }, [matches, current]);

  useEffect(() => {
    setEditorSelection(null);
  }, [value]);

  // Ricerca pilotata dall'esterno (es. clic su una parola sospetta nel
  // controllo ortografico): apre la barra, imposta la query e salta al primo
  // risultato appena i match sono calcolati.
  useEffect(() => {
    if (!searchRequest?.query) return;
    setQuery(searchRequest.query);
    setWholeWord(searchRequest.wholeWord === true);
    setSearchOpen(true);
    pendingJumpRef.current = true;
    pendingJumpOccurrenceRef.current = Math.max(0, Number(searchRequest.occurrence) || 0);
  }, [searchRequest]);

  const syncScroll = () => {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  };

  /** Seleziona e porta a video l'occorrenza k (con wrap-around). */
  const goto = (k) => {
    if (!matches.length) return;
    const n = ((k % matches.length) + matches.length) % matches.length;
    activeMatchRef.current = true;
    setCurrent(n);
    const ta = taRef.current;
    if (!ta) return;
    const pos = matches[n];
    // Applica la selezione dopo il render causato da setCurrent: sui WebView
    // React può altrimenti ripristinare il cursore e rendere invisibile il
    // risultato appena trovato.
    requestAnimationFrame(() => {
      const editor = taRef.current;
      if (!editor) return;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(pos, pos + query.length, 'forward');
      scrollTextareaOffsetIntoView(editor, value, pos);
      syncScroll();
    });
    onSearchMatch?.({
      query,
      start: pos,
      end: pos + query.length,
      occurrence: n,
      id: `${Date.now()}-${n}`,
    });
  };

  // Salto al primo risultato di una ricerca esterna (dopo il ricalcolo).
  useEffect(() => {
    if (pendingJumpRef.current && matches.length) {
      pendingJumpRef.current = false;
      goto(pendingJumpOccurrenceRef.current);
    } else if (pendingJumpRef.current && query && !matches.length) {
      pendingJumpRef.current = false;
      onSearchMatch?.(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const replaceCurrent = () => {
    if (!matches.length) return;
    const pos = matches[current];
    pendingJumpRef.current = true;
    pendingJumpOccurrenceRef.current = current;
    onChange(value.slice(0, pos) + replaceStr + value.slice(pos + query.length));
  };

  const replaceAll = () => {
    if (!query || !matches.length) return;
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    pendingJumpRef.current = true;
    pendingJumpOccurrenceRef.current = 0;
    onChange(value.replace(re, () => replaceStr));
  };

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setWholeWord(false);
    activeMatchRef.current = false;
    onSearchMatch?.(null);
    taRef.current?.focus();
  };

  const onEditorKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape' && editorSelection) {
      setEditorSelection(null);
      setSelectionNotice('');
    }
  };

  const captureEditorSelection = (event) => {
    if (!onReviseSelection) return;
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    const selected = value.slice(start, end);
    setEditorSelection(end > start && selected.trim()
      ? { start, end, count: end - start, sample: selected.replace(/\s+/gu, ' ').trim() }
      : null);
    setSelectionNotice('');
  };

  const runEditorSelectionAction = async (mode) => {
    if (!editorSelection || selectionBusy || !onReviseSelection) return;
    const result = await onReviseSelection({
      start: editorSelection.start,
      end: editorSelection.end,
      mode,
      source: 'typst',
    });
    setSelectionNotice(result?.message || 'Operazione completata.');
  };

  const onSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goto(activeMatchRef.current ? current + (e.shiftKey ? -1 : 1) : e.shiftKey ? -1 : 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  };

  return (
    <section id="typst-editor-panel" className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-w-0 flex-col items-stretch justify-between gap-2 border-b border-border px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">Codice Typst</h2>
          {value.trim() && (
            <span className="rounded-full border border-lime/60 bg-lime-soft px-2 py-0.5 text-[10px] font-semibold text-ink">
              Fonte del documento
            </span>
          )}
          {onReviseSelection && (
            <span className="hidden text-xs text-faint xl:inline">seleziona il testo per correggerlo o tradurlo con l’IA</span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {onSpellcheck && (
            <button
              onClick={onSpellcheck}
              disabled={!value.trim() || spellBusy}
              title="Controllo ortografico (dizionari italiano + inglese)"
              aria-label="Controllo ortografico"
              className="rounded-lg bg-surface-2 p-1.5 text-ink transition-colors hover:bg-surface-3 disabled:opacity-50"
            >
              {spellBusy ? <IconSpinner width={14} height={14} /> : <IconSpell width={14} height={14} />}
            </button>
          )}
          {onProofread && (
            <button
              onClick={onProofread}
              disabled={!value.trim() || proofreadBusy}
              title={`Ricontrolla refusi, parole spezzate, accenti e virgolette con ${proofModelLabel || 'il modello di rilettura selezionato'}`}
              aria-label={`Ricontrolla il testo con ${proofModelLabel || 'il modello selezionato'}`}
              className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1.5 text-ink transition-colors hover:bg-surface-3 disabled:opacity-50"
            >
              {proofreadBusy ? <IconSpinner width={14} height={14} /> : <IconText width={14} height={14} />}
              <span className="text-xs font-semibold">
                {proofreadBusy ? proofreadDetail || 'Ricontrollo…' : 'Ricontrolla testo'}
              </span>
            </button>
          )}
          <button
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            disabled={!value.trim()}
            title="Cerca nel codice (Ctrl+F)"
            aria-label="Cerca nel codice"
            aria-pressed={searchOpen}
            className={`rounded-lg p-1.5 transition-colors disabled:opacity-50 ${
              searchOpen ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink hover:bg-surface-3'
            }`}
          >
            <IconSearch width={14} height={14} />
          </button>
          <CopyButton
            getText={() => value}
            disabled={!value.trim()}
            className="bg-surface-2 text-ink hover:bg-surface-3"
          />
          <button
            onClick={() => onCompile()}
            disabled={disabled || compiling || !value.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {compiling ? (
              <IconSpinner width={14} height={14} />
            ) : (
              <IconRefresh width={14} height={14} />
            )}
            {compiling ? 'Compilo…' : 'Genera PDF'}
          </button>
        </div>
      </header>

      {reviewReturnLabel && onReturnToReview && (
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border bg-lime-soft px-3 py-2">
          <p className="min-w-0 truncate text-xs text-muted">
            Stai verificando un punto aperto da <span className="font-semibold text-ink">{reviewReturnLabel}</span>.
          </p>
          <button
            type="button"
            onClick={onReturnToReview}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            <IconArrowLeft width={13} height={13} />
            Torna alla lista
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                // Lascia il focus nel campo mentre si digita. Il salto parte
                // con Invio (o con le frecce), come nei normali strumenti di
                // ricerca; se c'era un risultato attivo ripristina il PDF.
                if (activeMatchRef.current) onSearchMatch?.(null);
                activeMatchRef.current = false;
                setCurrent(0);
                setWholeWord(false);
                setQuery(e.target.value);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Cerca…"
              className="w-full min-w-24 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-faint focus:border-primary focus:outline-none"
            />
            <span className="shrink-0 text-xs tabular-nums text-faint">
              {matches.length ? `${current + 1}/${matches.length}` : query ? '0' : ''}
            </span>
            <button
              onClick={() => goto(activeMatchRef.current ? current - 1 : -1)}
              disabled={!matches.length}
              aria-label="Occorrenza precedente"
              className="rounded-md bg-surface-2 px-2 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-40"
            >
              ↑
            </button>
            <button
              onClick={() => goto(activeMatchRef.current ? current + 1 : 0)}
              disabled={!matches.length}
              aria-label="Occorrenza successiva"
              className="rounded-md bg-surface-2 px-2 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-40"
            >
              ↓
            </button>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              value={replaceStr}
              onChange={(e) => setReplaceStr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  replaceCurrent();
                }
              }}
              placeholder="Sostituisci con…"
              className="w-full min-w-24 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-faint focus:border-primary focus:outline-none"
            />
            <button
              onClick={replaceCurrent}
              disabled={!matches.length}
              className="shrink-0 rounded-md bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-40"
            >
              Sostituisci
            </button>
            <button
              onClick={replaceAll}
              disabled={!matches.length}
              className="shrink-0 rounded-md bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-40"
            >
              Tutte
            </button>
            <button
              onClick={closeSearch}
              aria-label="Chiudi ricerca"
              className="shrink-0 rounded-md p-1 text-muted hover:text-ink"
            >
              <IconX width={14} height={14} />
            </button>
          </div>
        </div>
      )}

      {onReviseSelection && editorSelection && (
        <div className="flex flex-col gap-2 border-b border-border bg-primary-soft px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-ink">
              <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              Selezione Typst · <span className="tabular-nums">{editorSelection.count}</span> caratteri
            </div>
            <p className="mt-0.5 truncate text-xs text-muted">
              {selectionBusy
                ? selectionDetail || 'Intervento IA in corso…'
                : editorSelection.sample}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runEditorSelectionAction('proof')}
              disabled={!!selectionBusy || disabled}
              title={`Correggi soltanto la selezione con ${proofModelLabel || 'il modello di rilettura selezionato'}`}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-50"
            >
              {selectionBusy === 'proof' ? <IconSpinner width={13} height={13} /> : <IconWand width={13} height={13} />}
              Correggi selezione
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runEditorSelectionAction('translate')}
              disabled={!!selectionBusy || disabled}
              title={`Traduci soltanto la selezione con ${translationModelLabel || 'il modello di traduzione selezionato'}`}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-surface px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              {selectionBusy === 'translate' ? <IconSpinner width={13} height={13} /> : <IconText width={13} height={13} />}
              Traduci selezione
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setEditorSelection(null);
                setSelectionNotice('');
                taRef.current?.focus();
              }}
              disabled={!!selectionBusy}
              aria-label="Chiudi azioni sulla selezione"
              className="grid min-h-9 min-w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            >
              <IconX width={14} height={14} />
            </button>
          </div>
        </div>
      )}

      {selectionNotice && !selectionBusy && (
        <p
          role="status"
          className="border-b border-border bg-surface-2 px-3 py-2 text-xs text-ink"
        >
          {selectionNotice}
        </p>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="select-none overflow-hidden border-r border-border bg-surface/50 py-3 pr-2 pl-3 text-right font-mono text-[13px] leading-6 text-faint"
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className="tabular-nums">
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onSelect={captureEditorSelection}
          onScroll={syncScroll}
          onKeyDown={onEditorKeyDown}
          spellCheck={false}
          disabled={disabled}
          placeholder={disabled ? '' : 'Il codice Typst apparirà qui dopo l’elaborazione…'}
          className="typst-editor min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[13px] leading-6 text-ink caret-primary placeholder:text-faint focus:outline-none"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-danger/30 bg-danger-soft px-4 py-2.5 text-sm text-danger"
        >
          <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="font-medium">Errore di compilazione.</span>{' '}
            <span className="font-mono text-[12px] leading-snug opacity-90">{error}</span>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5 self-center sm:flex-row">
            {onAutofix && (
              <button
                onClick={onAutofix}
                disabled={compiling || aiFixing}
                title="Correzione locale iterativa guidata dal compilatore (senza AI)"
                className="rounded-lg bg-danger/20 px-2.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-danger/30 disabled:opacity-50"
              >
                Correggi (locale)
              </button>
            )}
            {onAiFix && (
              <button
                onClick={onAiFix}
                disabled={compiling || aiFixing}
                title="Invia errore e codice al modello configurato per una correzione puntiforme"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-50"
              >
                {aiFixing ? <IconSpinner width={13} height={13} /> : <IconWand width={13} height={13} />}
                {aiFixing ? 'Correggo…' : 'Correggi con AI'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
