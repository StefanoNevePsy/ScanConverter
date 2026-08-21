import { useCallback, useEffect, useRef, useState } from 'react';
import { extractPageBlocks, toTypstNvidia } from '../lib/nvidia.js';
import { toTypst, ocrImageGemini } from '../lib/gemini.js';
import { compileToPdf, diagnoseTypst, initTypst, locateTypstError } from '../lib/typst.js';
import { savePdf, saveProjectArchive, sharePdf } from '../lib/download.js';
import { fileToDataUrl, isPdf } from '../lib/files.js';
import { renderPdfToImages } from '../lib/pdf.js';
import { assemblePage, makeFigureCounter, applyFigureWidths } from '../lib/assemble.js';
import { refinePageTables } from '../lib/segments.js';
import { localOcrBlocks } from '../lib/local.js';
import { toTypstLocal } from '../lib/engines.js';
import { extractPdfText } from '../lib/pdftext.js';
import { hasPdfData, releaseDesktopPdf } from '../lib/desktop.js';
import { isSpreadLike, preparePages, makeThumbnail } from '../lib/pagePrep.js';
import {
  chunkDocument,
  splitPreamble,
  outlineFromBody,
  combineDocument,
  normalizeHeadingLevels,
  enforceHeadingLevels,
} from '../lib/session.js';
import {
  buildPreamble,
  DEFAULT_LAYOUT_OPTIONS,
  ensureExplicitHyphenation,
  extractTitle,
  normalizeLayoutOptions,
} from '../lib/preamble.js';
import {
  diagnosticProgress,
  repairTypstDeterministically,
} from '../lib/typstfix.js';
import { checkFidelity, fidelityNoteFrom } from '../lib/fidelity.js';
import { requestTypstFix, applyFixes, describeFix } from '../lib/aifix.js';
import {
  loadSpeller,
  findSuspects,
  requestSpellFixes,
  validateCorrections,
  applySpellFixes,
  fixOcrHyphenation,
  fixSpacing,
} from '../lib/spell.js';
import {
  isSafeContextualCorrection,
  proofreadBody,
  requestCorrectionReview,
} from '../lib/proofread.js';
import {
  buildStrictDocument,
  buildDifferenceContexts,
  canonicalTokens,
  compareTokenInventory,
  compareTokenSequences,
  missingInvariants,
  repairBoundaryOverlaps,
  rebaseCanonicalRevision,
  replaceUniqueText,
  restoreCanonicalPassage,
  sourcePlainText,
} from '../lib/strict.js';
import {
  requestStrictDifferenceReview,
  requestStrictLayoutPlan,
  requestStrictPassageRepair,
} from '../lib/layoutPlan.js';
import { createPdfSearchTarget } from '../lib/pdfPreview.js';
import { loadSpellIgnore, addSpellIgnore } from '../lib/storage.js';
import { createProjectArchive, inspectProjectArchive } from '../lib/projectArchive.js';
import {
  saveSession,
  saveFigures,
  getFigures,
  deleteFigures,
  listSessions,
  deleteSession,
  savePages,
  getPage,
  savePart,
  saveParts,
  getParts,
  getSession,
  getPages,
  savePageRecords,
  deletePage,
  deletePagesFor,
  requestPersistentStorage,
} from '../lib/store.js';

// Pausa interrompibile (per il backoff sui rate limit).
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

// Errori transitori di Gemini da riprovare con backoff: rate limit (429) e
// sovraccarico/indisponibilità temporanea del modello (500/503, "overloaded",
// "UNAVAILABLE"). Gli errori definitivi (400, chiave errata…) NON si riprovano.
const RETRYABLE_RE =
  /(^|\D)(429|500|503)(\D|$)|rate.?limit|RESOURCE_EXHAUSTED|quota|overloaded|unavailable|temporarily|try again/i;

/**
 * Esegue `fn` con auto-retry ed exponential backoff sugli errori transitori
 * (rate limit / servizio occupato). Interrompibile via signal. `onWait(secs)`
 * riporta l'attesa corrente all'interfaccia.
 */
async function withRetry(fn, signal, onWait, { max = 6, start = 15000, cap = 120000 } = {}) {
  let delay = start;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      if (!RETRYABLE_RE.test(e.message || '') || attempt >= max) throw e;
      onWait?.(Math.round(delay / 1000));
      await abortableSleep(delay, signal);
      delay = Math.min(delay * 2, cap);
    }
  }
}

// Le tre fasi dello split delle operazioni, nell'ordine mostrato all'utente.
export const STEPS = [
  { id: 'ocr', label: 'Estrazione testo', hint: 'NVIDIA Nemotron-Parse' },
  { id: 'format', label: 'Formattazione layout', hint: 'Gemini/NVIDIA → Typst' },
  { id: 'compile', label: 'Compilazione PDF', hint: 'Typst nativo/WASM · locale' },
];

const emptyStatus = { ocr: 'pending', format: 'pending', compile: 'pending' };

function summarizeFixLog(items, limit = 10) {
  const visible = items.slice(0, limit);
  const more = items.length > visible.length ? ` · +${items.length - visible.length} altre` : '';
  return `${visible.join(' · ')}${more}`;
}

function correctionContext(rawText, before, after, radius = 700) {
  const source = String(rawText || '');
  let index = before ? source.indexOf(before) : -1;
  if (index < 0 && after) index = source.indexOf(after);
  if (index < 0) return source.slice(0, radius * 2);
  return source.slice(Math.max(0, index - radius), index + Math.max(before?.length || 0, 1) + radius);
}

/**
 * Stato e orchestrazione dell'intera pipeline: OCR → Typst → PDF.
 * L'editor Typst resta la fonte di verità modificabile; `recompile` ricompila
 * localmente il contenuto corrente senza richiamare le API remote.
 */
