import { IconDownload, IconSpinner, IconFile } from './Icons.jsx';

/**
 * Anteprima a colonna destra: visualizzatore PDF integrato (<iframe> sul
 * viewer nativo del browser) con azione di download del PDF vettoriale.
 */
export default function PdfPreview({ pdfUrl, compiling, onDownload, fileName }) {
  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-annote" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">Anteprima PDF</h2>
          <span className="text-xs text-faint">vettoriale</span>
        </div>
        <button
          onClick={onDownload}
          disabled={!pdfUrl}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconDownload width={14} height={14} />
          Scarica
        </button>
      </header>

      <div className="relative min-h-0 flex-1 bg-surface-2">
        {pdfUrl ? (
          <iframe
            key={pdfUrl}
            src={`${pdfUrl}#toolbar=1&view=FitH`}
            title={`Anteprima di ${fileName || 'documento'}`}
            className="size-full border-0"
          />
        ) : (
          <div className="grid size-full place-items-center p-8 text-center">
            <div className="max-w-xs">
              <span className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-surface-3 text-faint">
                <IconFile width={22} height={22} />
              </span>
              <p className="text-sm text-muted">
                Il PDF compilato apparirà qui. Modifica il codice Typst e premi
                <span className="text-ink"> Genera PDF</span> per aggiornarlo.
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
