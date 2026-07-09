import { useMemo, useRef } from 'react';
import { IconRefresh, IconSpinner, IconAlert } from './Icons.jsx';
import CopyButton from './CopyButton.jsx';

/**
 * Editor a colonna sinistra: codice Typst generato e modificabile dall'utente,
 * con numeri di riga sincronizzati e pulsante di compilazione locale.
 */
export default function TypstEditor({
  value,
  onChange,
  onCompile,
  compiling,
  error,
  disabled,
}) {
  const taRef = useRef(null);
  const gutterRef = useRef(null);

  const lineCount = useMemo(
    () => Math.max(value.split('\n').length, 1),
    [value],
  );

  const syncScroll = () => {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  };

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">Codice Typst</h2>
          <span className="text-xs text-faint">modificabile</span>
        </div>
        <div className="flex items-center gap-1.5">
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
          <div>
            <span className="font-medium">Errore di compilazione.</span>{' '}
            <span className="font-mono text-[12px] leading-snug opacity-90">
              {error}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
