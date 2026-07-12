import { useEffect, useMemo, useRef } from 'react';
import { IconDownload, IconSpinner, IconFile, IconShare } from './Icons.jsx';
import { isNativeApp } from '../lib/download.js';
import { SEARCH_HIGHLIGHT_COLOR } from '../lib/searchPreview.js';

/**
 * Anteprima a colonna destra. Renderizza l'SVG vettoriale prodotto da Typst
 * (funziona ovunque, anche nella WebView Android dove l'<iframe> PDF resta
 * bianco). Il PDF viene compilato su richiesta: sul web si scarica; nell'app
 * nativa "Salva" apre il dialogo di sistema con scelta di cartella e nome,
 * "Condividi" il foglio di condivisione.
 */
export default function PdfPreview({ svg, compiling, downloading, onDownload, searchRevision }) {
  const native = isNativeApp();
  const paperRef = useRef(null);
  // Rende l'SVG responsivo: larghezza 100%, altezza automatica.
  const html = useMemo(() => {
    if (!svg) return '';
    return svg.replace(
      /<svg /,
      '<svg style="width:100%;height:auto;display:block" ',
    );
  }, [svg]);

  // L'evidenziazione Typst diventa un rettangolo colorato nell'SVG. Lo trova
  // e centra automaticamente dentro il pannello PDF, anche per documenti
  // multipagina molto lunghi.
  useEffect(() => {
    if (!searchRevision || !paperRef.current) return;
    const hex = SEARCH_HIGHLIGHT_COLOR.toLowerCase();
    const rgb = 'rgb(255, 222, 89)';
    const target = [...paperRef.current.querySelectorAll('[fill], [style]')].find((node) => {
      const paint = `${node.getAttribute('fill') || ''} ${node.getAttribute('style') || ''}`.toLowerCase();
      return paint.includes(hex) || paint.includes(rgb);
    });
    if (!target) return;
    target.style.filter = 'drop-shadow(0 0 2px rgba(180, 110, 0, .9))';
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    });
  }, [svg, searchRevision]);

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-annote" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">Anteprima</h2>
          <span className="text-xs text-faint">vettoriale</span>
        </div>
        <div className="flex items-center gap-1.5">
          {native && (
            <button
              onClick={() => onDownload('share')}
              disabled={!svg || downloading}
              title="Condividi il PDF (foglio di condivisione)"
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconShare width={14} height={14} />
              Condividi
            </button>
          )}
          <button
            onClick={() => onDownload('save')}
            disabled={!svg || downloading}
            title={native ? 'Salva in Files: scegli cartella e nome' : 'Scarica il PDF'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading ? <IconSpinner width={14} height={14} /> : <IconDownload width={14} height={14} />}
            {downloading ? 'Genero…' : native ? 'Salva PDF' : 'Scarica PDF'}
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-auto bg-surface-2">
        {svg ? (
          // Il documento su "carta" bianca: l'SVG di Typst ha sfondo
          // trasparente e in tema scuro il testo nero sparirebbe.
          <div className="mx-auto max-w-3xl p-3">
            <div
              ref={paperRef}
              className="overflow-hidden rounded-lg bg-white shadow-lg [&_svg]:h-auto [&_svg]:w-full"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
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
