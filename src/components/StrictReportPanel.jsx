import { useState } from 'react';
import { IconAlert, IconCheck } from './Icons.jsx';

export default function StrictReportPanel({ report }) {
  const [open, setOpen] = useState(false);
  if (!report || report.workflow !== 'strict') return null;
  const pdfOk = report.pdf?.ok && !(report.pdf?.missingInvariants?.length);
  const comparisons = (report.ocrComparisons || []).filter(Boolean);
  const uncertain = comparisons.filter((c) => c.error || c.agreement < 0.97);
  const corrections = report.corrections || [];

  return (
    <section className={`overflow-hidden rounded-xl border ${
      report.pdf && !pdfOk ? 'border-danger/40 bg-danger-soft' : 'border-success/40 bg-success/10'
    }`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2.5 text-sm text-ink">
          {report.pdf && !pdfOk
            ? <IconAlert width={16} height={16} className="text-danger" />
            : <IconCheck width={16} height={16} className="text-success" />}
          <span>
            <span className="font-medium">Workflow fedeltà massima</span>
            {' · '}{report.pdf ? (pdfOk ? 'PDF verificato parola per parola' : 'verifica PDF fallita') : 'verifica in corso'}
            {corrections.length ? ` · ${corrections.length} correzioni registrate` : ''}
            {uncertain.length ? ` · ${uncertain.length} pagine OCR discordanti` : ''}
          </span>
        </span>
        <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-border/60 px-4 py-3 text-[13px]">
          {report.pdf && (
            <div>
              <div className="font-medium text-ink">Controllo del PDF compilato</div>
              <p className="mt-1 text-muted">
                {report.pdf.matched}/{report.pdf.sourceCount} parole canoniche allineate; output {report.pdf.outputCount} parole.
              </p>
              {!!report.pdf.missing?.length && <p className="mt-1 text-danger">Mancanti: {report.pdf.missing.join(', ')}</p>}
              {!!report.pdf.added?.length && <p className="mt-1 text-danger">Aggiunte: {report.pdf.added.join(', ')}</p>}
              {!!report.pdf.missingInvariants?.length && (
                <p className="mt-1 text-danger">Numeri/riferimenti mancanti: {report.pdf.missingInvariants.join(', ')}</p>
              )}
            </div>
          )}
          {!!corrections.length && (
            <div>
              <div className="font-medium text-ink">Registro correzioni conservative</div>
              <ul className="mt-1 space-y-2">
                {corrections.map((c, i) => (
                  <li key={i} className="rounded-lg bg-surface/60 p-2 text-muted">
                    <div><span className="text-danger line-through">{c.before}</span></div>
                    <div className="mt-1"><span className="text-success">{c.after}</span></div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!comparisons.length && (
            <div>
              <div className="font-medium text-ink">Confronto OCR indipendente</div>
              <ul className="mt-1 space-y-1 text-muted">
                {comparisons.map((c) => (
                  <li key={c.page}>
                    Pagina {c.page}: {c.error
                      ? c.error
                      : `${c.primary} ↔ ${c.alternate}, accordo ${Math.round(c.agreement * 100)}%${
                          c.agreement < 0.97 ? ` · differenze: ${[...(c.missing || []), ...(c.added || [])].slice(0, 10).join(', ')}` : ''
                        }`}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-faint">
                Le divergenze non modificano automaticamente il testo canonico: indicano le pagine da confrontare con la scansione.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
