import { useMemo } from 'react';
import { IconDownload, IconSpinner, IconFile } from './Icons.jsx';

/**
 * Anteprima a colonna destra. Renderizza l'SVG vettoriale prodotto da Typst
 * (funziona ovunque, anche nella WebView Android dove l'<iframe> PDF resta
 * bianco). Il download compila il PDF su richiesta e lo salva/condivide.
 */
export default function PdfPreview({ svg, compiling, downloading, onDownload }) {
  // Rende l'SVG responsivo: larghezza 100%, altezza automatica.
  const html = useMemo(() => {
    if (!svg) return '';
    return svg.replace(
      /<svg /,
      '<svg style="width:100%;height:auto;display:block" ',
    );
  }, [svg]);

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-annote" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">Anteprima</h2>
          <span className="text-xs text-faint">vettoriale</span>
        </div>
        <button
          onClick={onDownload}
          disabled={!svg || downloading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {downloading ? <IconSpinner width={14} height={14} /> : <IconDownload width={14} height={14} />}
          {downloading ? 'Genero…' : 'Scarica PDF'}
        </button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-auto bg-surface-2">
        {svg ? (
          <div
            className="mx-auto max-w-3xl p-3 [&_svg]:h-auto [&_svg]:w-full"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="grid size-full place-items-center p-8 text-center">
            <div className="max-w-xs">
              <span className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-surface-3 text-faint">
                <IconFile width={22} height={22} />
              </span>
              <p className="text-sm text-muted">
                L’anteprima apparirà qui. Modifica il codice Typst e premi
                <span className="text-ink"> Genera PDF</span> per aggiornarla.
              </p>
            </div>
          </div>
        )}

        {compiling && (
          <div className="absolute inset-0 grid place-items-center bg-bg/70 backdrop-blur-sm">
            <div className="flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2 text-sm text-ink">
              <IconSpinner width={16} height={16} className="text-primary" />
              Compilazione Typst…
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