export function usePipeline(settings) {
  const [phase, setPhase] = useState('idle'); // idle | running | done | error
  const [status, setStatus] = useState(emptyStatus);
  const [activeStep, setActiveStep] = useState(null);
  const [error, setError] = useState(null);

  const [rawText, setRawText] = useState('');
  const [typstCode, setTypstCode] = useState('');
  const [layoutOptions, setLayoutOptions] = useState(DEFAULT_LAYOUT_OPTIONS);
  const [previewPdf, setPreviewPdf] = useState(null); // byte web o handle file desktop
  const [compileError, setCompileError] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [projectBusy, setProjectBusy] = useState(null); // 'export' | 'import' | null
  const [aiFixing, setAiFixing] = useState(false);
  const [spellReport, setSpellReport] = useState(null); // {suspects, error?} | null
  const [spellBusy, setSpellBusy] = useState(false);
  const [proofreadBusy, setProofreadBusy] = useState(false);
  const [proofreadDetail, setProofreadDetail] = useState(''); // "3/12 paragrafi…"
  const [detail, setDetail] = useState(''); // sotto-progresso della fase attiva
  const [chunkProgress, setChunkProgress] = useState(null); // {done,total} | null
  const [ocrProgress, setOcrProgress] = useState(null); // {done,total} | null (fase OCR)
  const [canResume, setCanResume] = useState(false); // sessione interrotta ripristinabile
  const [sessions, setSessions] = useState([]); // sessioni salvate su IndexedDB
  // Revisione figure dopo l'OCR: [{path,url,junk,keep}] | null. La pipeline
  // resta in pausa (phase 'review') finché l'utente non conferma la selezione.
  const [figureReview, setFigureReview] = useState(null);
  // Anteprima pagine PRIMA dell'OCR: [{index,url,rotate,split}] | null.
  // L'utente ruota le pagine storte e conferma/divide le doppie pagine
  // rilevate; la pipeline resta in pausa (phase 'pages') fino alla conferma.
  const [pageReview, setPageReview] = useState(null);
  const pendingPagesRef = useRef(null); // { pageImages, fileName }
  // Esito della verifica di fedeltà per chunk: [{chunk,total,coverage,missing}].
  const [fidelityWarnings, setFidelityWarnings] = useState([]);
  const [strictReport, setStrictReport] = useState(null);
  const [strictCorrectionBusy, setStrictCorrectionBusy] = useState(null);
  const [strictIssueBusy, setStrictIssueBusy] = useState(null);
  const figuresRef = useRef([]); // figure ritagliate dal documento originale
  // Il PDF mostrato in anteprima è anche quello consegnato al download. La
  // coppia sorgente/riferimento figure impedisce di riusare byte obsoleti.
  const compiledPdfRef = useRef({ source: '', figures: null, pdf: null });
  const sessionRef = useRef(null); // { id, fileName, rawText, chunks, preamble, styleHint }
  const pendingRef = useRef(null); // { extracted, fileName } in attesa di conferma figure
  const searchPreviewRef = useRef(0); // scarta compilazioni di ricerca ormai superate

  const abortRef = useRef(null);

  // Rende persistente lo storage IndexedDB (best-effort) così le sessioni di
  // libri lunghi non vengono sfrattate dal browser sotto pressione di disco.
  useEffect(() => {
    requestPersistentStorage();
  }, []);

  /**
   * Arricchisce un errore di compilazione con la posizione trovata per
   * diagnostica strutturata; usa la bisezione solo come fallback.
   */
  const describeCompileError = useCallback(async (source, message) => {
    // Le nuove diagnostiche strutturate sono già formattate con riga/colonna:
    // evita una seconda compilazione soltanto per ricavare la stessa posizione.
    if (/\briga\s+\d+/i.test(String(message || ''))) return message;
    const loc = await locateTypstError(source, figuresRef.current);
    return loc
      ? `${message} — L’errore è vicino alla riga ${loc.line}: «${loc.snippet}»`
      : message;
  }, []);

  // Raccoglie i warning di fedeltà dai chunk della sessione corrente.
  const collectFidelity = useCallback(() => {
    const s = sessionRef.current;
    const warns = [];
    s?.chunks?.forEach((c, idx) => {
      if (c.fidelity && c.fidelity.coverage < 0.98 && c.fidelity.missing?.length) {
        warns.push({
          chunk: idx + 1,
          total: s.chunks.length,
          coverage: c.fidelity.coverage,
          missing: c.fidelity.missing,
        });
      }
    });
    setFidelityWarnings(warns);
  }, []);

  /** Compila una sola volta il PDF corrente e lo conserva per il download. */
  const getCompiledPdf = useCallback(async (source) => {
    const cached = compiledPdfRef.current;
    if (cached.source === source && cached.figures === figuresRef.current && hasPdfData(cached.pdf)) {
      return cached.pdf;
    }
    const pdf = await compileToPdf(source, figuresRef.current);
    compiledPdfRef.current = { source, figures: figuresRef.current, pdf };
    releaseDesktopPdf(cached.pdf);
    return pdf;
  }, []);

  /** Compila e pubblica l'anteprima PDF paginata. */
  const compilePreviewPdf = useCallback(async (source) => {
    const bytes = await getCompiledPdf(source);
    setPreviewPdf(bytes);
    return bytes;
  }, [getCompiledPdf]);

  /** Compila e confronta il layer testuale del PDF con la fonte canonica. */
  const verifyStrictPdf = useCallback(async (source, existingBytes = null) => {
    const s = sessionRef.current;
    if (s?.workflow !== 'strict') return existingBytes;
    // Download e riapertura dell'anteprima riusano lo stesso artefatto: non
    // riestrarre centinaia di pagine se questo identico PDF è già verificato.
    if (existingBytes && s.verifiedPdfSource === source && s.verifiedPdfArtifact === existingBytes) {
      return existingBytes;
    }
    s.verified = false;
    const pdfBytes = existingBytes || await compileToPdf(source, figuresRef.current);
    // Il PDF riformattato può avere più pagine dell'input: non applicare qui
    // il limite di ingestione configurato per i PDF sorgente.
    const pdfText = await extractPdfText(pdfBytes);
    if (!pdfText) {
      setStrictReport({
        workflow: 'strict',
        corrections: s.corrections || [],
        ocrComparisons: s.ocrComparisons || [],
        layoutPlan: s.layoutPlan || null,
        pdf: { contentOk: false, unverifiable: true, missing: [], added: [], missingInvariants: [] },
      });
      s.verifiedPdfSource = source;
      s.verifiedPdfArtifact = pdfBytes;
      return pdfBytes;
    }
    const expected = sourcePlainText(s.canonicalText || s.rawText);
    const actual = sourcePlainText(pdfText);
    const sequence = compareTokenSequences(expected, actual);
    const inventory = compareTokenInventory(expected, actual);
    const invariants = missingInvariants(expected, actual);
    // La sequenza può differire perché PDF.js legge tabelle, note o colonne in
    // un ordine visivo diverso. Un'omissione è confermata solo se manca anche
    // dall'inventario complessivo delle occorrenze.
    const issues = buildDifferenceContexts(expected, actual, inventory.missing);
    const issueResolutions = s.strictIssueResolutions || {};
    const coveredMissing = issues.reduce((total, issue) => total + issue.missing.length, 0);
    const allCoveredAsArtifacts =
      inventory.missing.length > 0 &&
      coveredMissing >= inventory.missing.length &&
      issues.every((issue) => issueResolutions[issue.key]?.status === 'artifact');
    const contentOk = invariants.length === 0 &&
      (inventory.missing.length === 0 || allCoveredAsArtifacts);
    let aiReview = [];
    let reviewError = '';
    if (issues.length) {
      const reviewKey = JSON.stringify(issues.map((i) => [i.missing, i.source, i.rendered]));
      if (s.strictReviewKey === reviewKey && Array.isArray(s.strictReview)) {
        aiReview = s.strictReview;
      } else {
        try {
          setDetail('Il modello controlla le frasi discordanti…');
          aiReview = await withRetry(
            () => requestStrictDifferenceReview({ settings, issues, signal: abortRef.current?.signal }),
            abortRef.current?.signal,
            (secs) => setDetail(`Revisione differenze · nuovo tentativo tra ${secs}s…`),
            { max: 2, start: 5000, cap: 20000 },
          );
          s.strictReviewKey = reviewKey;
          s.strictReview = aiReview;
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          reviewError = e.message || 'Revisione AI non disponibile.';
        }
      }
    }
    setStrictReport({
      workflow: 'strict',
      corrections: s.corrections || [],
      ocrComparisons: s.ocrComparisons || [],
      strictIssueResolutions: s.strictIssueResolutions || {},
      layoutPlan: s.layoutPlan || null,
      strictReview: s.strictReview || [],
      strictReviewKey: s.strictReviewKey || null,
      issueResolutions,
      pdf: {
        ...sequence,
        exactOrder: sequence.ok,
        contentOk,
        missing: inventory.missing,
        added: inventory.added,
        missingInvariants: invariants,
        issues,
        aiReview,
        reviewError,
      },
    });
    s.verified = contentOk;
    s.verifiedPdfSource = source;
    s.verifiedPdfArtifact = pdfBytes;
    return pdfBytes;
  }, [settings]);

  // Chiude la revisione figure revocando gli object URL delle miniature.
  const clearReview = useCallback(() => {
    setFigureReview((items) => {
      items?.forEach((i) => URL.revokeObjectURL(i.url));
      return null;
    });
    pendingRef.current = null;
    setPageReview(null);
    pendingPagesRef.current = null;
  }, []);

  // Precarica il WASM di Typst appena montato: rende istantanea la prima
  // compilazione quando la pipeline arriva alla fase 3.
  useEffect(() => {
    initTypst().catch(() => {
      /* l'errore reale emergerà alla prima compilazione con contesto utile */
    });
  }, []);

  // Elenca le sessioni salvate (più recenti prima).
  const refreshSessions = useCallback(async () => {
    const all = await listSessions();
    setSessions(all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  }, []);

  // All'avvio, carica l'elenco delle sessioni salvate.
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Salva su IndexedDB lo stato corrente della sessione (metadati testuali).
  const persist = useCallback(async () => {
    const s = sessionRef.current;
    if (!s?.id) return;
    const allDone =
      s.chunks.every((c) => c.status === 'done') &&
      (s.workflow !== 'strict' || s.verified === true);
    await saveSession({
      id: s.id,
      fileName: s.fileName,
      rawText: s.rawText,
      preamble: s.preamble,
      // Snapshot esatto dell'editor: conserva correzioni locali, sostituzioni
      // e fix di punteggiatura senza dover ricostruire i vecchi chunk.
      editorCode: s.editorCode || null,
      styleHint: s.styleHint || null,
      layoutOptions: s.layoutOptions || null,
      chunks: s.chunks.map((c) => ({
        text: c.text,
        body: c.body,
        status: c.status,
        fidelity: c.fidelity || null,
      })),
      workflow: s.workflow || 'legacy',
      canonicalText: s.canonicalText || null,
      corrections: s.corrections || [],
      ocrComparisons: s.ocrComparisons || [],
      strictIssueResolutions: s.strictIssueResolutions || {},
      verified: !!s.verified,
      layoutPlan: s.layoutPlan || null,
      status: allDone ? 'done' : 'paused',
    });
  }, []);

  // L'editor è la fonte di verità: salva in modo differito anche modifiche
  // manuali e correzioni locali. Prima mancava questo collegamento, quindi la
  // riapertura della sessione ricostruiva il documento dai chunk precedenti.
  useEffect(() => {
    const s = sessionRef.current;
    if (!s?.id || !typstCode.trim()) return undefined;
    s.editorCode = typstCode;
    const timer = setTimeout(() => persist(), 500);
    return () => clearTimeout(timer);
  }, [typstCode, persist]);

  // Salva lo stato della FASE OCR (avanzamento pagine + parti già estratte),
  // così un libro interrotto a metà estrazione riparte da dove era.
  const persistOcr = useCallback(async (status) => {
    const s = sessionRef.current;
    if (!s?.id || !s.ocr) return;
    await saveSession({
      id: s.id,
      fileName: s.fileName,
      status, // 'ocr' (in corso/in pausa) — diventa 'paused'/'done' in fase 2
      ocr: {
        total: s.ocr.total,
        done: s.ocr.done,
        figCount: s.ocr.figCount,
        source: s.ocr.source || 'ocr',
        comparisons: s.ocr.comparisons || [],
      },
      styleHint: s.styleHint || null,
      layoutOptions: s.layoutOptions || null,
    });
  }, []);

  /**
   * Esporta una sessione come progetto portatile versionato. Lo snapshot
   * corrente viene forzato prima di leggere IndexedDB, così anche l’ultima
   * modifica nell’editor entra nell’archivio senza attendere il debounce.
   */
  const exportProject = useCallback(async (summary = null) => {
    setProjectBusy('export');
    try {
      const active = !summary && sessionRef.current;
      const id = summary?.id || active?.id;
      if (!id) throw new Error('Il documento non ha ancora uno stato esportabile.');
      if (active) {
        if (typstCode.trim()) active.editorCode = typstCode;
        if (active.ocr && active.ocr.done < active.ocr.total) await persistOcr('ocr');
        else await persist();
      }
      const session = await getSession(id);
      if (!session) throw new Error('Non riesco a leggere la sessione salvata.');
      // Letture sequenziali: sui libri grandi evita tre picchi IndexedDB
      // concorrenti prima che l'archivio venga costruito.
      const parts = await getParts(id, session.ocr?.total || 0);
      const figures = await getFigures(id);
      const pages = await getPages(id);
      const archive = await createProjectArchive({ session, parts, figures, pages });
      const result = await saveProjectArchive(archive.bytes, archive.fileName);
      return { ...archive.summary, fileName: archive.fileName, cancelled: !!result?.cancelled };
    } finally {
      setProjectBusy(null);
    }
  }, [persist, persistOcr, typstCode]);

  /** Importa una copia indipendente della sessione e restituisce il suo riepilogo. */
  const importProject = useCallback(async (file) => {
    setProjectBusy('import');
    try {
      const archive = await inspectProjectArchive(file);
      let id;
      do {
        id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      } while (await getSession(id));

      const importedAt = new Date().toISOString();
      const session = {
        ...archive.session,
        id,
        fileName: archive.fileName || archive.session.fileName || 'documento',
        importedFrom: {
          sessionId: archive.manifest.document?.sourceSessionId || archive.session.id || null,
          exportedAt: archive.manifest.exportedAt,
          importedAt,
        },
      };
      await saveSession(session);
      // Ricostruisce uno store alla volta per contenere memoria e contesa
      // fra transazioni quando l'archivio è voluminoso.
      await saveParts(id, archive.parts);
      await saveFigures(id, archive.figures);
      await savePageRecords(id, archive.pages);
      const stored = await getSession(id);
      if (!stored) throw new Error('L’importazione non è stata salvata sul dispositivo.');
      await refreshSessions();
      return {
        id,
        fileName: stored.fileName,
        status: stored.status,
        updatedAt: stored.updatedAt,
      };
    } finally {
      setProjectBusy(null);
    }
  }, [refreshSessions]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearReview();
    setPhase('idle');
    setStatus(emptyStatus);
    setActiveStep(null);
    setError(null);
    setRawText('');
    setTypstCode('');
    setLayoutOptions(DEFAULT_LAYOUT_OPTIONS);
    setPreviewPdf(null);
    setCompileError(null);
    setDetail('');
    setChunkProgress(null);
    setOcrProgress(null);
    setCanResume(false);
    setFidelityWarnings([]);
    setStrictReport(null);
    setSpellReport(null);
    figuresRef.current = [];
    releaseDesktopPdf(compiledPdfRef.current.pdf);
    compiledPdfRef.current = { source: '', figures: null, pdf: null };
    sessionRef.current = null;
    refreshSessions(); // riallinea l'elenco al ritorno sulla home
  }, [refreshSessions, clearReview]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Elabora i chunk della sessione con Gemini, uno alla volta, preservando
   * preambolo e gerarchia. Ritorna 'done' | 'error' | 'aborted'. In caso di
   * errore (es. rate limit) i chunk completati restano: la sessione è
   * ripristinabile con `resume`.
   */
  // Genera Typst dal testo OCR usando il motore scelto (Gemini o un modello
  // NVIDIA), con auto-retry sul rate limit (429/quota) e backoff esponenziale:
  // così documenti lunghi/libri si convertono "lentamente" senza intervento
  // manuale. Gli altri errori si propagano subito. `args` è neutro rispetto al
  // motore (rawText, styleHint, continuation): le credenziali/modello vengono
  // aggiunte qui in base alle impostazioni.
  const callGeminiWithRetry = useCallback(
    async (args, signal, chunkLabel) => {
      const nvidia = settings.typstEngine === 'nvidia';
      const call = () =>
        settings.typstEngine === 'local'
          ? toTypstLocal({
              settings,
              rawText: args.rawText,
              styleHint: args.styleHint,
              continuation: args.continuation,
              fidelityNote: args.fidelityNote,
              fixTypos: settings.fixTypos,
              docContext: settings.docContext,
              signal,
            })
          : nvidia
          ? toTypstNvidia({
              apiKey: settings.nvidiaApiKey,
              endpoint: settings.nvidiaEndpoint,
              model: settings.nvidiaTypstModel,
              rawText: args.rawText,
              styleHint: args.styleHint,
              continuation: args.continuation,
              fidelityNote: args.fidelityNote,
              fixTypos: settings.fixTypos,
              docContext: settings.docContext,
              signal,
            })
          : toTypst({
              apiKey: settings.googleApiKey,
              model: settings.geminiTypstModel,
              rawText: args.rawText,
              styleHint: args.styleHint,
              continuation: args.continuation,
              fidelityNote: args.fidelityNote,
              fixTypos: settings.fixTypos,
              docContext: settings.docContext,
              signal,
            });
      return withRetry(call, signal, (secs) =>
        setDetail(`${chunkLabel} · servizio occupato: nuovo tentativo tra ${secs}s…`),
      );
    },
    [settings],
  );

  const processChunks = useCallback(
    async (signal) => {
      const s = sessionRef.current;
      const total = s.chunks.length;
      for (let i = 0; i < total; i++) {
        const ch = s.chunks[i];
        const doneCount = s.chunks.filter((c) => c.status === 'done').length;
        setChunkProgress(total > 1 ? { done: doneCount, total } : null);
        if (ch.status === 'done') continue;
        const label = total > 1 ? `Layout: chunk ${i + 1}/${total}` : 'Formattazione';
        setDetail(total > 1 ? `${label}…` : '');
        try {
          const continuation =
            i > 0
              ? {
                  preamble: s.preamble,
                  outline: outlineFromBody(
                    s.chunks.slice(0, i).map((c) => c.body).filter(Boolean).join('\n\n'),
                  ),
                }
              : undefined;

          // Un tentativo di conversione + verifica di fedeltà deterministica
          // (ogni frase del sorgente deve comparire nell'output).
          const attempt = async (fidelityNote) => {
            const code = await callGeminiWithRetry(
              { rawText: ch.text, styleHint: s.styleHint, continuation, fidelityNote },
              signal,
              label,
            );
            let preamble = s.preamble;
            let body = code;
            if (i === 0) ({ preamble, body } = splitPreamble(code));
            // Impone in modo deterministico i livelli di titolo del sorgente
            // e la larghezza delle figure dal bbox reale.
            body = enforceHeadingLevels(body, ch.text);
            body = applyFigureWidths(body, figuresRef.current);
            return { preamble, body, fid: checkFidelity(ch.text, body) };
          };

          // Multipasso: se la copertura è bassa si ri-prompta elencando i
          // passaggi omessi; si tiene il tentativo con la copertura migliore.
          let best = await attempt();
          for (let r = 0; r < 2 && best.fid.coverage < 0.9 && best.fid.missing.length; r++) {
            setDetail(
              `${label} · fedeltà ${Math.round(best.fid.coverage * 100)}%: ` +
                `richiedo i passaggi mancanti (tentativo ${r + 2})…`,
            );
            const again = await attempt(fidelityNoteFrom(best.fid.missing));
            if (again.fid.coverage > best.fid.coverage) best = again;
          }

          if (i === 0) s.preamble = best.preamble;
          ch.body = best.body;
          ch.fidelity = {
            coverage: best.fid.coverage,
            missing: best.fid.missing.slice(0, 8),
          };
          ch.status = 'done';
          // Aggiorna progressivamente l'editor e salva i progressi.
          setTypstCode(combineDocument(s.preamble, s.chunks.map((c) => c.body || '')));
          await persist();
        } catch (e) {
          if (signal.aborted || e?.name === 'AbortError') return 'aborted';
          ch.status = 'error';
          s.lastError = e.message || 'Errore Gemini.';
          await persist();
          return 'error';
        }
      }
      setChunkProgress(null);
      return 'done';
    },
    [settings, callGeminiWithRetry, persist],
  );

  /** Compila il documento combinato e chiude la pipeline. */
  const finalizeCompile = useCallback(
    async (signal) => {
      const s = sessionRef.current;
      let finalSource = ensureExplicitHyphenation(
        combineDocument(s.preamble, s.chunks.map((c) => c.body || '')),
      );
      setTypstCode(finalSource);
      setStatus((x) => ({ ...x, format: 'done', compile: 'active' }));
      setActiveStep('compile');
      setDetail('');
      collectFidelity();
      try {
        const renderFinal = async (source) => {
          const pdfBytes = await getCompiledPdf(source);
          if (s.workflow === 'strict') {
            setDetail('Verifica testuale del PDF compilato…');
            await verifyStrictPdf(source, pdfBytes);
            if (signal.aborted) return null;
          }
          return pdfBytes;
        };

        let pdfBytes;
        try {
          pdfBytes = await renderFinal(finalSource);
        } catch (initialError) {
          if (signal.aborted || initialError?.name === 'AbortError') return;
          setDetail('Correzione locale guidata dal compilatore…');
          const repaired = await repairTypstDeterministically({
            source: finalSource,
            diagnose: (candidate) => diagnoseTypst(candidate, figuresRef.current),
            signal,
          });
          if (repaired.fixed !== finalSource) {
            finalSource = repaired.fixed;
            s.editorCode = finalSource;
            setTypstCode(finalSource);
          }
          if (!repaired.ok) {
            const first = repaired.diagnostics.find((diag) => diag.severity === 'error') || repaired.diagnostics[0];
            const error = new Error(first?.message || repaired.error || initialError.message);
            error.location = first;
            throw error;
          }
          pdfBytes = await renderFinal(finalSource);
        }
        if (signal.aborted) return;
        setPreviewPdf(pdfBytes);
        setStatus((x) => ({ ...x, compile: 'done' }));
        setActiveStep(null);
        setPhase('done');
        persist(); // segna la sessione come completata
      } catch (e) {
        if (signal.aborted) return;
        // Errore di compilazione Typst: non fatale, l'editor resta usabile.
        setStatus((x) => ({ ...x, compile: 'error' }));
        const message = e.message || 'Errore di compilazione Typst.';
        setCompileError(e.location?.line
          ? `${message} — L’errore è vicino alla riga ${e.location.line}${
              e.location.column ? `, colonna ${e.location.column}` : ''
            }.`
          : await describeCompileError(finalSource, message));
        setActiveStep(null);
        setPhase('done');
      }
    },
    [persist, collectFidelity, describeCompileError, getCompiledPdf, verifyStrictPdf],
  );

  /** Esegue la fase 2+3 sulla sessione corrente (fresh o resume). */
  const runFormat = useCallback(
    async (signal) => {
      const r = await processChunks(signal);
      if (r === 'aborted') return;
      if (r === 'error') {
        collectFidelity(); // mostra comunque l'esito dei chunk completati
        setStatus((x) => ({ ...x, format: 'error' }));
        setCanResume(true);
        setDetail('');
        setActiveStep(null);
        setError(
          `Elaborazione interrotta: ${sessionRef.current.lastError} · I chunk ` +
            'completati sono stati mantenuti. Attendi qualche minuto e premi “Riprendi”.',
        );
        setPhase('error');
        return;
      }
      await finalizeCompile(signal);
    },
    [processChunks, finalizeCompile, collectFidelity],
  );

  /**
   * Fase 2+3 su un testo pronto: crea la sessione a chunk, la persiste e avvia
   * la formattazione. Riusa l'id della sessione OCR corrente (transizione dalla
   * fase OCR alla fase formato sotto lo stesso id), così l'elenco non duplica.
   */
  const startFormat = useCallback(
    async (extracted, fileName, signal) => {
      const id = sessionRef.current?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (settings.formatWorkflow === 'strict') {
        let speller = null;
        try {
          speller = await loadSpeller();
        } catch {
          // Il dizionario migliora i tagli dentro una parola, ma la pipeline
          // resta operativa anche se le risorse locali non sono disponibili.
        }
        let preparedExtracted = extracted;
        const intraWordCorrections = [];
        if (speller) {
          const repairedWords = fixOcrHyphenation(preparedExtracted, speller);
          preparedExtracted = repairedWords.fixed;
          intraWordCorrections.push(...repairedWords.changes.map((description) => {
            const [before, after] = description.split('→');
            return { type: 'ocr_word_split', before, after, overlap: '' };
          }));
        }
        const boundaryRepair = repairBoundaryOverlaps(
          preparedExtracted,
          10,
          speller ? (word) => speller.correct(word) : null,
        );
        let canonicalText = boundaryRepair.text;
        let corrections = [...intraWordCorrections, ...boundaryRepair.changes];
        if (settings.fixTypos) {
          setDetail('Correzione conservativa con registro delle modifiche…');
          const proof = await proofreadBody({
            settings,
            // Non ripartire dal testo originale: altrimenti la rilettura
            // annulla silenziosamente le riparazioni tra pagine appena fatte.
            code: canonicalText,
            speller,
            signal,
            onProgress: (done, total) => setDetail(`Correzione ${done}/${total} paragrafi…`),
          });
          canonicalText = proof.code;
          corrections = [...corrections, ...proof.changes];
        }
        setDetail('Il modello progetta il layout senza riscrivere il testo…');
        const layoutPlan = await withRetry(
          () => requestStrictLayoutPlan({ settings, markdown: canonicalText, signal }),
          signal,
          (secs) => setDetail(`Pianificazione layout · nuovo tentativo tra ${secs}s…`),
        );
        const strict = buildStrictDocument(canonicalText, layoutPlan);
        const previousComparisons = sessionRef.current?.ocr?.comparisons || [];
        sessionRef.current = {
          id,
          fileName,
          rawText: extracted,
          canonicalText,
          corrections,
          ocrComparisons: previousComparisons,
          strictIssueResolutions: {},
          layoutPlan,
          workflow: 'strict',
          verified: false,
          chunks: [{
            text: extracted,
            body: strict.body,
            status: 'done',
            fidelity: { coverage: 1, missing: [] },
          }],
          preamble: strict.preamble,
          styleHint: undefined,
          lastError: '',
        };
        setStrictReport({
          workflow: 'strict',
          corrections,
          ocrComparisons: previousComparisons,
          layoutPlan,
          pdf: null,
        });
        setTypstCode(combineDocument(strict.preamble, [strict.body]));
        await saveFigures(id, figuresRef.current);
        await persist();
        setPhase('running');
        setActiveStep('compile');
        setStatus((s) => ({ ...s, format: 'done', compile: 'active' }));
        await finalizeCompile(signal);
        return;
      }
      sessionRef.current = {
        id,
        fileName,
        rawText: extracted,
        chunks: chunkDocument(extracted, settings.chunkSize).map((t) => ({
          text: t,
          body: '',
          status: 'pending',
        })),
        preamble: '',
        styleHint: undefined,
        lastError: '',
        workflow: 'legacy',
      };
      await saveFigures(id, figuresRef.current);
      await persist();
      setPhase('running');
      setActiveStep('format');
      setStatus((s) => ({ ...s, format: 'active' }));
      await runFormat(signal);
    },
    [settings, runFormat, persist, finalizeCompile],
  );

  /**
   * Esegue/riprende la FASE OCR sulla sessione corrente (sessionRef.ocr).
   * Estrae pagina per pagina con auto-retry sul rate limit, salvando dopo OGNI
   * pagina: un libro interrotto (quota esaurita o app chiusa) riparte da dove
   * era, senza rifare le pagine già estratte. Ritorna 'done'|'error'|'aborted'.
   * @param {Map<number,string>} [pagesInMemory] pagine della run fresca; in
   *        ripresa vengono lette dalla cache su IndexedDB.
   */
  const runOcr = useCallback(
    async (signal, pagesInMemory) => {
      const s = sessionRef.current;
      const total = s.ocr.total;
      const figCounter = makeFigureCounter(s.ocr.figCount || 0);
      // In ripresa le pagine si leggono UNA per volta dalla cache: caricarle
      // tutte insieme terrebbe in RAM l'intero libro rasterizzato (centinaia
      // di MB su un volume di 250 pagine) e fa uccidere la WebView.
      const pageAt = (i) =>
        pagesInMemory ? pagesInMemory.get(i) : getPage(s.id, i);
      for (let i = s.ocr.done; i < total; i++) {
        setOcrProgress({ done: i, total });
        const label = total > 1 ? `OCR pagina ${i + 1}/${total}` : 'Estrazione testo';
        setDetail(total > 1 ? `${label}…` : '');
        const dataUrl = await pageAt(i);
        if (!dataUrl) {
          s.lastError = `Immagine della pagina ${i + 1} non più disponibile.`;
          await persistOcr('ocr');
          return 'error';
        }
        try {
          const onWait = (secs) =>
            setDetail(`${label} · servizio occupato: nuovo tentativo tra ${secs}s…`);
          // Gemini (vision): trascrizione Markdown, nessuna figura/bbox.
          // NVIDIA (Nemotron-Parse): blocchi strutturati con bbox e figure.
          // 'local': sidecar sulla macchina dell'utente (Nemotron OCR v2).
          // 'gemini': trascrizione multimodale, un blocco senza bbox.
          // 'nvidia': blocchi strutturati con bbox, figure e classi semantiche.
          const blocks =
            settings.ocrEngine === 'local'
              ? await withRetry(
                  () =>
                    localOcrBlocks({
                      endpoint: settings.localOcrEndpoint,
                      imageDataUrl: dataUrl,
                      signal,
                    }),
                  signal,
                  onWait,
                )
              : settings.ocrEngine === 'gemini'
              ? [
                  {
                    type: 'Text',
                    bbox: null,
                    text: await withRetry(
                      () =>
                        ocrImageGemini({
                          apiKey: settings.googleApiKey,
                          model: settings.geminiOcrModel,
                          imageDataUrl: dataUrl,
                          signal,
                        }),
                      signal,
                      onWait,
                    ),
                  },
                ]
              : await withRetry(
                  () =>
                    extractPageBlocks({
                      apiKey: settings.nvidiaApiKey,
                      endpoint: settings.nvidiaEndpoint,
                      model: settings.nvidiaModel,
                      imageDataUrl: dataUrl,
                      signal,
                    }),
                  signal,
                  onWait,
                );
          if (signal.aborted) return 'aborted';
          // Riparsing delle tabelle a livello di regione: righe e colonne
          // esistono solo nell'IMMAGINE, non nel testo linearizzato dall'OCR.
          // È un raffinamento: qualunque errore lascia il blocco com'era.
          let pageBlocks = blocks;
          if (settings.refineTables) {
            const res = await refinePageTables({
              blocks,
              pageDataUrl: dataUrl,
              settings,
              signal,
              onProgress: (n, tot) => setDetail(`${label} · tabella ${n}/${tot}…`),
            });
            pageBlocks = res.blocks;
            if (res.refined) s.ocr.tablesRefined = (s.ocr.tablesRefined || 0) + res.refined;
          }
          if (signal.aborted) return 'aborted';
          const page = await assemblePage(pageBlocks, dataUrl, figCounter);
          if (settings.formatWorkflow === 'strict' && settings.compareOcr) {
            if (!Array.isArray(s.ocr.comparisons)) s.ocr.comparisons = [];
            setDetail(`${label} · confronto con il secondo motore…`);
            try {
              let alternateText;
              if (settings.ocrEngine === 'gemini') {
                const altBlocks = await withRetry(
                  () => extractPageBlocks({
                    apiKey: settings.nvidiaApiKey,
                    endpoint: settings.nvidiaEndpoint,
                    model: settings.nvidiaModel,
                    imageDataUrl: dataUrl,
                    signal,
                  }),
                  signal,
                  onWait,
                );
                alternateText = (await assemblePage(altBlocks, dataUrl, makeFigureCounter(0))).markdown;
              } else {
                alternateText = await withRetry(
                  () => ocrImageGemini({
                    apiKey: settings.googleApiKey,
                    model: settings.geminiOcrModel,
                    imageDataUrl: dataUrl,
                    signal,
                  }),
                  signal,
                  onWait,
                );
              }
              const cmp = compareTokenSequences(
                sourcePlainText(page.markdown),
                sourcePlainText(alternateText),
                12,
              );
              s.ocr.comparisons[i] = {
                page: i + 1,
                primary: settings.ocrEngine,
                alternate: settings.ocrEngine === 'gemini' ? 'nvidia' : 'gemini',
                agreement: cmp.sourceCount
                  ? cmp.matched / Math.max(cmp.sourceCount, cmp.outputCount, 1)
                  : 1,
                missing: cmp.missing,
                added: cmp.added,
              };
            } catch (comparisonError) {
              if (signal.aborted || comparisonError?.name === 'AbortError') return 'aborted';
              s.ocr.comparisons[i] = {
                page: i + 1,
                primary: settings.ocrEngine,
                alternate: settings.ocrEngine === 'gemini' ? 'nvidia' : 'gemini',
                error: comparisonError.message || 'Confronto OCR non disponibile.',
              };
            }
          }
          s.ocr.parts[i] = total > 1 ? `<!-- pagina ${i + 1} -->\n${page.markdown}` : page.markdown;
          s.ocr.figCount = figCounter.count();
          figuresRef.current.push(...page.figures);
          await saveFigures(s.id, page.figures);
          s.ocr.done = i + 1;
          // Solo la parte appena estratta: il record di sessione porta ormai i
          // soli contatori, quindi il salvataggio è costante per pagina.
          await savePart(s.id, i, s.ocr.parts[i]);
          await persistOcr('ocr');
          await deletePage(s.id, i);
        } catch (e) {
          if (signal.aborted || e?.name === 'AbortError') return 'aborted';
          s.lastError = e.message || 'Errore di estrazione OCR.';
          await persistOcr('ocr');
          return 'error';
        }
      }
      setOcrProgress({ done: total, total });
      return 'done';
    },
    [settings, persistOcr],
  );

  /**
   * OCR completato: libera le pagine in cache, ricompone il testo estratto
   * (gerarchia normalizzata) e apre la revisione figure — o avvia la fase 2 se
   * non ci sono figure.
   */
  const finishOcr = useCallback(
    async (signal) => {
      const s = sessionRef.current;
      await deletePagesFor(s.id);
      const extracted = normalizeHeadingLevels(s.ocr.parts.filter(Boolean).join('\n\n'));
      s.rawText = extracted;
      setRawText(extracted);
      setStatus((x) => ({ ...x, ocr: 'done' }));
      setOcrProgress(null);
      setDetail('');
      const figures = figuresRef.current;
      if (figures.length) {
        pendingRef.current = { extracted, fileName: s.fileName };
        setFigureReview(
          figures.map((f) => ({
            path: f.path,
            url: URL.createObjectURL(new Blob([f.bytes], { type: 'image/png' })),
            junk: !!f.junk,
            keep: !f.junk,
          })),
        );
        setActiveStep(null);
        setDetail('Scegli le immagini da tenere, poi premi Continua.');
        setPhase('review');
        return;
      }
      await startFormat(extracted, s.fileName, signal);
    },
    [startFormat],
  );

  /** Esegue/riprende la fase OCR e, se completa, prosegue con la fase 2. */
  const runOcrPhase = useCallback(
    async (signal, pagesInMemory) => {
      setStatus((x) => ({ ...x, ocr: 'active' }));
      setActiveStep('ocr');
      const r = await runOcr(signal, pagesInMemory);
      if (r === 'aborted') return;
      if (r === 'error') {
        setStatus((x) => ({ ...x, ocr: 'error' }));
        setCanResume(true);
        setActiveStep(null);
        setDetail('');
        setError(
          `Estrazione interrotta: ${sessionRef.current.lastError} · Le pagine già ` +
            'estratte sono state salvate. Attendi qualche minuto e premi “Riprendi”.',
        );
        setPhase('error');
        return;
      }
      await finishOcr(signal);
    },
    [runOcr, finishOcr],
  );

  /**
   * Crea la sessione in FASE OCR: mette in cache le immagini di pagina (per
   * la ripresa) e avvia l'estrazione pagina per pagina.
   */
  const beginOcrSession = useCallback(
    async (pageImages, fileName, signal) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      sessionRef.current = {
        id,
        fileName,
        ocr: {
          total: pageImages.length,
          done: 0,
          parts: new Array(pageImages.length).fill(null),
          figCount: 0,
          source: 'ocr',
          comparisons: new Array(pageImages.length).fill(null),
        },
        styleHint: undefined,
        lastError: '',
      };
      if (pageImages.length > 1) setDetail('Preparazione ripresa…');
      await savePages(id, pageImages, (n, t) => {
        if (t > 1) setDetail(`Preparazione ripresa… ${n}/${t}`);
      });
      await persistOcr('ocr');
      // Le pagine sono ora su IndexedDB: liberare l'array evita di tenere in
      // RAM l'intero libro rasterizzato mentre l'OCR procede pagina per pagina
      // (le rilegge una alla volta, che è l'unico modo in cui le usa).
      pageImages.length = 0;
      await runOcrPhase(signal);
    },
    [persistOcr, runOcrPhase],
  );

  /**
   * Conferma dell'anteprima pagine: applica rotazioni e divisioni delle
   * doppie pagine, poi avvia l'estrazione OCR.
   * @param {{rotate:number, split:boolean}[]} edits una voce per pagina
   */
  const confirmPages = useCallback(
    async (edits) => {
      const pending = pendingPagesRef.current;
      if (!pending) return;
      pendingPagesRef.current = null;
      setPageReview(null);
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('running');
      setActiveStep('ocr');
      setStatus((x) => ({ ...x, ocr: 'active' }));
      try {
        const hasEdits = edits?.some((e) => e.rotate || e.split);
        if (hasEdits) setDetail('Applico rotazioni e divisioni…');
        const finalPages = await preparePages(pending.pageImages, edits, (n, t) => {
          if (hasEdits) setDetail(`Preparo le pagine ${n}/${t}…`);
        });
        if (controller.signal.aborted) return;
        await beginOcrSession(finalPages, pending.fileName, controller.signal);
      } catch (e) {
        if (controller.signal.aborted || e?.name === 'AbortError') return;
        setError(e.message || 'Errore nella preparazione delle pagine.');
        setPhase('error');
      }
    },
    [beginOcrSession],
  );

  /** Riprende la sessione corrente interrotta (fase OCR o fase formato). */
  const resume = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setCanResume(false);
    setPhase('running');
    // Fase OCR ancora incompleta → riprendi l'estrazione dalle pagine in cache.
    if (s.ocr && s.ocr.done < s.ocr.total) {
      await runOcrPhase(controller.signal);
      return;
    }
    if (!s.chunks?.length) return;
    s.chunks.forEach((c) => {
      if (c.status === 'error') c.status = 'pending';
    });
    setActiveStep('format');
    setStatus((x) => ({ ...x, format: 'active' }));
    await runFormat(controller.signal);
  }, [runFormat, runOcrPhase]);

  /** Riprende una sessione salvata su IndexedDB (dopo chiusura dell'app). */
  const openSession = useCallback(
    async (summary) => {
      if (!summary) return null;
      // L'elenco in home porta ora solo il riepilogo (niente testo dei
      // documenti): il record completo si legge qui, all'apertura.
      const meta = (await getSession(summary.id)) || summary;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setCompileError(null);
      setCanResume(false);

      // Sessione ancora in fase OCR (estrazione incompleta): riprendi le
      // pagine mancanti dalla cache, senza rifare quelle già estratte.
      if (meta.ocr && meta.ocr.done < meta.ocr.total) {
        figuresRef.current = await getFigures(meta.id);
        sessionRef.current = {
          id: meta.id,
          fileName: meta.fileName,
          ocr: {
            total: meta.ocr.total,
            done: meta.ocr.done,
            parts: await getParts(meta.id, meta.ocr.total),
            figCount: meta.ocr.figCount || 0,
            source: meta.ocr.source || 'ocr',
            comparisons: meta.ocr.comparisons || new Array(meta.ocr.total).fill(null),
          },
          styleHint: meta.styleHint || undefined,
          layoutOptions: normalizeLayoutOptions(meta.layoutOptions || {}),
          lastError: '',
        };
        setRawText('');
        setTypstCode('');
        setLayoutOptions(normalizeLayoutOptions(meta.layoutOptions || {}));
        setStatus({ ocr: 'active', format: 'pending', compile: 'pending' });
        setOcrProgress({ done: meta.ocr.done, total: meta.ocr.total });
        setPhase('running');
        await runOcrPhase(controller.signal);
        return meta;
      }

      // Fase formato: riprendi dai chunk non completati.
      figuresRef.current = await getFigures(meta.id);
      sessionRef.current = {
        id: meta.id,
        fileName: meta.fileName,
        rawText: meta.rawText,
        chunks: (meta.chunks || []).map((c) => ({ ...c })),
        preamble: meta.preamble || '',
        styleHint: meta.styleHint || undefined,
        layoutOptions: normalizeLayoutOptions(meta.layoutOptions || {}),
        lastError: '',
        workflow: meta.workflow || 'legacy',
        canonicalText: meta.canonicalText || meta.rawText,
        corrections: meta.corrections || [],
        ocrComparisons: meta.ocrComparisons || [],
        layoutPlan: meta.layoutPlan || null,
        strictReview: meta.strictReview || [],
        strictReviewKey: meta.strictReviewKey || null,
        strictIssueResolutions: meta.strictIssueResolutions || {},
        verified: meta.verified === true,
      };
      setRawText(meta.rawText || '');
      setLayoutOptions(normalizeLayoutOptions(meta.layoutOptions || {}));
      const restoredCode = ensureExplicitHyphenation(
        meta.editorCode || combineDocument(meta.preamble || '', (meta.chunks || []).map((c) => c.body || '')),
      );
      sessionRef.current.editorCode = restoredCode;
      if (meta.editorCode) {
        // Evita che runFormat ricostruisca subito il vecchio contenuto dai
        // chunk e annulli lo snapshot appena ripristinato dall'editor.
        const restored = splitPreamble(restoredCode);
        sessionRef.current.preamble = restored.preamble;
        sessionRef.current.chunks = [{
          text: meta.rawText || '',
          body: restored.body,
          status: 'done',
          fidelity: { coverage: 1, missing: [] },
        }];
      }
      setTypstCode(restoredCode);
      setStrictReport(
        meta.workflow === 'strict'
          ? {
              workflow: 'strict',
              corrections: meta.corrections || [],
              ocrComparisons: meta.ocrComparisons || [],
              layoutPlan: meta.layoutPlan || null,
              issueResolutions: meta.strictIssueResolutions || {},
              pdf: null,
            }
          : null,
      );
      setStatus({ ocr: 'done', format: 'active', compile: 'pending' });
      setPhase('running');
      setActiveStep('format');
      sessionRef.current.chunks.forEach((c) => {
        if (c.status === 'error') c.status = 'pending';
      });
      await runFormat(controller.signal);
      return meta;
    },
    [runFormat, runOcrPhase],
  );

  /** Elimina una sessione salvata (per id) e aggiorna l'elenco. */
  const deleteSavedSession = useCallback(
    async (id) => {
      await deleteSession(id);
      await refreshSessions();
    },
    [refreshSessions],
  );

  /** Compila localmente il codice Typst corrente in PDF. */
  const recompile = useCallback(
    async (sourceOverride) => {
      const source = sourceOverride ?? typstCode;
      if (!source.trim()) return;
      setCompiling(true);
      setCompileError(null);
      try {
        // Lascia un frame per mostrare lo stato di caricamento prima di
        // invocare il processo desktop o, sul web, il compilatore WASM.
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const pdfBytes = await getCompiledPdf(source);
        if (sessionRef.current?.workflow === 'strict') await verifyStrictPdf(source, pdfBytes);
        setPreviewPdf(pdfBytes);
        return true;
      } catch (e) {
        setCompileError(
          await describeCompileError(source, e.message || 'Errore di compilazione Typst.'),
        );
        return false;
      } finally {
        setCompiling(false);
      }
    },
    [typstCode, describeCompileError, getCompiledPdf, verifyStrictPdf],
  );

  /**
   * Localizza nell'anteprima PDF l'occorrenza selezionata nell'editor. Il
   * layer testuale di pdf.js sostituisce la vecchia ricompilazione di un SVG
   * completo con una parola evidenziata.
   */
  const previewSearchMatch = useCallback(
    async (match) => {
      const requestId = ++searchPreviewRef.current;
      if (!match) return null;
      if (!typstCode.trim() || !hasPdfData(previewPdf)) return false;
      const target = createPdfSearchTarget(typstCode, match);
      if (requestId !== searchPreviewRef.current) return false;
      return target || false;
    },
    [previewPdf, typstCode],
  );

  /**
   * Compila il PDF (on-demand) e lo consegna.
   * @param {string} fileName
   * @param {'save'|'share'} [mode] su nativo: 'save' apre il "Salva con nome"
   *        di sistema (scelta cartella/nome), 'share' il foglio di
   *        condivisione. Sul web entrambe scaricano il file.
   */
  const downloadPdf = useCallback(
    async (fileName, mode = 'save') => {
      if (!typstCode.trim()) return;
      setDownloading(true);
      setCompileError(null);
      try {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        let bytes = await getCompiledPdf(typstCode);
        bytes = await verifyStrictPdf(typstCode, bytes);
        if (mode === 'share') await sharePdf(bytes, fileName || 'documento');
        else await savePdf(bytes, fileName || 'documento');
      } catch (e) {
        setCompileError(e.message || 'Errore nella generazione del PDF.');
      } finally {
        setDownloading(false);
      }
    },
    [getCompiledPdf, typstCode, verifyStrictPdf],
  );

  /**
   * Applica LOCALMENTE (senza AI) le scelte di impaginazione: ricostruisce il
   * preambolo Typst dalle selezioni e lo sostituisce nel documento corrente,
   * poi ricompila. Nessuna chiamata all'LLM → nessun rate limit.
   */
  const applyLocalStyle = useCallback(
    async (sel) => {
      if (!typstCode.trim()) return false;
      const { body } = splitPreamble(typstCode);
      const normalized = normalizeLayoutOptions(sel);
      const preamble = buildPreamble(normalized, { title: extractTitle(body) });
      const next = combineDocument(preamble, [body]);
      setTypstCode(next);
      setLayoutOptions(normalized);
      // salva anche nel corpo della sessione (se attiva) per la persistenza
      if (sessionRef.current) {
        sessionRef.current.preamble = preamble;
        sessionRef.current.layoutOptions = normalized;
      }
      return recompile(next);
    },
    [typstCode, recompile],
  );

  /**
   * Correzione automatica degli errori Typst comuni (titoli Markdown, funzioni
   * inesistenti, font non disponibili, `<` non chiusi). Ricompila e ritorna
   * l'elenco delle modifiche.
   */
  const autofix = useCallback(async () => {
    if (!typstCode.trim()) return { changes: [] };
    setCompiling(true);
    try {
      const repaired = await repairTypstDeterministically({
        source: typstCode,
        diagnose: (code) => diagnoseTypst(code, figuresRef.current),
      });
      setTypstCode(repaired.fixed);
      if (repaired.ok) {
        await compilePreviewPdf(repaired.fixed);
        setCompileError(null);
        return { changes: repaired.changes, ok: true };
      }
      const first = repaired.diagnostics.find((diag) => diag.severity === 'error') || repaired.diagnostics[0];
      const message = first?.message || repaired.error || 'Errore di compilazione Typst.';
      setCompileError(
        first?.line
          ? `${message} — L’errore è vicino alla riga ${first.line}${first.column ? `, colonna ${first.column}` : ''}.`
          : await describeCompileError(repaired.fixed, message),
      );
      return { changes: repaired.changes, ok: false };
    } finally {
      setCompiling(false);
    }
  }, [compilePreviewPdf, typstCode, describeCompileError]);

  /**
   * Correzione AI puntiforme: compila → se fallisce chiede al modello forte
   * (fixEngine/fixModel) le sostituzioni minime {find, replace}, le applica e
   * ricompila; fino a 8 estratti locali. Prima di ogni richiesta esaurisce il
   * motore deterministico (gratuito) e valida ogni patch col compilatore.
   * Il documento non viene MAI riscritto per intero: solo sostituzioni esatte.
   * @returns {Promise<{ok:boolean, message:string}>}
   */
  const aiFix = useCallback(async () => {
    if (!typstCode.trim()) return { ok: false, message: 'Nessun codice da correggere.' };
    // NB: l'errore corrente NON viene azzerato qui: il banner resta visibile
    // con lo spinner «Correggo…» finché non c'è un esito (fix o errore nuovo).
    setAiFixing(true);
    let code = typstCode;
    const log = [];
    const attemptedErrors = new Set();
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      let lastError = '';
      let lastDiagnostics = [];
      // Ogni richiesta vede soltanto il blocco localizzato; otto passaggi
      // restano gestibili anche per un libro con molti errori indipendenti.
      for (let round = 0; round < 8; round++) {
        const local = await repairTypstDeterministically({
          source: code,
          diagnose: (candidate) => diagnoseTypst(candidate, figuresRef.current),
          signal: controller.signal,
        });
        code = local.fixed;
        for (const change of local.changes) {
          if (!log.includes(change)) log.push(change);
        }
        setTypstCode(code);
        if (local.ok) {
          await compilePreviewPdf(code);
          setCompileError(null); // risolto: ora il banner può sparire
          return {
            ok: true,
            message: log.length
              ? `Corretto e compilato. Modifiche: ${summarizeFixLog(log)}`
              : 'Il codice compila già, nessuna correzione necessaria.',
          };
        }

        lastDiagnostics = local.diagnostics;
        const first = local.diagnostics.find((diag) => diag.severity === 'error') || local.diagnostics[0];
        lastError = first?.message || local.error || 'Errore di compilazione Typst.';
        const loc = first?.line
          ? {
              line: first.line,
              column: first.column,
              endLine: first.endLine,
              endColumn: first.endColumn,
              message: first.message,
              snippet: code.split('\n').slice(Math.max(0, first.line - 2), first.line + 1).join(' ').trim().slice(0, 140),
            }
          : await locateTypstError(code, figuresRef.current);
        const fingerprint = `${lastError}|${loc?.line || 0}|${loc?.snippet || ''}`;
        if (attemptedErrors.has(fingerprint)) break;
        attemptedErrors.add(fingerprint);

        const res = await requestTypstFix({
          settings,
          code,
          error: lastError,
          hint: loc,
          signal: controller.signal,
        });
        const patched = applyFixes(code, res.fixes, { scope: res.scope });
        if (!patched.applied.length || patched.code === code) {
          setCompileError(
            loc?.line ? `${lastError} — L’errore è vicino alla riga ${loc.line}.` : lastError,
          );
          return {
            ok: false,
            message:
              'L’AI non ha prodotto correzioni applicabili nell’estratto localizzato' +
              (res.explanation ? ` (${res.explanation})` : '.'),
          };
        }

        const before = { ok: false, diagnostics: local.diagnostics };
        let accepted = patched;
        let checked = await diagnoseTypst(patched.code, figuresRef.current);
        // Se il gruppo di patch non migliora la diagnostica, prova le singole
        // sostituzioni: evita che una proposta secondaria regressiva annulli
        // una correzione principale valida.
        if (!diagnosticProgress(before, checked)) {
          accepted = null;
          for (const fix of res.fixes || []) {
            const single = applyFixes(code, [fix], { scope: res.scope });
            if (!single.applied.length) continue;
            const singleCheck = await diagnoseTypst(single.code, figuresRef.current);
            if (diagnosticProgress(before, singleCheck)) {
              accepted = single;
              checked = singleCheck;
              break;
            }
          }
        }
        if (!accepted) {
          setCompileError(
            loc?.line ? `${lastError} — L’errore è vicino alla riga ${loc.line}.` : lastError,
          );
          return {
            ok: false,
            message: 'Le patch AI sono state scartate perché non miglioravano la diagnostica del compilatore.',
          };
        }
        code = accepted.code;
        setTypstCode(code);
        if (res.explanation && !log.includes(res.explanation)) log.push(res.explanation);
        log.push(...accepted.applied.map(describeFix));
        lastDiagnostics = checked.diagnostics || [];
      }
      const first = lastDiagnostics.find((diag) => diag.severity === 'error') || lastDiagnostics[0];
      const described = first?.line
        ? `${first.message || lastError} — L’errore è vicino alla riga ${first.line}.`
        : await describeCompileError(code, lastError);
      setTypstCode(code);
      setCompileError(described);
      return {
        ok: false,
        message:
          (log.length ? `Applicate: ${summarizeFixLog(log)} — ` : '') +
          `errore residuo: ${described}`,
      };
    } catch (e) {
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        return { ok: false, message: 'Correzione annullata.' };
      }
      setCompileError(e.message || 'Errore nella correzione AI.');
      return { ok: false, message: e.message || 'Errore nella correzione AI.' };
    } finally {
      setAiFixing(false);
    }
  }, [compilePreviewPdf, typstCode, settings, describeCompileError]);

  /**
   * Controllo ortografico locale (dizionari it+en impacchettati): elenca le
   * parole ignote a entrambi, con conteggio e contesto.
   */
  const runSpellcheck = useCallback(async () => {
    if (!typstCode.trim()) return;
    setSpellBusy(true);
    try {
      const speller = await loadSpeller();
      const ignore = new Set(loadSpellIgnore());
      setSpellReport({ suspects: findSuspects(typstCode, speller, ignore) });
    } catch (e) {
      setSpellReport({ suspects: [], error: e.message || 'Dizionari non disponibili.' });
    } finally {
      setSpellBusy(false);
    }
  }, [typstCode]);

  const closeSpellReport = useCallback(() => setSpellReport(null), []);

  /**
   * Aggiunge parole al dizionario personale (localStorage): non verranno più
   * segnalate né inviate all'AI, in questa e nelle prossime sessioni.
   */
  const ignoreSpellWords = useCallback((words) => {
    if (!words?.length) return;
    addSpellIgnore(words);
    const set = new Set(words.map((w) => w.toLowerCase()));
    setSpellReport((r) =>
      r ? { ...r, suspects: (r.suspects || []).filter((s) => !set.has(s.word.toLowerCase())) } : r,
    );
  }, []);

  /**
   * Normalizzazione deterministica di spaziature/punteggiatura (solo prosa,
   * zone di codice mascherate) + ricompilazione.
   */
  const fixPunctuation = useCallback(async () => {
    if (!typstCode.trim()) return { ok: false, message: 'Nessun codice.' };
    let repaired = typstCode;
    const changes = [];
    let speller = null;
    try {
      speller = await loadSpeller();
      const hyphenation = fixOcrHyphenation(repaired, speller);
      repaired = hyphenation.fixed;
      if (hyphenation.changes.length) {
        changes.push(`${hyphenation.changes.length} parole sillabate ricomposte`);
      }
    } catch {
      // La punteggiatura resta correggibile anche se il dizionario non carica.
    }
    const spacing = fixSpacing(repaired);
    repaired = spacing.fixed;
    changes.push(...spacing.changes);
    if (!changes.length) {
      if (speller) {
        const ignore = new Set(loadSpellIgnore());
        setSpellReport({ suspects: findSuspects(typstCode, speller, ignore) });
      }
      return { ok: true, message: 'Spaziatura e punteggiatura già a posto.' };
    }
    const fixed = repaired;
    const s = sessionRef.current;
    const previousCanonical = s?.workflow === 'strict' ? s.canonicalText : null;
    if (previousCanonical) {
      const canonicalHyphenation = speller
        ? fixOcrHyphenation(previousCanonical, speller).fixed
        : previousCanonical;
      s.canonicalText = fixSpacing(canonicalHyphenation).fixed;
    }
    if (s) s.editorCode = fixed;
    setTypstCode(fixed);
    const compiled = await recompile(fixed);
    if (!compiled) {
      if (s) {
        s.canonicalText = previousCanonical;
        s.editorCode = typstCode;
      }
      setTypstCode(typstCode);
      return { ok: false, message: 'Correzioni annullate: il documento modificato non supera la verifica.' };
    }
    await persist();
    if (speller) {
      const ignore = new Set(loadSpellIgnore());
      setSpellReport({ suspects: findSuspects(fixed, speller, ignore) });
    }
    return { ok: true, message: `Spaziatura sistemata: ${changes.join(' · ')}` };
  }, [typstCode, recompile, persist]);

  /**
   * Correzione rapida di TUTTI i sospetti con un LLM veloce: invia solo
   * parola + contesto (mai il documento), applica le sostituzioni di parola
   * intera, ricompila e ri-esegue il controllo.
   * @returns {Promise<{ok:boolean, message:string}>}
   */
  const spellFixAll = useCallback(
    async (selectedWords) => {
      let suspects = spellReport?.suspects || [];
      // Solo le parole selezionate dall'utente (es. escludendo «Bateson»).
      if (selectedWords) {
        const sel = new Set(selectedWords);
        suspects = suspects.filter((s) => sel.has(s.word));
      }
      if (!suspects.length) return { ok: true, message: 'Nessuna parola selezionata da correggere.' };
      setSpellBusy(true);
      try {
        const speller = await loadSpeller();
        // A lotti, per non superare i limiti di output del modello.
        // Le unioni già confermate dal dizionario sono applicate localmente;
        // soltanto le sequenze ambigue e i veri refusi vengono inviate all'AI.
        const proposals = suspects
          .filter((s) => s.suggestedFix)
          .map((s) => ({ word: s.word, fix: s.suggestedFix }));
        const aiSuspects = suspects.filter((s) => !s.suggestedFix);
        for (let i = 0; i < aiSuspects.length; i += 60) {
          proposals.push(
            ...(await requestSpellFixes({ settings, entries: aiSuspects.slice(i, i + 60) })),
          );
        }
        // Guardrail deterministici: parola singola, nota ai dizionari, e
        // SOLO tra quelle inviate (mai «correzioni» a parole non richieste).
        const allowed = new Set(suspects.map((s) => s.word));
        const acceptedFixes = new Set(
          suspects
            .filter((s) => s.suggestedFix)
            .map((s) => s.suggestedFix.toLocaleLowerCase('it')),
        );
        const { ok: corrections, rejected } = validateCorrections(
          proposals,
          speller,
          allowed,
          acceptedFixes,
        );
        const before = typstCode;
        const { code, applied } = applySpellFixes(before, corrections);
        if (!applied.length) {
          return {
            ok: true,
            message:
              'Nessuna correzione applicata: le parole restanti sembrano nomi ' +
              'propri o termini tecnici' +
              (rejected.length
                ? ` (${rejected.length} proposte dell’AI scartate dai guardrail).`
                : '.'),
          };
        }
        // Rete di sicurezza: se il documento compilava PRIMA ma non DOPO le
        // correzioni, si annulla tutto (mai peggiorare la compilazione).
        const strictSession = sessionRef.current?.workflow === 'strict' ? sessionRef.current : null;
        const previousCanonical = strictSession?.canonicalText;
        const previousCorrections = strictSession?.corrections || [];
        try {
          const pdfBytes = await getCompiledPdf(code);
          if (strictSession) {
            const canonical = applySpellFixes(previousCanonical || strictSession.rawText, corrections);
            strictSession.canonicalText = canonical.code;
            strictSession.corrections = [
              ...previousCorrections,
              ...canonical.applied.map((a) => ({
                before: a.word,
                after: a.fix,
                type: 'spelling',
                count: a.count,
              })),
            ];
            await verifyStrictPdf(code, pdfBytes);
          }
          setPreviewPdf(pdfBytes);
          setCompileError(null);
        } catch (eAfter) {
          if (strictSession) {
            strictSession.canonicalText = previousCanonical;
            strictSession.corrections = previousCorrections;
          }
          let beforeOk = false;
          try {
            beforeOk = (await diagnoseTypst(before, figuresRef.current)).ok;
          } catch {
            /* era già rotto prima: le correzioni non c'entrano */
          }
          if (beforeOk) {
            return {
              ok: false,
              message:
                'Correzioni ANNULLATE: avrebbero rotto la compilazione ' +
                `(${(eAfter.message || '').slice(0, 140)}). Il documento non è stato toccato.`,
            };
          }
          setCompileError(eAfter.message || 'Errore di compilazione Typst.');
        }
        setTypstCode(code);
        const ignore = new Set(loadSpellIgnore());
        setSpellReport({ suspects: findSuspects(code, speller, ignore) });
        return {
          ok: true,
          message:
            `Corrette ${applied.length} parole: ` +
            applied
              .map((a) => `${a.word}→${a.fix}${a.count > 1 ? ` (×${a.count})` : ''}`)
              .join(' · ') +
            (rejected.length ? ` · ${rejected.length} proposte scartate dai guardrail` : ''),
        };
      } catch (e) {
        return { ok: false, message: e.message || 'Errore nella correzione ortografica.' };
      } finally {
        setSpellBusy(false);
      }
    },
    [getCompiledPdf, spellReport, typstCode, settings, verifyStrictPdf],
  );

  /**
   * Rilettura AI contestuale (italiano): ripristina accenti, riunisce o separa
   * frammenti OCR, corregge piccoli refusi usando la frase, reinserisce parole-
   * funzione saltate e bilancia le caporali. I guard rifiutano sinonimi, cambi
   * a parole già valide, omissioni, riordini e numeri alterati. Resta attiva la
   * rete di sicurezza sulla compilazione come per l'ortografia.
   * @returns {Promise<{ok:boolean, message:string}>}
   */
  const proofreadAI = useCallback(async () => {
    const before = typstCode;
    if (!before.trim()) return { ok: false, message: 'Nessun codice da rileggere.' };
    const controller = new AbortController();
    abortRef.current = controller;
    setProofreadBusy(true);
    setProofreadDetail('');
    try {
      const { code, changed, skipped, changes } = await proofreadBody({
        settings,
        code: before,
        signal: controller.signal,
        onProgress: (done, total) => setProofreadDetail(`${done}/${total} paragrafi`),
      });
      if (!changed) {
        return {
          ok: true,
          message: skipped
            ? `Nessuna correzione applicata (${skipped} proposte scartate dal controllo di sicurezza).`
            : 'Rilettura completata: nessun refuso contestuale da correggere.',
        };
      }
      // Rete di sicurezza: se compilava PRIMA ma non DOPO, si annulla tutto.
      const strictSession = sessionRef.current?.workflow === 'strict' ? sessionRef.current : null;
      const previousCanonical = strictSession?.canonicalText;
      const previousCorrections = strictSession?.corrections || [];
      try {
        const pdfBytes = await getCompiledPdf(code);
        if (strictSession) {
          let nextCanonical = previousCanonical || strictSession.rawText;
          for (const change of changes) {
            if (!nextCanonical.includes(change.before)) {
              throw new Error('Una correzione non è riconducibile in modo univoco al testo OCR canonico.');
            }
            nextCanonical = nextCanonical.replace(change.before, change.after);
          }
          strictSession.canonicalText = nextCanonical;
          strictSession.corrections = [
            ...previousCorrections,
            ...changes.map((c) => ({ ...c, type: 'contextual' })),
          ];
          await verifyStrictPdf(code, pdfBytes);
        }
        setPreviewPdf(pdfBytes);
        setCompileError(null);
      } catch (eAfter) {
        if (strictSession) {
          strictSession.canonicalText = previousCanonical;
          strictSession.corrections = previousCorrections;
        }
        let beforeOk = false;
        try {
          beforeOk = (await diagnoseTypst(before, figuresRef.current)).ok;
        } catch {
          /* era già rotto prima */
        }
        if (beforeOk) {
          return {
            ok: false,
            message:
              'Rilettura ANNULLATA: avrebbe rotto la compilazione ' +
              `(${(eAfter.message || '').slice(0, 140)}). Il documento non è stato toccato.`,
          };
        }
        setCompileError(eAfter.message || 'Errore di compilazione Typst.');
      }
      setTypstCode(code);
      return {
        ok: true,
        message:
          `Rilettura applicata a ${changed} paragrafi (refusi OCR, parole ` +
          `spezzate o fuse, accenti e virgolette)` +
          (skipped ? ` · ${skipped} proposte scartate dal controllo` : '') + '.',
      };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, message: 'Rilettura annullata.' };
      return { ok: false, message: e.message || 'Errore nella rilettura AI.' };
    } finally {
      setProofreadBusy(false);
      setProofreadDetail('');
    }
  }, [getCompiledPdf, typstCode, settings, verifyStrictPdf]);

  /** Revisione interattiva di una singola voce del registro conservativo. */
  const reviewStrictCorrection = useCallback(async (index, action) => {
    const s = sessionRef.current;
    const correction = s?.corrections?.[index];
    if (s?.workflow !== 'strict' || !correction) {
      return { ok: false, message: 'Correzione non più disponibile.' };
    }
    setStrictCorrectionBusy({ index, action });
    const updateCorrections = (next) => {
      s.corrections = next;
      setStrictReport((report) => report ? { ...report, corrections: next } : report);
    };
    try {
      if (action === 'review-ai') {
        const review = await requestCorrectionReview({
          settings,
          before: correction.before,
          after: correction.after,
          context: correctionContext(s.rawText, correction.before, correction.after),
          signal: abortRef.current?.signal,
        });
        let applicable = review.choice !== 'proposal';
        if (review.choice === 'proposal') {
          try {
            const speller = await loadSpeller();
            applicable = isSafeContextualCorrection(correction.before, review.text, speller);
          } catch {
            applicable = false;
          }
        }
        const next = s.corrections.map((item, i) => i === index
          ? { ...item, aiReview: { ...review, applicable } }
          : item);
        updateCorrections(next);
        await persist();
        return {
          ok: true,
          message: applicable
            ? 'Controllo AI completato: scegli se applicarne l’esito.'
            : 'Controllo AI completato, ma la proposta non supera i controlli di sicurezza.',
        };
      }

      const currentText = correction.appliedText ?? correction.after;
      const target = action === 'use-original'
        ? correction.before
        : action === 'use-ai'
          ? correction.aiReview?.text
          : correction.after;
      if (typeof target !== 'string' || !target.trim()) {
        return { ok: false, message: 'Questa voce strutturale non può essere reinserita automaticamente.' };
      }
      if (action === 'use-ai' && correction.aiReview?.applicable !== true) {
        return { ok: false, message: 'La proposta AI non ha superato i controlli di sicurezza.' };
      }
      const decision = action === 'use-original' ? 'original' : action === 'use-ai' ? 'ai' : 'corrected';
      const nextCorrections = s.corrections.map((item, i) => i === index
        ? { ...item, decision, appliedText: target }
        : item);
      if (target === currentText) {
        updateCorrections(nextCorrections);
        await persist();
        return { ok: true, message: 'Scelta registrata; il testo era già quello selezionato.' };
      }

      const currentCanonical = s.canonicalText || s.rawText;
      const nextCanonical = replaceUniqueText(currentCanonical, currentText, target);
      if (nextCanonical == null) {
        return {
          ok: false,
          message: 'Il passaggio non è localizzabile in modo univoco: nessuna modifica è stata applicata.',
        };
      }
      let nextCode = rebaseCanonicalRevision(
        typstCode,
        currentCanonical,
        nextCanonical,
        s.layoutPlan || {},
      );
      if (nextCode == null) {
        return {
          ok: false,
          message: 'Il frammento Typst è stato modificato altrove e non può essere sostituito con sicurezza.',
        };
      }
      nextCode = ensureExplicitHyphenation(nextCode);

      const previous = {
        canonicalText: s.canonicalText,
        corrections: s.corrections,
        editorCode: s.editorCode,
        preamble: s.preamble,
        chunks: s.chunks,
      };
      const pdfBytes = await getCompiledPdf(nextCode);
      s.canonicalText = nextCanonical;
      s.corrections = nextCorrections;
      s.editorCode = nextCode;
      const parts = splitPreamble(nextCode);
      s.preamble = parts.preamble;
      s.chunks = [{
        text: s.rawText,
        body: parts.body,
        status: 'done',
        fidelity: { coverage: 1, missing: [] },
      }];
      try {
        await verifyStrictPdf(nextCode, pdfBytes);
      } catch (e) {
        s.canonicalText = previous.canonicalText;
        s.corrections = previous.corrections;
        s.editorCode = previous.editorCode;
        s.preamble = previous.preamble;
        s.chunks = previous.chunks;
        throw e;
      }
      setTypstCode(nextCode);
      setPreviewPdf(pdfBytes);
      setCompileError(null);
      await persist();
      return { ok: true, message: 'Scelta applicata e PDF ricontrollato.' };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, message: 'Revisione annullata.' };
      return { ok: false, message: e.message || 'Impossibile revisionare questa correzione.' };
    } finally {
      setStrictCorrectionBusy(null);
    }
  }, [getCompiledPdf, persist, settings, typstCode, verifyStrictPdf]);

  /** Azioni sui passaggi discordanti fra fonte canonica e PDF compilato. */
  const reviewStrictIssue = useCallback(async (index, action) => {
    const s = sessionRef.current;
    const issue = strictReport?.pdf?.issues?.[index];
    if (s?.workflow !== 'strict' || !issue) return { ok: false, message: 'Passaggio non più disponibile.' };
    setStrictIssueBusy({ index, action });
    const saveResolution = async (value) => {
      const next = { ...(s.strictIssueResolutions || {}), [issue.key]: value };
      s.strictIssueResolutions = next;
      setStrictReport((report) => {
        if (!report) return report;
        const covered = report.pdf?.issues?.reduce((total, item) => total + item.missing.length, 0) || 0;
        const allArtifacts =
          covered >= (report.pdf?.missing?.length || 0) &&
          report.pdf?.issues?.every((item) => next[item.key]?.status === 'artifact');
        return {
          ...report,
          issueResolutions: next,
          pdf: report.pdf ? {
            ...report.pdf,
            contentOk: report.pdf.missingInvariants?.length === 0 && allArtifacts,
          } : report.pdf,
        };
      });
      await persist();
    };
    try {
      if (action === 'mark-artifact') {
        await saveResolution({ status: 'artifact', explanation: 'Confermato manualmente come artefatto di estrazione.' });
        return { ok: true, message: 'Segnalazione archiviata come artefatto di estrazione.' };
      }
      const previousResolution = s.strictIssueResolutions?.[issue.key] || {};
      if (action === 'review-ai') {
        const review = await requestStrictPassageRepair({
          settings,
          issue,
          context: correctionContext(s.rawText, issue.source, issue.rendered, 900),
          signal: abortRef.current?.signal,
        });
        const sourceCount = canonicalTokens(issue.source).length;
        const proposalCount = canonicalTokens(review.text).length;
        const safe = review.choice !== 'proposal' || (
          proposalCount >= Math.floor(sourceCount * 0.8) &&
          proposalCount <= Math.ceil(sourceCount * 1.35) &&
          missingInvariants(issue.source, review.text).length === 0
        );
        await saveResolution({ ...previousResolution, passageReview: { ...review, safe } });
        return {
          ok: true,
          message: safe
            ? 'Analisi puntuale completata: controlla e applica l’esito se concordi.'
            : 'La proposta è stata mostrata ma bloccata perché perde testo o invarianti.',
        };
      }

      const review = previousResolution.passageReview;
      if (action === 'apply-ai' && !review) return { ok: false, message: 'Esegui prima il ricontrollo con IA.' };
      if (action === 'apply-ai' && review.choice === 'artifact') {
        await saveResolution({ ...previousResolution, status: 'artifact' });
        return { ok: true, message: 'Esito IA confermato come artefatto di estrazione.' };
      }
      if (action === 'apply-ai' && review.safe !== true) {
        return { ok: false, message: 'La proposta IA non supera i controlli di completezza.' };
      }

      const currentCanonical = s.canonicalText || s.rawText;
      let nextCanonical = currentCanonical;
      let nextCode;
      if (action === 'apply-ai' && review.choice === 'proposal') {
        nextCanonical = replaceUniqueText(currentCanonical, issue.source, review.text);
        if (nextCanonical == null) {
          return { ok: false, message: 'La frase canonica non è localizzabile in modo univoco; nessuna modifica applicata.' };
        }
        nextCode = rebaseCanonicalRevision(typstCode, currentCanonical, nextCanonical, s.layoutPlan || {});
      } else {
        // Sia il comando manuale sia l'esito "canonical" rigenerano il blocco
        // dal testo OCR canonico, eliminando troncamenti o caratteri invisibili.
        nextCode = restoreCanonicalPassage(typstCode, currentCanonical, issue.source, s.layoutPlan || {});
      }
      if (nextCode == null) {
        return { ok: false, message: 'Non è stato possibile localizzare un solo blocco Typst corrispondente.' };
      }
      nextCode = ensureExplicitHyphenation(nextCode);

      const previous = {
        canonicalText: s.canonicalText,
        editorCode: s.editorCode,
        preamble: s.preamble,
        chunks: s.chunks,
        corrections: s.corrections,
        resolutions: s.strictIssueResolutions,
      };
      const pdfBytes = await getCompiledPdf(nextCode);
      s.canonicalText = nextCanonical;
      s.editorCode = nextCode;
      s.strictIssueResolutions = {
        ...(s.strictIssueResolutions || {}),
        [issue.key]: { ...previousResolution, status: action === 'apply-ai' ? 'ai-applied' : 'canonical-restored' },
      };
      if (action === 'apply-ai' && review.choice === 'proposal') {
        s.corrections = [
          ...(s.corrections || []),
          {
            type: 'strict_issue_ai',
            before: issue.source,
            after: review.text,
            decision: 'ai',
            appliedText: review.text,
          },
        ];
      }
      const parts = splitPreamble(nextCode);
      s.preamble = parts.preamble;
      s.chunks = [{ text: s.rawText, body: parts.body, status: 'done', fidelity: { coverage: 1, missing: [] } }];
      try {
        await verifyStrictPdf(nextCode, pdfBytes);
      } catch (e) {
        s.canonicalText = previous.canonicalText;
        s.editorCode = previous.editorCode;
        s.preamble = previous.preamble;
        s.chunks = previous.chunks;
        s.corrections = previous.corrections;
        s.strictIssueResolutions = previous.resolutions;
        throw e;
      }
      setTypstCode(nextCode);
      setPreviewPdf(pdfBytes);
      setCompileError(null);
      await persist();
      return { ok: true, message: 'Passaggio rigenerato, compilato e confrontato nuovamente.' };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, message: 'Revisione annullata.' };
      return { ok: false, message: e.message || 'Impossibile revisionare il passaggio.' };
    } finally {
      setStrictIssueBusy(null);
    }
  }, [getCompiledPdf, persist, settings, strictReport, typstCode, verifyStrictPdf]);

  /**
   * Ri-genera SOLO il layout: riusa il testo OCR già estratto e ri-esegue la
   * fase 2 (Gemini con indicazioni di stile) + fase 3 (compilazione). Non
   * ripete l'OCR (nessun costo/latenza NVIDIA, nessun re-render del PDF).
   */
  const restyle = useCallback(
    async (styleHint) => {
      if (!rawText.trim()) return false;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      setCompileError(null);
      setCanResume(false);
      setFidelityWarnings([]);
      // Nuova sessione a chunk sul testo OCR, con lo stile richiesto.
      const prev = sessionRef.current;
      sessionRef.current = {
        id: prev?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        fileName: prev?.fileName || 'documento',
        rawText,
        chunks: chunkDocument(rawText, settings.chunkSize).map((t) => ({
          text: t,
          body: '',
          status: 'pending',
        })),
        preamble: '',
        styleHint,
        lastError: '',
      };
      setStatus((s) => ({ ...s, format: 'active', compile: 'pending' }));
      setPhase('running');
      setActiveStep('format');
      setDetail('Rigenerazione layout…');
      await runFormat(controller.signal);
      return true;
    },
    [rawText, runFormat],
  );

  /**
   * Conferma della revisione figure: mantiene solo i percorsi indicati,
   * rimuove i segnaposto delle figure scartate dal testo OCR e avvia la
   * formattazione.
   * @param {string[]} keptPaths
   */
  const confirmFigures = useCallback(
    async (keptPaths) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const keep = new Set(keptPaths);
      let text = pending.extracted;
      const discarded = [];
      for (const fig of figuresRef.current) {
        if (keep.has(fig.path)) continue;
        discarded.push(fig.path);
        const escaped = fig.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`^!\\[[^\\]\\n]*\\]\\(${escaped}\\)[ \\t]*$\\n?`, 'gm'), '');
      }
      text = text.replace(/\n{3,}/g, '\n\n').trim();
      figuresRef.current = figuresRef.current.filter((f) => keep.has(f.path));
      // Libera anche dallo storage le figure scartate (già salvate durante OCR).
      if (discarded.length && sessionRef.current?.id) {
        await deleteFigures(sessionRef.current.id, discarded);
      }
      clearReview();
      setRawText(text);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await startFormat(text, pending.fileName, controller.signal);
      } catch (e) {
        if (controller.signal.aborted || e?.name === 'AbortError') return;
        setError(e.message || 'Errore imprevisto nella pipeline.');
        setPhase('error');
      }
    },
    [startFormat, clearReview],
  );

  /** Esegue l'intera pipeline a partire dal file caricato. */
  const runPipeline = useCallback(
    async (file) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setPhase('running');
      setError(null);
      setCompileError(null);
      setStatus({ ...emptyStatus });
      setRawText('');
      setTypstCode('');
      setPreviewPdf(null);
      setFidelityWarnings([]);
      setOcrProgress(null);
      clearReview();
      figuresRef.current = [];
      releaseDesktopPdf(compiledPdfRef.current.pdf);
      compiledPdfRef.current = { source: '', figures: null, pdf: null };

      try {
        // [1/3] Estrazione testo (NVIDIA). Nemotron-Parse accetta solo
        // immagini: i PDF vengono prima rasterizzati pagina per pagina.
        setActiveStep('ocr');
        setStatus((s) => ({ ...s, ocr: 'active' }));
        setDetail('');

        let pageImages;
        let pdfBuffer = null;
        if (isPdf(file)) {
          pdfBuffer = await file.arrayBuffer();
          // PDF con layer di testo (vettoriale / già OCR'd): estrai il testo
          // esatto e SALTA l'OCR NVIDIA. Se non c'è testo utile → OCR.
          if (settings.pdfTextMode !== 'ocr') {
            setDetail('Lettura del testo del PDF…');
            const text = await extractPdfText(pdfBuffer, {
              maxPages: settings.maxPages,
              onProgress: (p, t) => setDetail(`Lettura testo pagina ${p}/${t}…`),
            });
            if (signal.aborted) return;
            if (text) {
              const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              sessionRef.current = { id, fileName: file.name, styleHint: undefined, lastError: '' };
              figuresRef.current = [];
              const extracted = normalizeHeadingLevels(text);
              setRawText(extracted);
              setStatus((s) => ({ ...s, ocr: 'done' }));
              setDetail('');
              // Nessuna figura da rivedere: dritti alla fase 2 (ripartibile).
              await startFormat(extracted, file.name, signal);
              return;
            }
            setDetail(''); // niente testo digitale: si procede con l'OCR
          }
          setDetail('Rendering del PDF…');
          pageImages = await renderPdfToImages(pdfBuffer, {
            maxPages: settings.maxPages,
            longSide: settings.ocrLongSide,
            onProgress: (p, t) => setDetail(`Rendering pagina ${p}/${t}…`),
          });
        } else {
          pageImages = [await fileToDataUrl(file)];
        }
        if (signal.aborted) return;
        if (!pageImages.length) throw new Error('Nessuna pagina da elaborare.');

        // ANTEPRIMA PAGINE prima dell'OCR: le doppie pagine (spread) vengono
        // rilevate dal rapporto d'aspetto e proposte per la divisione; le
        // pagine ruotate si raddrizzano col tasto ↻. La pipeline resta in
        // pausa finché l'utente non conferma.
        pendingPagesRef.current = { pageImages, fileName: file.name };
        // L'anteprima usa MINIATURE: un `<img>` per pagina a piena risoluzione
        // riempirebbe il DOM di bitmap decodificate (centinaia di MB su un
        // libro). Le immagini vere restano in pendingPagesRef per l'OCR.
        setDetail('Preparazione anteprima…');
        const thumbs = [];
        for (let i = 0; i < pageImages.length; i++) {
          thumbs.push({
            index: i,
            url: await makeThumbnail(pageImages[i]),
            rotate: 0,
            split: isSpreadLike(pageImages[i]),
          });
          if (signal.aborted) return;
        }
        setPageReview(thumbs);
        setActiveStep(null);
        setDetail('Controlla rotazione e doppie pagine, poi avvia l’estrazione.');
        setPhase('pages');
        return;
      } catch (e) {
        setDetail('');
        if (signal.aborted || e?.name === 'AbortError') {
          setPhase(typstCode ? 'done' : 'idle');
          return;
        }
        setStatus((s) => {
          const step = activeStepFromStatus(s);
          return step ? { ...s, [step]: 'error' } : s;
        });
        setError(e.message || 'Errore imprevisto nella pipeline.');
        setPhase('error');
      }
    },
    [settings, startFormat, clearReview, typstCode],
  );

  return {
    phase,
    status,
    activeStep,
    detail,
    error,
    rawText,
    typstCode,
    setTypstCode,
    layoutOptions,
    previewPdf,
    downloadPdf,
    downloading,
    projectBusy,
    compileError,
    compiling,
    chunkProgress,
    ocrProgress,
    canResume,
    figureReview,
    confirmFigures,
    pageReview,
    confirmPages,
    fidelityWarnings,
    strictReport,
    strictCorrectionBusy,
    reviewStrictCorrection,
    strictIssueBusy,
    reviewStrictIssue,
    sessions,
    openSession,
    deleteSavedSession,
    refreshSessions,
    exportProject,
    importProject,
    runPipeline,
    recompile,
    previewSearchMatch,
    restyle,
    applyLocalStyle,
    autofix,
    aiFix,
    aiFixing,
    spellReport,
    spellBusy,
    runSpellcheck,
    spellFixAll,
    ignoreSpellWords,
    fixPunctuation,
    closeSpellReport,
    proofreadBusy,
    proofreadDetail,
    proofreadAI,
    resume,
    reset,
    cancel,
  };
}

function activeStepFromStatus(s) {
  return Object.keys(s).find((k) => s[k] === 'active') || null;
}
