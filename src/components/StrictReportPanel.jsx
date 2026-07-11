import { useState } from 'react';
import { IconAlert, IconCheck } from './Icons.jsx';

export default function StrictReportPanel({ report }) {
  const [open, setOpen] = useState(false);
  if (!report || report.workflow !== 'strict') return null;
  const pdfOk = report.pdf?.contentOk === true;
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
            {' · '}{report.pdf
              ? (pdfOk ? 'contenuto del PDF verificato' : 'PDF generato con avviso di verifica')
              : 'verifica in corso'}
            {corrections.length ? ` · ${corrections.length} correzioni registrate` : ''}
            {uncertain.length ? ` · ${uncertain.length} pagine OCR discordanti` : ''}
          </span>
        </span>
        <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-border/60 px-4 py-3 text-[13px]">
          {report.layoutPlan?.document && (
            <div>
              <div className="font-medium text-ink">Piano editoriale applicato</div>
              <p className="mt-1 text-muted">
                Font {report.layoutPlan.document.font} · titoli {report.layoutPlan.document.headfont} ·
                margini {report.layoutPlan.document.margin} · densità {report.layoutPlan.document.density} ·
                {report.layoutPlan.document.align === 'ragged' ? ' allineamento a bandiera' : ' testo giustificato'}.
                Il modello ha assegnato uno stile speciale a {report.layoutPlan.blocks?.length || 0} blocchi,
                senza ricevere la possibilità di modificarne il contenuto.
              </p>
            </div>
          )}
          {report.pdf && (
            <div>
              <div className="font-medium text-ink">Controllo del PDF compilato</div>
              <p className="mt-1 text-muted">
                {report.pdf.unverifiable
                  ? 'Il PDF non espone un layer testuale verificabile; il file resta comunque disponibile.'
                  : `${report.pdf.matched}/${report.pdf.sourceCount} parole in ordine; output ${report.pdf.outputCount} parole.${
                      report.pdf.exactOrder ? '' : ' Tabelle, note o impaginazione possono cambiare l’ordine di estrazione.'
                    }`}
              </p>
              {!!report.pdf.missing?.length && <p className="mt-1 text-danger">Mancanti: {report.pdf.missing.join(', ')}</p>}
              {!!report.pdf.added?.length && <p className="mt-1 text-danger">Aggiunte: {report.pdf.added.join(', ')}</p>}
              {!!report.pdf.missingInvariants?.length && (
                <p className="mt-1 text-danger">Numeri/riferimenti mancanti: {report.pdf.missingInvariants.join(', ')}</p>
              )}
              {!pdfOk && (
                <p className="mt-2 text-xs text-muted">
                  Il PDF non viene bloccato: confronta i termini indicati con il pannello OCR prima dell’uso definitivo.
                </p>
              )}
              {!!report.pdf.issues?.length && (
                <div className="mt-4 space-y-3">
                  <div className="font-medium text-ink">Confronto automatico per frase</div>
                  {report.pdf.issues.map((issue) => {
                    const review = report.pdf.aiReview?.find((r) => r.id === issue.id);
                    return (
                      <div key={issue.id} className="overflow-hidden rounded-lg border border-border bg-surface/70">
                        <div className="grid gap-px bg-border sm:grid-cols-2">
                          <div className="bg-surface p-3">
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Fonte OCR canonica</div>
                            <p className="leading-relaxed text-ink">{highlightWords(issue.source, issue.missing)}</p>
                          </div>
                          <div className="bg-surface p-3">
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Passaggio PDF/Typst più simile</div>
                            <p className="leading-relaxed text-ink">{issue.rendered || 'Nessun passaggio simile trovato.'}</p>
                          </div>
                        </div>
                        <div className="border-t border-border px-3 py-2 text-xs text-muted">
                          Parole segnalate: <span className="font-medium text-warning">{issue.missing.join(', ')}</span>
                          {' · '}somiglianza {Math.round(issue.similarity * 100)}%
                          {review && (
                            <span className="ml-2">
                              · <span className={`font-semibold ${review.classification === 'real_omission' ? 'text-danger' : review.classification === 'extraction_artifact' ? 'text-success' : 'text-warning'}`}>
                                {review.classification === 'real_omission'
                                  ? 'omissione probabile'
                                  : review.classification === 'extraction_artifact'
                                    ? 'probabile artefatto di estrazione'
                                    : 'caso incerto'}
                              </span>
                              {review.explanation ? ` — ${review.explanation}` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {report.pdf.reviewError && (
                    <p className="text-xs text-warning">Revisione AI non disponibile: {report.pdf.reviewError}</p>
                  )}
                </div>
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

function highlightWords(text, words) {
  if (!text || !words?.length) return text;
  const escaped = [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'giu');
  const matchRe = new RegExp(`^(?:${escaped.join('|')})$`, 'iu');
  return text.split(re).map((part, i) =>
    matchRe.test(part)
      ? <mark key={i} className="rounded bg-warning/30 px-0.5 text-ink">{part}</mark>
      : part,
  );
}
