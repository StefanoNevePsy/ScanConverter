import { useState } from 'react';
import { IconAlert, IconCheck, IconSpinner, IconWand } from './Icons.jsx';

export default function StrictReportPanel({
  report,
  onReviewCorrection,
  correctionBusy,
  onReviewIssue,
  issueBusy,
}) {
  const [open, setOpen] = useState(false);
  const [notices, setNotices] = useState({});
  const [issueNotices, setIssueNotices] = useState({});
  if (!report || report.workflow !== 'strict') return null;
  const pdfOk = report.pdf?.contentOk === true;
  const comparisons = (report.ocrComparisons || []).filter(Boolean);
  const uncertain = comparisons.filter((c) => c.error || c.agreement < 0.97);
  const corrections = report.corrections || [];
  const runCorrectionAction = async (index, action) => {
    if (!onReviewCorrection) return;
    const result = await onReviewCorrection(index, action);
    setNotices((current) => ({ ...current, [index]: result?.message || '' }));
  };
  const runIssueAction = async (index, action) => {
    if (!onReviewIssue) return;
    const result = await onReviewIssue(index, action);
    setIssueNotices((current) => ({ ...current, [index]: result?.message || '' }));
  };

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
                  <div className="max-h-[min(65vh,36rem)] space-y-3 overflow-y-auto overscroll-contain pr-1">
                  {report.pdf.issues.map((issue, issueIndex) => {
                    const review = report.pdf.aiReview?.find((r) => r.id === issue.id);
                    const resolution = report.issueResolutions?.[issue.key];
                    const passageReview = resolution?.passageReview;
                    const busy = issueBusy?.index === issueIndex;
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
                          {resolution?.status === 'artifact' && (
                            <span className="ml-2 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
                              · confermato come artefatto
                            </span>
                          )}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => runIssueAction(issueIndex, 'mark-artifact')}
                              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-ink hover:bg-surface-2 disabled:opacity-50"
                            >È un artefatto</button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => runIssueAction(issueIndex, 'restore-canonical')}
                              className="rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-xs text-success hover:bg-success/15 disabled:opacity-50"
                            >Ripristina dalla fonte OCR</button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => runIssueAction(issueIndex, 'review-ai')}
                              className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs text-accent hover:bg-accent/15 disabled:opacity-50"
                            >
                              {busy && issueBusy?.action === 'review-ai'
                                ? <IconSpinner width={13} height={13} />
                                : <IconWand width={13} height={13} />}
                              Ricostruisci con IA
                            </button>
                          </div>
                          {passageReview && (
                            <div className="mt-2 rounded-md border border-accent/20 bg-accent/5 p-2">
                              <div className="font-medium text-ink">
                                Esito IA: {passageReview.choice === 'artifact'
                                  ? 'differenza di estrazione, testo presente'
                                  : passageReview.choice === 'canonical'
                                    ? 'ripristinare integralmente la fonte OCR'
                                    : 'proposta di ricostruzione completa'}
                              </div>
                              {passageReview.explanation && <p className="mt-1">{passageReview.explanation}</p>}
                              {passageReview.choice === 'proposal' && (
                                <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-ink">
                                  {passageReview.text}
                                </p>
                              )}
                              <button
                                type="button"
                                disabled={busy || passageReview.safe !== true}
                                onClick={() => runIssueAction(issueIndex, 'apply-ai')}
                                className="mt-2 rounded-md bg-accent px-2.5 py-1.5 font-medium text-white disabled:opacity-40"
                              >Applica esito IA</button>
                              {!passageReview.safe && (
                                <span className="ml-2 text-warning">Bloccato: possibile perdita di testo o numeri.</span>
                              )}
                            </div>
                          )}
                          {busy && issueBusy?.action !== 'review-ai' && (
                            <p className="mt-2 inline-flex items-center gap-1.5">
                              <IconSpinner width={13} height={13} /> Ricompilazione e nuovo confronto…
                            </p>
                          )}
                          {issueNotices[issueIndex] && !busy && (
                            <p className="mt-2 text-faint">{issueNotices[issueIndex]}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  </div>
                  {report.pdf.reviewError && (
                    <p className="text-xs text-warning">Revisione AI non disponibile: {report.pdf.reviewError}</p>
                  )}
                </div>
              )}
            </div>
          )}
          {!!corrections.length && (
            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="font-medium text-ink">Revisione delle correzioni</div>
                  <p className="mt-0.5 text-xs text-muted">
                    Scegli il testo OCR, la correzione applicata o chiedi un controllo puntuale all’IA.
                  </p>
                </div>
                <span className="shrink-0 text-xs text-faint">{corrections.length} voci</span>
              </div>
              <ul className="mt-2 max-h-[min(55vh,28rem)] space-y-2 overflow-y-auto overscroll-contain pr-1">
                {corrections.map((c, i) => {
                  const busy = correctionBusy?.index === i;
                  const reversible = !!c.before?.trim() && !!c.after?.trim() && !c.before.includes('⟂');
                  const reviewable = reversible && !!onReviewCorrection;
                  const decisionLabel = c.decision === 'original'
                    ? 'OCR scelto'
                    : c.decision === 'ai'
                      ? 'esito IA scelto'
                      : c.decision === 'corrected'
                        ? 'correzione confermata'
                        : '';
                  return (
                    <li key={i} className="rounded-lg border border-border/70 bg-surface/70 p-2.5 text-muted">
                      <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-semibold uppercase tracking-wide text-faint">Modifica {i + 1}</span>
                        {decisionLabel && <span className="rounded-full bg-success/10 px-2 py-0.5 text-success">{decisionLabel}</span>}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="rounded-md bg-danger/5 p-2">
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-danger">OCR originale</div>
                          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap leading-relaxed text-ink">{c.before || '—'}</div>
                        </div>
                        <div className="rounded-md bg-success/5 p-2">
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-success">Versione corretta</div>
                          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap leading-relaxed text-ink">{c.after || 'Elemento rimosso'}</div>
                        </div>
                      </div>
                      {reviewable ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runCorrectionAction(i, 'use-original')}
                            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-ink hover:bg-surface-2 disabled:opacity-50"
                          >Usa OCR</button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runCorrectionAction(i, 'use-corrected')}
                            className="rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-xs text-success hover:bg-success/15 disabled:opacity-50"
                          >Mantieni correzione</button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runCorrectionAction(i, 'review-ai')}
                            className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs text-accent hover:bg-accent/15 disabled:opacity-50"
                          >
                            {busy && correctionBusy?.action === 'review-ai'
                              ? <IconSpinner width={13} height={13} />
                              : <IconWand width={13} height={13} />}
                            Ricontrolla con IA
                          </button>
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-faint">
                          Modifica strutturale automatica: mostrata per trasparenza, ma non reinseribile senza una posizione univoca.
                        </p>
                      )}
                      {c.aiReview && (
                        <div className="mt-2 rounded-md border border-accent/20 bg-accent/5 p-2 text-xs">
                          <div className="font-medium text-ink">
                            Esito IA: {c.aiReview.choice === 'original'
                              ? 'preferisce l’originale OCR'
                              : c.aiReview.choice === 'corrected'
                                ? 'conferma la correzione'
                                : 'propone una terza versione'}
                          </div>
                          {c.aiReview.explanation && <p className="mt-1 text-muted">{c.aiReview.explanation}</p>}
                          {c.aiReview.choice === 'proposal' && (
                            <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-ink">
                              {c.aiReview.text}
                            </p>
                          )}
                          <button
                            type="button"
                            disabled={busy || !c.aiReview.applicable}
                            onClick={() => runCorrectionAction(i, 'use-ai')}
                            className="mt-2 rounded-md bg-accent px-2.5 py-1.5 font-medium text-white disabled:opacity-40"
                          >Applica esito IA</button>
                          {!c.aiReview.applicable && (
                            <span className="ml-2 text-warning">Proposta bloccata dai controlli di sicurezza.</span>
                          )}
                        </div>
                      )}
                      {busy && correctionBusy?.action !== 'review-ai' && (
                        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted">
                          <IconSpinner width={13} height={13} /> Ricompilazione e verifica del PDF…
                        </p>
                      )}
                      {notices[i] && !busy && <p className="mt-2 text-xs text-muted">{notices[i]}</p>}
                    </li>
                  );
                })}
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
