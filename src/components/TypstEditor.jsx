import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  IconRefresh, IconSpinner, IconAlert, IconSearch, IconX, IconWand, IconSpell, IconText,
  IconArrowLeft, IconBookPlus, IconCheck, IconChevronUp, IconChevronDown, IconSkip,
  IconListBullet, IconListOrdered, IconIndent, IconOutdent, IconEye, IconEyeOff,
} from './Icons.jsx';
import CopyButton from './CopyButton.jsx';
import {
  findEditorMatches,
  scrollTextareaOffsetIntoView,
  measureTextareaOffsets,
} from '../lib/editorScroll.js';
import {
  buildReviewStops,
  stopIndexAtOrAfter,
  stepStop,
  stopLines,
} from '../lib/reviewQueue.js';
import {
  toList,
  clearList,
  indentIntoItem,
  endList,
  describeSelection,
} from '../lib/listEdit.js';

/** Selezione da mostrare nella barra delle azioni, o niente se è vuota. */
function describeRange(value, start, end) {
  const selected = String(value || '').slice(start, end);
  if (end <= start || !selected.trim()) return null;
  return { start, end, count: end - start, sample: selected.replace(/\s+/gu, ' ').trim() };
}

/**
 * Editor a colonna sinistra: codice Typst generato e modificabile dall'utente,
 * con numeri di riga, ricerca/sostituzione (Ctrl+F) per modifiche puntiformi,
 * correzione AI degli errori di compilazione, azioni di elenco sulla selezione
 * e revisione guidata dei sospetti ortografici, una fermata alla volta.
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
  enumMarker = '1.',
  review,
  reviewBusy,
  onReviewFix,
  onReviewDictionary,
  onReviewSkip,
  onReviewExit,
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
  const marksRef = useRef(null);
  const searchRef = useRef(null);
  const pendingJumpRef = useRef(false);
  const pendingJumpOccurrenceRef = useRef(0);
  const pendingStopRef = useRef(false);
  const pendingSelectionRef = useRef(null);
  const activeMatchRef = useRef(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replaceStr, setReplaceStr] = useState('');
  const [current, setCurrent] = useState(0);
  const [wholeWord, setWholeWord] = useState(false);
  const [editorSelection, setEditorSelection] = useState(null);
  const [selectionNotice, setSelectionNotice] = useState('');
  const [reviewOffset, setReviewOffset] = useState(0);
  const [marksOn, setMarksOn] = useState(true);
  const [markTops, setMarkTops] = useState([]);

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
    const editor = taRef.current;
    if (!editor) return;
    if (gutterRef.current) gutterRef.current.scrollTop = editor.scrollTop;
    // I segni nel margine scorrono con il testo senza passare da React: uno
    // stato aggiornato a ogni evento di scroll farebbe ridisegnare l'editor.
    if (marksRef.current) marksRef.current.style.transform = `translateY(${-editor.scrollTop}px)`;
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

  /* ── Revisione guidata ──────────────────────────────────────────────────
     Le parole sospette diventano fermate in ordine di documento. La posizione
     (`reviewOffset`), non l'indice, è il segnaposto: dopo una correzione il
     testo cambia lunghezza e le fermate cambiano numero, ma il punto in cui
     l'utente stava lavorando resta lo stesso. */
  const reviewOpen = !!review;
  // Le fermate si ricalcolano sul testo FERMO: ogni ricalcolo scorre l'intero
  // documento per ciascuna parola sospetta, e farlo a ogni tasto premuto
  // renderebbe l'editor inservibile proprio mentre si corregge.
  const [settledValue, setSettledValue] = useState(value);
  useEffect(() => {
    if (!reviewOpen) return undefined;
    // Una modifica che arriva da un'azione (correzione AI, proposta applicata)
    // non è digitazione: le fermate servono subito, non fra quattro decimi.
    if (pendingStopRef.current) {
      setSettledValue(value);
      return undefined;
    }
    const timer = setTimeout(() => setSettledValue(value), 400);
    return () => clearTimeout(timer);
  }, [value, reviewOpen]);

  const stops = useMemo(
    () => (reviewOpen ? buildReviewStops(settledValue, review.items || []) : []),
    [reviewOpen, review?.items, settledValue],
  );
  const stopIndex = stops.length ? Math.max(0, stopIndexAtOrAfter(stops, reviewOffset)) : -1;
  const stop = stopIndex >= 0 ? stops[stopIndex] : null;

  const showStop = (target) => {
    if (!target) return;
    setReviewOffset(target.start);
    requestAnimationFrame(() => {
      const editor = taRef.current;
      if (!editor) return;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(target.start, target.end, 'forward');
      scrollTextareaOffsetIntoView(editor, value, target.start);
      syncScroll();
    });
    onSearchMatch?.({
      query: target.word,
      start: target.start,
      end: target.end,
      occurrence: target.occurrence,
      id: `review-${target.start}-${Date.now()}`,
    });
  };

  const goToStop = (delta) => {
    if (!stops.length) return;
    showStop(stops[stepStop(stops, stopIndex, delta)]);
  };

  // Apertura di una nuova revisione: si riparte dalla prima fermata.
  useEffect(() => {
    if (!review?.token) return;
    setReviewOffset(0);
    pendingStopRef.current = true;
  }, [review?.token]);

  // Dopo un'azione che cambia il testo (correzione AI, proposta applicata) le
  // fermate si ricalcolano: si va a quella che ora occupa il posto corrente.
  useEffect(() => {
    if (!pendingStopRef.current) return;
    // Le fermate sono ancora quelle del testo di prima: saltare adesso
    // porterebbe a un offset che non esiste più.
    if (settledValue !== value) return;
    pendingStopRef.current = false;
    if (!stops.length) {
      onSearchMatch?.(null);
      return;
    }
    showStop(stops[Math.max(0, stopIndexAtOrAfter(stops, reviewOffset))]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops]);

  const runReviewAction = (action, word) => {
    if (!action || !word) return;
    pendingStopRef.current = true;
    action(word);
  };

  /** Applica la proposta deterministica del controllo ortografico. */
  const applySuggestion = () => {
    if (!stop?.suggestedFix) return;
    pendingStopRef.current = true;
    onChange(value.slice(0, stop.start) + stop.suggestedFix + value.slice(stop.end));
  };

  /* ── Segni nel margine ──────────────────────────────────────────────────
     Misurati sul testo reale invece che moltiplicando il numero di riga per
     l'altezza: una riga sorgente lunga ne occupa parecchie a schermo, e i
     puntini finirebbero via via più in alto del punto che indicano. */
  const marks = useMemo(() => (marksOn ? stopLines(stops) : []), [marksOn, stops]);

  useLayoutEffect(() => {
    const editor = taRef.current;
    if (!editor || !marks.length) {
      setMarkTops((previous) => (previous.length ? [] : previous));
      return undefined;
    }
    const measure = () => {
      setMarkTops(measureTextareaOffsets(editor, settledValue, marks.map((m) => m.start)));
      syncScroll();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, settledValue]);

  /* ── Azioni di elenco ───────────────────────────────────────────────────
     Lavorano sul Typst che l'utente ha davanti: «termina elenco» è togliere il
     rientro alle righe scelte, non un marcatore da reinterpretare. La
     selezione viene ripristinata dopo la modifica, così le azioni si possono
     concatenare (elenco → rientra) senza ricominciare da capo. */
  const applyListEdit = (transform) => {
    const editor = taRef.current;
    if (!editor || disabled) return;
    const result = transform(value, editor.selectionStart, editor.selectionEnd);
    if (!result || result.value === value) return;
    pendingSelectionRef.current = { start: result.start, end: result.end };
    setSelectionNotice('');
    onChange(result.value);
  };

  useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    pendingSelectionRef.current = null;
    // `onSelect` non scatta per una selezione impostata da noi: senza questo
    // la barra sparirebbe a ogni pulsante premuto e non si potrebbero
    // concatenare le azioni (elenco, poi rientro).
    setEditorSelection(describeRange(value, pending.start, pending.end));
    requestAnimationFrame(() => {
      const editor = taRef.current;
      if (!editor) return;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(pending.start, pending.end, 'forward');
      syncScroll();
    });
  }, [value]);

  const listState = useMemo(
    () => (editorSelection ? describeSelection(value, editorSelection.start, editorSelection.end) : null),
    [editorSelection, value],
  );

  const toggleList = (kind) => {
    const active = kind === 'bullet' ? listState?.bullet : listState?.ordered;
    applyListEdit((text, start, end) => (
      active ? clearList(text, start, end) : toList(text, start, end, kind, { marker: enumMarker })
    ));
  };

  const onEditorKeyDown = (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'f') {
      e.preventDefault();
      openSearch();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '8' || e.key === '*')) {
      e.preventDefault();
      toggleList('bullet');
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '7' || e.key === '/')) {
      e.preventDefault();
      toggleList('ordered');
    } else if ((e.ctrlKey || e.metaKey) && e.key === ']') {
      e.preventDefault();
      applyListEdit(indentIntoItem);
    } else if ((e.ctrlKey || e.metaKey) && e.key === '[') {
      e.preventDefault();
      applyListEdit(endList);
    } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight') && stops.length) {
      e.preventDefault();
      goToStop(1);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft') && stops.length) {
      e.preventDefault();
      goToStop(-1);
    } else if (e.key === 'Escape' && editorSelection) {
      setEditorSelection(null);
      setSelectionNotice('');
    } else if (e.key === 'Escape' && reviewOpen) {
      onReviewExit?.();
    }
  };

  const captureEditorSelection = (event) => {
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    // Durante la revisione la fermata corrente è già selezionata dall'app: la
    // barra della selezione ripeterebbe soltanto quello che dice la barra di
    // revisione, un piano di comandi in più senza niente in più da fare.
    const isCurrentStop = stop && start === stop.start && end === stop.end;
    setEditorSelection(isCurrentStop ? null : describeRange(value, start, end));
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

  const listButton = 'inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50';
  const listButtonActive = 'inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg border border-primary/50 bg-primary-soft px-2 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-surface-2 disabled:opacity-50';

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
            <span className="hidden text-xs text-faint xl:inline">seleziona il testo per correggerlo, tradurlo o metterlo in elenco</span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {reviewOpen && (
            <button
              onClick={() => setMarksOn((on) => !on)}
              title={marksOn
                ? 'Nascondi i segni degli errori nel margine'
                : 'Mostra i segni degli errori nel margine'}
              aria-label="Segni degli errori nel margine"
              aria-pressed={marksOn}
              className={`rounded-lg p-1.5 transition-colors ${
                marksOn ? 'bg-warning/15 text-ink' : 'bg-surface-2 text-muted hover:text-ink'
              }`}
            >
              {marksOn ? <IconEye width={14} height={14} /> : <IconEyeOff width={14} height={14} />}
            </button>
          )}
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

      {reviewOpen && (
        <div className="flex min-w-0 flex-col gap-2 border-b border-border bg-warning/10 px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between lg:gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-ink">
              <IconSpell width={14} height={14} className="shrink-0 text-warning" />
              {review.label || 'Revisione'}
              {stops.length > 0 && (
                <span className="tabular-nums text-muted">
                  {stopIndex + 1}/{stops.length}
                </span>
              )}
              {stop && (
                <span className="rounded-full border border-warning/50 bg-surface px-2 py-0.5 font-mono text-[11px] text-ink">
                  {stop.word}
                </span>
              )}
              <span className="hidden text-[10px] font-normal text-faint xl:inline">
                Alt+↓ e Alt+↑ per spostarsi
              </span>
            </div>
            {stop ? (
              <p className="mt-1 truncate font-mono text-[11px] leading-relaxed text-muted">
                {stop.before}
                <span className="rounded bg-warning/30 px-0.5 text-ink">{stop.word}</span>
                {stop.after}
              </p>
            ) : (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                <IconCheck width={13} height={13} className="text-success" />
                Nessun sospetto rimasto nel testo: la revisione è finita.
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {stops.length > 1 && (
              <div className="flex items-center overflow-hidden rounded-lg border border-border bg-surface">
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => goToStop(-1)}
                  aria-label="Sospetto precedente"
                  title="Sospetto precedente (Alt+↑)"
                  className="grid min-h-9 min-w-9 place-items-center text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <IconChevronUp width={14} height={14} />
                </button>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => goToStop(1)}
                  aria-label="Sospetto successivo"
                  title="Sospetto successivo (Alt+↓)"
                  className="grid min-h-9 min-w-9 place-items-center border-l border-border text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <IconChevronDown width={14} height={14} />
                </button>
              </div>
            )}
            {stop?.suggestedFix && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={applySuggestion}
                title={`Sostituisci con «${stop.suggestedFix}» — proposta locale, senza AI`}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-lime/60 bg-lime-soft px-2.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                <IconCheck width={13} height={13} />
                <span className="max-w-40 truncate font-mono">{stop.suggestedFix}</span>
              </button>
            )}
            {stop && onReviewSkip && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runReviewAction(onReviewSkip, stop.word)}
                title={`«${stop.word}» va bene: escludila dalla revisione di adesso`}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                <IconSkip width={13} height={13} />
                Va bene
              </button>
            )}
            {stop && onReviewDictionary && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runReviewAction(onReviewDictionary, stop.word)}
                title={`Aggiungi «${stop.word}» al dizionario personale: non verrà più segnalata`}
                aria-label={`Aggiungi «${stop.word}» al dizionario personale`}
                className="grid min-h-9 min-w-9 place-items-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-lime-soft hover:text-ink"
              >
                <IconBookPlus width={14} height={14} />
              </button>
            )}
            {stop && onReviewFix && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runReviewAction(onReviewFix, stop.word)}
                disabled={!!reviewBusy || disabled}
                title={`Correggi «${stop.word}» con ${proofModelLabel || 'il modello di rilettura selezionato'}`}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-50"
              >
                {reviewBusy ? <IconSpinner width={13} height={13} /> : <IconWand width={13} height={13} />}
                Correggi
              </button>
            )}
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onReviewExit?.()}
              aria-label="Chiudi la revisione guidata"
              title="Chiudi la revisione guidata (Esc)"
              className="grid min-h-9 min-w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <IconX width={14} height={14} />
            </button>
          </div>
        </div>
      )}

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

      {editorSelection && (
        <div className="flex flex-col gap-2 border-b border-border bg-primary-soft px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-ink">
              <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              Selezione Typst · <span className="tabular-nums">{editorSelection.count}</span> caratteri
              {listState?.lines > 1 && (
                <span className="font-normal text-muted">· {listState.lines} righe</span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted">
              {selectionBusy
                ? selectionDetail || 'Intervento IA in corso…'
                : editorSelection.sample}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-lg bg-surface/70 p-0.5">
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggleList('bullet')}
                disabled={disabled}
                aria-pressed={!!listState?.bullet}
                aria-label="Elenco puntato"
                title="Elenco puntato — ogni riga diventa una voce (Ctrl+Shift+8)"
                className={listState?.bullet ? listButtonActive : listButton}
              >
                <IconListBullet width={14} height={14} />
              </button>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggleList('ordered')}
                disabled={disabled}
                aria-pressed={!!listState?.ordered}
                aria-label="Elenco numerato"
                title={`Elenco numerato con marcatore «${enumMarker}» (Ctrl+Shift+7)`}
                className={listState?.ordered ? listButtonActive : listButton}
              >
                <IconListOrdered width={14} height={14} />
              </button>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyListEdit(indentIntoItem)}
                disabled={disabled}
                aria-label="Rientra nella voce precedente"
                title="Rientra nella voce precedente: il testo resta dentro la voce e la numerazione non riparte (Ctrl+])"
                className={listButton}
              >
                <IconIndent width={14} height={14} />
              </button>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyListEdit(endList)}
                disabled={disabled}
                aria-label="Termina l’elenco qui"
                title="Termina l’elenco qui: toglie un livello di rientro (Ctrl+[)"
                className={listButton}
              >
                <IconOutdent width={14} height={14} />
              </button>
            </div>
            {onReviseSelection && (
              <>
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
              </>
            )}
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
        {marks.length > 0 && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div ref={marksRef} className="absolute inset-x-0 top-0">
              {marks.map((mark, index) => (markTops[index] === undefined ? null : (
                <button
                  key={mark.line}
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => showStop(stops.find((item) => item.start === mark.start))}
                  title={mark.count > 1
                    ? `${mark.count} parole sospette alla riga ${mark.line}`
                    : `Parola sospetta alla riga ${mark.line}`}
                  aria-label={`Vai al sospetto della riga ${mark.line}`}
                  className={`pointer-events-auto absolute left-1 size-2 rounded-full transition-transform hover:scale-150 ${
                    stop && stop.line === mark.line ? 'bg-primary' : 'bg-warning'
                  }`}
                  style={{ top: markTops[index] + 8 }}
                />
              )))}
            </div>
          </div>
        )}
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
