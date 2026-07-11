import { useEffect, useMemo, useRef, useState } from 'react';
import { IconRefresh, IconSpinner, IconAlert, IconSearch, IconX, IconWand, IconSpell, IconText } from './Icons.jsx';
import CopyButton from './CopyButton.jsx';

// Altezza riga dell'editor (leading-6): serve per centrare i risultati.
const LINE_H = 24;

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
  searchRequest,
  compiling,
  error,
  disabled,
}) {
  const taRef = useRef(null);
  const gutterRef = useRef(null);
  const searchRef = useRef(null);
  const pendingJumpRef = useRef(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replaceStr, setReplaceStr] = useState('');
  const [current, setCurrent] = useState(0);

  const lineCount = useMemo(
    () => Math.max(value.split('\n').length, 1),
    [value],
  );

  // Posizioni (indici) delle occorrenze, case-insensitive.
  const matches = useMemo(() => {
    if (!query) return [];
    const hay = value.toLowerCase();
    const needle = query.toLowerCase();
    const out = [];
    let i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1 && out.length < 5000) {
      out.push(i);
      i += needle.length || 1;
    }
    return out;
  }, [value, query]);

  useEffect(() => {
    if (current >= matches.length) setCurrent(0);
  }, [matches, current]);

  // Ricerca pilotata dall'esterno (es. clic su una parola sospetta nel
  // controllo ortografico): apre la barra, imposta la query e salta al primo
  // risultato appena i match sono calcolati.
  useEffect(() => {
    if (!searchRequest?.query) return;
    setQuery(searchRequest.query);
    setSearchOpen(true);
    pendingJumpRef.current = true;
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
    setCurrent(n);
    const ta = taRef.current;
    if (!ta) return;
    const pos = matches[n];
    ta.focus();
    ta.setSelectionRange(pos, pos + query.length);
    const line = value.slice(0, pos).split('\n').length;
    ta.scrollTop = Math.max(0, (line - 1) * LINE_H - ta.clientHeight / 2);
    syncScroll();
  };

  // Salto al primo risultato di una ricerca esterna (dopo il ricalcolo).
  useEffect(() => {
    if (pendingJumpRef.current && matches.length) {
      pendingJumpRef.current = false;
      goto(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const replaceCurrent = () => {
    if (!matches.length) return;
    const pos = matches[current];
    onChange(value.slice(0, pos) + replaceStr + value.slice(pos + query.length));
  };

  const replaceAll = () => {
    if (!query || !matches.length) return;
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    onChange(value.replace(re, () => replaceStr));
  };

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const closeSearch = () => {
    setSearchOpen(false);
    taRef.current?.focus();
  };

  const onEditorKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
    }
  };

  const onSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goto(current + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  };

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">Codice Typst</h2>
          <span className="hidden text-xs text-faint sm:inline">modificabile</span>
        </div>
        <div className="flex items-center gap-1.5">
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
              title="Rilettura AI (italiano): ripristina accenti «è/e», parole saltate e virgolette"
              aria-label="Rilettura AI"
              className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1.5 text-ink transition-colors hover:bg-surface-3 disabled:opacity-50"
            >
              {proofreadBusy ? <IconSpinner width={14} height={14} /> : <IconText width={14} height={14} />}
              {proofreadBusy && proofreadDetail && (
                <span className="text-xs tabular-nums">{proofreadDetail}</span>
              )}
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

      {searchOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Cerca…"
              className="w-full min-w-24 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-faint focus:border-primary focus:outline-none"
            />
            <span className="shrink-0 text-xs tabular-nums text-faint">
              {matches.length ? `${current + 1}/${matches.length}` : query ? '0' : ''}
            </span>
            <button
              onClick={() => goto(current - 1)}
              disabled={!matches.length}
              aria-label="Occorrenza precedente"
              className="rounded-md bg-surface-2 px-2 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-40"
            >
              ↑
            </button>
            <button
              onClick={() => goto(current + 1)}
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
          onScroll={syncScroll}
          onKeyDown={onEditorKeyDown}
          spellCheck={false}
          disabled={disabled}
          placeholder={disabled ? '' : 'Il codice Typst apparirà qui dopo l’elaborazione…'}
          className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[13px] leading-6 text-ink caret-primary placeholder:text-faint focus:outline-none"
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
                title="Correzioni deterministiche istantanee (senza AI)"
                className="rounded-lg bg-danger/20 px-2.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-danger/30 disabled:opacity-50"
              >
                Correggi (istantaneo)
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
