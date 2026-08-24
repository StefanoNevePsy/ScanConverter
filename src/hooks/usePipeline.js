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
import { ENGINE_LABELS, phaseConfig } from '../lib/phases.js';
import { structureFromBlocks } from '../lib/docmodel.js';
import {
  translateDocument as translateMarkdown,
  languageLabel,
  preservesMarkdownStructure,
  translationJobKey,
  splitSentences,
} from '../lib/translate.js';
import {
  auditTypstDuplicates,
  auditTypstLanguage,
  detectPassageLanguage,
  findAdjacentTypstDuplicatePassages,
  inferTypstLanguage,
  parsePageSelection,
} from '../lib/languageAudit.js';
import { typstDocumentPassages, typstPlainText } from '../lib/typstContent.js';
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
  rebaseMissingCanonicalPassage,
  rebaseStrictPassage,
  rebaseStrictPassageFuzzy,
  replaceContextualText,
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
import {
  createPdfVerificationKey,
  reusablePdfVerification,
} from '../lib/verificationCache.js';
import { loadSpellIgnore, addSpellIgnore } from '../lib/storage.js';
import { createProjectArchive, inspectProjectArchive } from '../lib/projectArchive.js';
import {
  normalizeTextSelection,
  replaceTextSelection,
} from '../lib/selectionRevision.js';
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
  saveBlocks,
  getBlocks,
  saveParts,
  getParts,
  getSession,
  getPages,
  savePageRecords,
  deletePage,
  deletePagesFor,
  requestPersistentStorage,
  saveTranslationGroup,
  getTranslationGroups,
  deleteTranslationJob,
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

function phaseEngineLabel(settings, phase) {
  const { engine, model } = phaseConfig(settings, phase);
  const label = ENGINE_LABELS[engine] || engine;
  return model ? `${label} · ${model}` : label;
}

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

function rebaseStrictRevision({
  editorCode,
  currentCanonical,
  nextCanonical,
  before,
  after,
  layoutPlan,
}) {
  return rebaseCanonicalRevision(editorCode, currentCanonical, nextCanonical, layoutPlan) ??
    rebaseStrictPassage(editorCode, before, after) ??
    rebaseStrictPassageFuzzy(editorCode, before, after) ??
    (
      canonicalTokens(before).length >= 8
        ? restoreCanonicalPassage(editorCode, nextCanonical, before, layoutPlan)
        : null
    );
}

function selectiveTranslationContext(source, passage, sentenceCount = 2) {
  const clean = (value) => String(value || '')
    .replace(/<!--\s*pagina\s+\d+\s*-->/giu, ' ')
    .replace(/^\s*\/\/\s*pagina\s+\d+\s*$/gimu, ' ')
    .replace(/#[a-zA-Z][\w.-]*/gu, ' ')
    .replace(/^\s*=+\s+/gmu, '')
    .replace(/[\[\]]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const before = splitSentences(clean(source.slice(Math.max(0, passage.start - 2400), passage.start)))
    .slice(-sentenceCount)
    .map((sentence) => sentence.trim())
    .join(' ');
  const after = splitSentences(clean(source.slice(passage.end, passage.end + 2400)))
    .slice(0, sentenceCount)
    .map((sentence) => sentence.trim())
    .join(' ');
  return { before, after };
}

function strictReportFromPdf(session, pdf) {
  return {
    workflow: 'strict',
    corrections: session.corrections || [],
    ocrComparisons: session.ocrComparisons || [],
    strictIssueResolutions: session.strictIssueResolutions || {},
    layoutPlan: session.layoutPlan || null,
    strictReview: session.strictReview || [],
    strictReviewKey: session.strictReviewKey || null,
    issueResolutions: session.strictIssueResolutions || {},
    pdf,
  };
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
  // Le callback di audit devono leggere sempre l'ultima battuta dell'editor
  // senza diventare dipendenti da `typstCode` (altrimenti un libro intero
  // verrebbe ricontrollato a ogni tasto premuto).
  const typstCodeRef = useRef('');
  typstCodeRef.current = typstCode;
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
  const [selectionAiBusy, setSelectionAiBusy] = useState(null); // 'proof' | 'translate' | null
  const [selectionAiDetail, setSelectionAiDetail] = useState('');
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateDetail, setTranslateDetail] = useState(''); // "4/30 passaggi"
  const [languageAudit, setLanguageAudit] = useState(null);
  const [languageRepairBusy, setLanguageRepairBusy] = useState(false);
  const [languageRepairDetail, setLanguageRepairDetail] = useState('');
  const [languageRepairReport, setLanguageRepairReport] = useState(null);
  const [duplicateAudit, setDuplicateAudit] = useState(null);
  const [duplicateRepairBusy, setDuplicateRepairBusy] = useState(false);
  const [duplicateRepairDetail, setDuplicateRepairDetail] = useState('');
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

  /** Compila e confronta il layer testuale del PDF con il Typst autorevole. */
  const verifyStrictPdf = useCallback(async (source, existingBytes = null) => {
    const s = sessionRef.current;
    if (s?.workflow !== 'strict') return existingBytes;
    const authoritativeText = typstPlainText(source);
    const verificationKey = await createPdfVerificationKey({
      source,
      canonicalText: authoritativeText,
      figures: figuresRef.current,
      issueResolutions: s.strictIssueResolutions || {},
    });
    // Download e riapertura dell'anteprima riusano lo stesso artefatto: non
    // riestrarre centinaia di pagine se questo identico PDF è già verificato.
    // Anche la chiave deve coincidere: una risoluzione manuale può cambiare
    // l'esito pur lasciando immutati sorgente e PDF.
    if (
      existingBytes &&
      s.verifiedPdfSource === source &&
      s.verifiedPdfArtifact === existingBytes &&
      reusablePdfVerification(s.pdfVerification, verificationKey)
    ) {
      return existingBytes;
    }
    if (reusablePdfVerification(s.pdfVerification, verificationKey)) {
      const pdfBytes = existingBytes || await compileToPdf(source, figuresRef.current);
      s.verified = s.pdfVerification.contentOk === true;
      s.verifiedPdfSource = source;
      s.verifiedPdfArtifact = pdfBytes;
      setStrictReport(strictReportFromPdf(s, s.pdfVerification.pdf));
      return pdfBytes;
    }
    s.verified = false;
    const pdfBytes = existingBytes || await compileToPdf(source, figuresRef.current);
    // Il PDF riformattato può avere più pagine dell'input: non applicare qui
    // il limite di ingestione configurato per i PDF sorgente.
    const pdfText = await extractPdfText(pdfBytes, {
      onProgress: (page, total) => {
        if (page === 1 || page === total || page % 8 === 0) {
          setDetail(`Verifica testuale del PDF · pagina ${page}/${total}…`);
        }
      },
    });
    if (!pdfText) {
      const pdf = { contentOk: false, unverifiable: true, missing: [], added: [], missingInvariants: [] };
      s.pdfVerification = {
        key: verificationKey,
        contentOk: false,
        checkedAt: Date.now(),
        pdf,
      };
      setStrictReport(strictReportFromPdf(s, pdf));
      s.verifiedPdfSource = source;
      s.verifiedPdfArtifact = pdfBytes;
      return pdfBytes;
    }
    const expected = sourcePlainText(authoritativeText);
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
    const pdf = {
      ...sequence,
      exactOrder: sequence.ok,
      contentOk,
      missing: inventory.missing,
      added: inventory.added,
      missingInvariants: invariants,
      issues,
      aiReview,
      reviewError,
    };
    s.pdfVerification = {
      key: verificationKey,
      contentOk,
      checkedAt: Date.now(),
      pdf,
    };
    setStrictReport(strictReportFromPdf(s, pdf));
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

  const refreshLanguageAudit = useCallback((session = sessionRef.current, sourceOverride = '') => {
    const source = sourceOverride || typstCodeRef.current || session?.editorCode || '';
    if (!source.trim()) {
      setLanguageAudit(null);
      setDuplicateAudit(null);
      return null;
    }
    // Da questo punto il Typst aperto è il documento: anche gli avvisi devono
    // nascere dai suoi offset, non da una copia OCR che l'utente non può
    // correggere e che può essere ormai intenzionalmente diversa.
    setDuplicateAudit(auditTypstDuplicates(source));
    if (!session?.translatedFrom) {
      setLanguageAudit(null);
      return null;
    }
    const targetLanguage = session.targetLanguage || inferTypstLanguage(
      source,
      settings.targetLang || 'it',
    );
    const sourceLanguage = session.sourceLanguage && session.sourceLanguage !== targetLanguage
      ? session.sourceLanguage
      : 'auto';
    const audit = auditTypstLanguage(source, targetLanguage, sourceLanguage);
    setLanguageAudit(audit);
    return audit;
  }, [settings.targetLang]);

  const refreshDuplicateAudit = useCallback((session = sessionRef.current, sourceOverride = '') => {
    const source = sourceOverride || typstCodeRef.current || session?.editorCode || '';
    if (!source.trim()) {
      setDuplicateAudit(null);
      return null;
    }
    const audit = auditTypstDuplicates(source);
    setDuplicateAudit(audit);
    return audit;
  }, []);

  /** Ripete soltanto l'analisi linguistica deterministica, senza chiamate AI. */
  const recheckLanguage = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.translatedFrom) {
      return { ok: false, message: 'Questo documento non risulta creato da una traduzione.' };
    }
    const audit = refreshLanguageAudit(session);
    if (!audit) {
      return { ok: false, message: 'Nessun testo tradotto da controllare.' };
    }
    const count = audit.items.length;
    return {
      ok: true,
      audit,
      message: count
        ? `Controllo lingua aggiornato in locale: ${count} passaggi da verificare.`
        : 'Controllo lingua aggiornato in locale: nessun passaggio fuori lingua rilevato.',
    };
  }, [refreshLanguageAudit]);

  /** Ripete la ricerca deterministica delle sole ripetizioni esatte. */
  const recheckDuplicates = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return { ok: false, message: 'Nessun documento da controllare.' };
    const audit = refreshDuplicateAudit(session);
    if (!audit) return { ok: false, message: 'Nessun testo da controllare.' };
    return {
      ok: true,
      audit,
      message: audit.items.length
        ? `Controllo duplicati aggiornato in locale: ${audit.items.length} ripetizioni esatte da verificare.`
        : 'Controllo duplicati aggiornato in locale: nessuna ripetizione sospetta rilevata.',
    };
  }, [refreshDuplicateAudit]);

  // All'avvio, carica l'elenco delle sessioni salvate.
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Se l'utente corregge la lingua dichiarata nel pannello, il controllo
  // locale si riallinea senza alcuna chiamata di rete.
  useEffect(() => {
    refreshLanguageAudit();
  }, [refreshLanguageAudit]);

  // Una rimozione manuale nell'editor aggiorna gli avvisi direttamente sul
  // sorgente autorevole. Il debounce evita lavoro continuo sui libri lunghi.
  useEffect(() => {
    if (!typstCode.trim() || !duplicateAudit?.items?.length) return undefined;
    const timer = setTimeout(() => {
      setDuplicateAudit(auditTypstDuplicates(typstCode));
    }, 700);
    return () => clearTimeout(timer);
  }, [typstCode]); // L'audit corrente è volutamente uno snapshot da filtrare, non una dipendenza.

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
      documentAuthority: s.editorCode?.trim() ? 'typst' : 'ocr',
      canonicalText: s.canonicalText || null,
      corrections: s.corrections || [],
      ocrComparisons: s.ocrComparisons || [],
      strictIssueResolutions: s.strictIssueResolutions || {},
      verified: !!s.verified,
      pdfVerification: s.pdfVerification || null,
      strictReview: s.strictReview || [],
      strictReviewKey: s.strictReviewKey || null,
      layoutPlan: s.layoutPlan || null,
      // Id del documento da cui questo è stato tradotto: serve a non
      // confondere l'originale con la sua traduzione nell'elenco.
      translatedFrom: s.translatedFrom || null,
      sourceLanguage: s.sourceLanguage || null,
      targetLanguage: s.targetLanguage || null,
      translationFailures: s.translationFailures || [],
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
    setLanguageAudit(null);
    setLanguageRepairBusy(false);
    setLanguageRepairDetail('');
    setLanguageRepairReport(null);
    setDuplicateAudit(null);
    setDuplicateRepairBusy(false);
    setDuplicateRepairDetail('');
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
      const { engine, model } = phaseConfig(settings, 'typst');
      const common = {
        rawText: args.rawText,
        styleHint: args.styleHint,
        continuation: args.continuation,
        fidelityNote: args.fidelityNote,
        fixTypos: settings.fixTypos,
        docContext: settings.docContext,
        signal,
      };
      const call = () =>
        engine === 'local'
          ? toTypstLocal({ settings, ...common })
          : engine === 'nvidia'
          ? toTypstNvidia({
              apiKey: settings.nvidiaApiKey,
              endpoint: settings.nvidiaEndpoint,
              model,
              ...common,
            })
          : toTypst({ apiKey: settings.googleApiKey, model, ...common });
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
      // La sessione viene ricostruita da zero qui sotto: la provenienza va
      // portata avanti a mano, o una traduzione perde il legame con l'originale.
      const translatedFrom = sessionRef.current?.translatedFrom || null;
      const sourceLanguage = sessionRef.current?.sourceLanguage || null;
      const targetLanguage = sessionRef.current?.targetLanguage || null;
      const translationFailures = sessionRef.current?.translationFailures || [];
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
          const proofEngine = phaseEngineLabel(settings, 'proof');
          setDetail(`Rilettura e ortografia · ${proofEngine}…`);
          const proof = await proofreadBody({
            settings,
            // Non ripartire dal testo originale: altrimenti la rilettura
            // annulla silenziosamente le riparazioni tra pagine appena fatte.
            code: canonicalText,
            speller,
            signal,
            onProgress: (done, total) => setDetail(
              `Rilettura · ${proofEngine} · ${done}/${total} paragrafi…`,
            ),
          });
          canonicalText = proof.code;
          corrections = [...corrections, ...proof.changes];
        }
        const typstEngine = phaseEngineLabel(settings, 'typst');
        setDetail(`Progettazione layout Typst · ${typstEngine}…`);
        const layoutPlan = await withRetry(
          () => requestStrictLayoutPlan({ settings, markdown: canonicalText, signal }),
          signal,
          (secs) => setDetail(
            `Layout Typst · ${typstEngine} · nuovo tentativo tra ${secs}s…`,
          ),
        );
        const strict = buildStrictDocument(canonicalText, layoutPlan);
        const strictOptions = normalizeLayoutOptions(strict.documentOptions);
        setLayoutOptions(strictOptions);
        const previousComparisons = sessionRef.current?.ocr?.comparisons || [];
        sessionRef.current = {
          id,
          fileName,
          translatedFrom,
          sourceLanguage,
          targetLanguage,
          translationFailures,
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
          // Le opzioni dedotte dal documento vanno persistite con la sessione:
          // riaprendola devono essere quelle di prima, non i default.
          layoutOptions: strictOptions,
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
        const strictSource = combineDocument(strict.preamble, [strict.body]);
        sessionRef.current.editorCode = strictSource;
        setTypstCode(strictSource);
        await saveFigures(id, figuresRef.current);
        await persist();
        refreshLanguageAudit(sessionRef.current, strictSource);
        setPhase('running');
        setActiveStep('compile');
        setStatus((s) => ({ ...s, format: 'done', compile: 'active' }));
        await finalizeCompile(signal);
        return;
      }
      sessionRef.current = {
        id,
        fileName,
        translatedFrom,
        sourceLanguage,
        targetLanguage,
        translationFailures,
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
      refreshLanguageAudit(sessionRef.current);
      setPhase('running');
      setActiveStep('format');
      setStatus((s) => ({ ...s, format: 'active' }));
      await runFormat(signal);
    },
    [settings, runFormat, persist, finalizeCompile, refreshLanguageAudit],
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
          const ocr = phaseConfig(settings, 'ocr');
          const blocks =
            ocr.engine === 'local'
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
              : ocr.engine === 'gemini'
              ? [
                  {
                    type: 'Text',
                    bbox: null,
                    text: await withRetry(
                      () =>
                        ocrImageGemini({
                          apiKey: settings.googleApiKey,
                          model: ocr.model,
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
                      model: ocr.model,
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
              const models = settings.phases?.ocr?.models || {};
              let alternateText;
              if (ocr.engine === 'gemini') {
                const altBlocks = await withRetry(
                  () => extractPageBlocks({
                    apiKey: settings.nvidiaApiKey,
                    endpoint: settings.nvidiaEndpoint,
                    model: models.nvidia,
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
                    model: models.gemini,
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
                primary: ocr.engine,
                alternate: ocr.engine === 'gemini' ? 'nvidia' : 'gemini',
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
                primary: ocr.engine,
                alternate: ocr.engine === 'gemini' ? 'nvidia' : 'gemini',
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
          // I riquadri servono a dedurre la gerarchia sul libro INTERO, a OCR
          // finito: senza conservarli qui, a quel punto non esistono più.
          await saveBlocks(s.id, i, pageBlocks);
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
      const joined = s.ocr.parts.filter(Boolean).join('\n\n');

      // Qui, e SOLO qui, esiste il libro intero: è l'unico momento in cui si
      // può decidere che cosa sia un titolo di capitolo confrontandolo con
      // tutti gli altri. Deciso pagina per pagina, sulla pagina dell'indice la
      // riga più grande è una riga d'indice e diventa un titolo di livello 1.
      setDetail('Ricostruzione della gerarchia sul documento intero…');
      const structured = structureFromBlocks(joined, await getBlocks(s.id));
      if (structured.releveled || structured.demoted) {
        s.structureReport = {
          releveled: structured.releveled,
          demoted: structured.demoted,
          levels: structured.inventory?.levels?.length || 0,
        };
      }

      const extracted = normalizeHeadingLevels(structured.markdown);
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
      setLanguageRepairReport(null);
      setDuplicateAudit(null);

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

      // La traduzione viene salvata PRIMA della rilettura e del layout. Se
      // l'app è stata chiusa durante una di queste fasi, riparte direttamente
      // dal testo tradotto completo senza ripetere le centinaia di chiamate.
      if (meta.translationReady && meta.rawText?.trim()) {
        figuresRef.current = await getFigures(meta.id);
        sessionRef.current = {
          id: meta.id,
          fileName: meta.fileName,
          translatedFrom: meta.translatedFrom || null,
          sourceLanguage: meta.sourceLanguage || null,
          targetLanguage: meta.targetLanguage || null,
          translationFailures: meta.translationFailures || [],
          rawText: meta.rawText,
        };
        setRawText(meta.rawText);
        setTypstCode('');
        setStatus({ ocr: 'done', format: 'active', compile: 'pending' });
        setPhase('running');
        setActiveStep('format');
        setDetail('Riprendo dal testo tradotto già salvato…');
        refreshLanguageAudit(sessionRef.current);
        await startFormat(meta.rawText, meta.fileName, controller.signal);
        return meta;
      }

      // Fase formato: riprendi dai chunk non completati.
      figuresRef.current = await getFigures(meta.id);
      const storedFormatComplete = Boolean(
        (Array.isArray(meta.chunks) &&
          meta.chunks.length > 0 &&
          meta.chunks.every((chunk) => chunk.status === 'done')) ||
        (meta.status === 'done' && meta.editorCode?.trim()),
      );
      sessionRef.current = {
        id: meta.id,
        fileName: meta.fileName,
        translatedFrom: meta.translatedFrom || null,
        sourceLanguage: meta.sourceLanguage || null,
        targetLanguage: meta.targetLanguage || null,
        translationFailures: meta.translationFailures || [],
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
        pdfVerification: meta.pdfVerification || null,
      };
      setRawText(meta.rawText || '');
      setLayoutOptions(normalizeLayoutOptions(meta.layoutOptions || {}));
      const restoredCode = ensureExplicitHyphenation(
        meta.editorCode || combineDocument(meta.preamble || '', (meta.chunks || []).map((c) => c.body || '')),
      );
      sessionRef.current.editorCode = restoredCode;
      if (meta.editorCode && storedFormatComplete) {
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
      const formatComplete = Boolean(
        restoredCode.trim() &&
        storedFormatComplete,
      );
      setStatus({
        ocr: 'done',
        format: formatComplete ? 'done' : 'active',
        compile: formatComplete ? 'active' : 'pending',
      });
      setPhase('running');
      setActiveStep(formatComplete ? 'compile' : 'format');
      sessionRef.current.chunks.forEach((c) => {
        if (c.status === 'error') c.status = 'pending';
      });
      refreshLanguageAudit(sessionRef.current);
      if (formatComplete) {
        // Il sorgente è già definitivo: non attraversare nuovamente
        // processChunks/finalizeCompile. Sul desktop getCompiledPdf recupera
        // il PDF dalla cache persistente; la verifica testuale viene anch'essa
        // riusata se l'impronta di sorgente, fonte e figure coincide.
        setDetail(meta.pdfVerification
          ? 'Apro il PDF e la verifica già salvati…'
          : 'Apro il PDF salvato; prima verifica su questo dispositivo…');
        try {
          let pdfBytes = await getCompiledPdf(restoredCode);
          if (sessionRef.current.workflow === 'strict') {
            pdfBytes = await verifyStrictPdf(restoredCode, pdfBytes);
          }
          if (controller.signal.aborted) return meta;
          setPreviewPdf(pdfBytes);
          setStatus({ ocr: 'done', format: 'done', compile: 'done' });
          setActiveStep(null);
          setDetail('');
          setPhase('done');
          await persist();
        } catch (e) {
          if (controller.signal.aborted || e?.name === 'AbortError') return meta;
          setStatus({ ocr: 'done', format: 'done', compile: 'error' });
          setCompileError(await describeCompileError(
            restoredCode,
            e.message || 'Errore di compilazione Typst.',
          ));
          setActiveStep(null);
          setDetail('');
          setPhase('done');
        }
        return meta;
      }
      await runFormat(controller.signal);
      return meta;
    },
    [
      describeCompileError,
      getCompiledPdf,
      persist,
      refreshLanguageAudit,
      runFormat,
      runOcrPhase,
      startFormat,
      verifyStrictPdf,
    ],
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
      // La selezione del pannello copre solo le opzioni che il pannello
      // mostra: fondendola sopra quelle correnti, ciò che è stato dedotto dal
      // documento — il marcatore degli elenchi, per esempio — non viene
      // azzerato da una ristilizzazione che non lo riguarda.
      const normalized = normalizeLayoutOptions({ ...layoutOptions, ...sel });
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
    [typstCode, recompile, layoutOptions],
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
    if (s) s.editorCode = fixed;
    setTypstCode(fixed);
    const compiled = await recompile(fixed);
    if (!compiled) {
      if (s) {
        s.editorCode = typstCode;
      }
      setTypstCode(typstCode);
      return { ok: false, message: 'Correzioni annullate: il documento modificato non supera la verifica.' };
    }
    await persist();
    refreshLanguageAudit(s, fixed);
    if (speller) {
      const ignore = new Set(loadSpellIgnore());
      setSpellReport({ suspects: findSuspects(fixed, speller, ignore) });
    }
    return { ok: true, message: `Spaziatura sistemata: ${changes.join(' · ')}` };
  }, [typstCode, recompile, persist, refreshLanguageAudit]);

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
        const previousCorrections = strictSession?.corrections || [];
        try {
          const pdfBytes = await getCompiledPdf(code);
          if (strictSession) {
            strictSession.corrections = [
              ...previousCorrections,
              ...applied.map((a) => ({
                before: a.word,
                after: a.fix,
                type: 'spelling',
                count: a.count,
                authority: 'typst',
              })),
            ];
            await verifyStrictPdf(code, pdfBytes);
          }
          setPreviewPdf(pdfBytes);
          setCompileError(null);
        } catch (eAfter) {
          if (strictSession) {
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
        if (sessionRef.current) sessionRef.current.editorCode = code;
        setTypstCode(code);
        await persist();
        refreshLanguageAudit(sessionRef.current, code);
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
    [getCompiledPdf, persist, refreshLanguageAudit, spellReport, typstCode, settings, verifyStrictPdf],
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
    setProofreadDetail(`Avvio ${phaseEngineLabel(settings, 'proof')}…`);
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
            ? `Nessuna correzione applicata (${skipped} proposte scartate dal controllo di sicurezza) · ${phaseEngineLabel(settings, 'proof')}.`
            : `Rilettura completata con ${phaseEngineLabel(settings, 'proof')}: nessun refuso contestuale da correggere.`,
        };
      }
      // Rete di sicurezza: se compilava PRIMA ma non DOPO, si annulla tutto.
      const strictSession = sessionRef.current?.workflow === 'strict' ? sessionRef.current : null;
      const previousCorrections = strictSession?.corrections || [];
      try {
        const pdfBytes = await getCompiledPdf(code);
        if (strictSession) {
          strictSession.corrections = [
            ...previousCorrections,
            ...changes.map((c) => ({ ...c, type: 'contextual', authority: 'typst' })),
          ];
          await verifyStrictPdf(code, pdfBytes);
        }
        setPreviewPdf(pdfBytes);
        setCompileError(null);
      } catch (eAfter) {
        if (strictSession) {
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
      if (sessionRef.current) sessionRef.current.editorCode = code;
      setTypstCode(code);
      await persist();
      refreshLanguageAudit(sessionRef.current, code);
      return {
        ok: true,
        message:
          `Rilettura applicata a ${changed} paragrafi (refusi OCR, parole ` +
          `spezzate o fuse, accenti e virgolette)` +
          (skipped ? ` · ${skipped} proposte scartate dal controllo` : '') +
          ` · ${phaseEngineLabel(settings, 'proof')}.`,
      };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, message: 'Rilettura annullata.' };
      return { ok: false, message: e.message || 'Errore nella rilettura AI.' };
    } finally {
      setProofreadBusy(false);
      setProofreadDetail('');
    }
  }, [getCompiledPdf, persist, refreshLanguageAudit, typstCode, settings, verifyStrictPdf]);

  /**
   * Traduce o rilegge una selezione direttamente nel Typst autorevole. Gli
   * offset sono quelli visibili nell'editor: non esiste più un secondo testo
   * nascosto da localizzare o sincronizzare. Prima del salvataggio il sorgente
   * completo deve comunque superare il compilatore.
   */
  const reviseTextSelection = useCallback(async ({ start, end, mode }) => {
    const s = sessionRef.current;
    if (s?.workflow !== 'strict') {
      return {
        ok: false,
        message: 'Gli interventi IA sulla selezione richiedono il workflow rigoroso.',
      };
    }
    if (!['proof', 'translate'].includes(mode)) {
      return { ok: false, message: 'Tipo di intervento non riconosciuto.' };
    }
    const currentEditor = typstCode || s.editorCode || '';
    const selection = normalizeTextSelection(currentEditor, start, end);
    if (!selection.ok) return selection;
    if (/^\s*#(?:set|show|let|import|include)\b/mu.test(selection.text)) {
      return {
        ok: false,
        message: 'La selezione include il preambolo o comandi strutturali: evidenzia soltanto il testo visibile.',
      };
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setSelectionAiBusy(mode);
    setSelectionAiDetail(mode === 'translate'
      ? `Traduzione mirata · ${phaseEngineLabel(settings, 'translate')}…`
      : `Revisione mirata · ${phaseEngineLabel(settings, 'proof')}…`);
    try {
      let revisedText = '';
      let proofChanges = [];
      if (mode === 'proof') {
        const proof = await proofreadBody({
          settings,
          code: selection.text,
          batchSize: 8,
          signal: controller.signal,
          onProgress: (done, total) => setSelectionAiDetail(
            `Revisione mirata · ${done}/${total} passaggi…`,
          ),
        });
        if (!proof.checked) {
          return {
            ok: false,
            message: 'La selezione contiene soltanto struttura Markdown/Typst: seleziona una frase o un paragrafo di prosa.',
          };
        }
        if (!proof.changed) {
          return {
            ok: true,
            message: proof.skipped
              ? `Nessuna modifica applicata: ${proof.skipped} proposte non hanno superato i controlli di sicurezza.`
              : 'Revisione mirata completata: il modello non ha rilevato correzioni necessarie.',
          };
        }
        revisedText = proof.code;
        proofChanges = proof.changes;
      } else {
        const context = selectiveTranslationContext(currentEditor, selection);
        const translated = await translateMarkdown({
          settings,
          markdown: selection.text,
          externalBefore: context.before,
          externalAfter: context.after,
          signal: controller.signal,
          onProgress: (done, total) => setSelectionAiDetail(
            `Traduzione mirata · ${done}/${total} blocchi…`,
          ),
        });
        if (translated.failed) {
          return {
            ok: false,
            message: 'La risposta non ha superato i controlli di lingua o struttura; la selezione è rimasta invariata.',
          };
        }
        revisedText = translated.markdown.trim();
        if (!revisedText) {
          return {
            ok: false,
            message: 'Il modello non ha restituito una traduzione utilizzabile; la selezione è rimasta invariata.',
          };
        }
      }

      if (!revisedText || revisedText === selection.text) {
        return { ok: true, message: 'Il testo restituito coincide con la selezione: nessuna modifica necessaria.' };
      }
      if (!preservesMarkdownStructure(selection.text, revisedText)) {
        return {
          ok: false,
          message: 'La risposta altererebbe la struttura del brano; la selezione è rimasta invariata.',
        };
      }
      const missing = missingInvariants(selection.text, revisedText);
      const added = missingInvariants(revisedText, selection.text);
      if (missing.length || added.length) {
        return {
          ok: false,
          message: `La proposta altererebbe numeri o riferimenti (${[...missing, ...added].slice(0, 4).join(', ')}): nessuna modifica applicata.`,
        };
      }

      let nextCode = replaceTextSelection(currentEditor, selection, revisedText);
      nextCode = ensureExplicitHyphenation(nextCode);
      setSelectionAiDetail('Compilo il Typst prima di salvare…');
      const checked = await diagnoseTypst(nextCode, figuresRef.current);
      if (!checked.ok) {
        const first = checked.diagnostics?.find((item) => item.severity === 'error') || checked.diagnostics?.[0];
        return {
          ok: false,
          message: `La proposta è stata annullata perché non compila${first?.line ? ` (riga ${first.line})` : ''}.`,
        };
      }

      const parts = splitPreamble(nextCode);
      if (mode === 'proof') {
        s.corrections = [
          ...(s.corrections || []),
          ...proofChanges.map((change) => ({
            ...change,
            type: 'selection_contextual',
            referenceStart: selection.start,
            authority: 'typst',
          })),
        ];
      }
      s.editorCode = nextCode;
      s.preamble = parts.preamble;
      s.chunks = [{
        ...(s.chunks?.[0] || {}),
        text: s.rawText,
        body: parts.body,
        status: 'done',
        fidelity: { coverage: 1, missing: [] },
      }];
      s.verified = false;
      s.pdfVerification = null;
      s.strictReview = [];
      s.strictReviewKey = null;
      releaseDesktopPdf(compiledPdfRef.current.pdf);
      compiledPdfRef.current = { source: '', figures: null, pdf: null };
      setTypstCode(nextCode);
      setPreviewPdf(null);
      setCompileError(null);
      setStrictReport((report) => report ? {
        ...report,
        corrections: s.corrections || [],
        pdf: null,
        strictReview: [],
      } : report);
      setStatus((current) => ({ ...current, format: 'done', compile: 'pending' }));
      setPhase('done');
      await persist();
      refreshLanguageAudit(s, nextCode);
      return {
        ok: true,
        message: mode === 'translate'
          ? `Selezione tradotta con ${phaseEngineLabel(settings, 'translate')} e verificata con Typst. Ricompila per aggiornare l’anteprima.`
          : `${proofChanges.length} correzioni puntuali applicate con ${phaseEngineLabel(settings, 'proof')} e verificate con Typst. Ricompila per aggiornare l’anteprima.`,
      };
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        return { ok: false, message: 'Intervento sulla selezione annullato: nessuna modifica applicata.' };
      }
      return { ok: false, message: error.message || 'Intervento IA sulla selezione non riuscito.' };
    } finally {
      setSelectionAiBusy(null);
      setSelectionAiDetail('');
    }
  }, [persist, refreshLanguageAudit, settings, typstCode]);

  /**
   * Traduce il documento in un SECONDO documento, lasciando intatto il primo.
   *
   * Non è un passaggio della pipeline ma una biforcazione: si parte dal testo
   * OCR — non dal Typst già impaginato, che porterebbe il modello a tradurre
   * anche i comandi — si traduce con contesto e frasi intere, e il risultato
   * entra nella normale fase di strutturazione sotto un id nuovo. Da lì in poi
   * è un documento come tutti gli altri: si modifica, si compila, si esporta.
   *
   * Le figure vengono duplicate sul nuovo id con gli stessi percorsi: il
   * Markdown tradotto continua a puntarci, e cancellare un documento non
   * svuota le immagini dell'altro.
   */
  const translateSession = useCallback(async () => {
    const source = sessionRef.current;
    const markdown = source?.rawText || rawText;
    if (!markdown?.trim()) {
      return { ok: false, message: 'Non c’è testo OCR da tradurre.' };
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setTranslateBusy(true);
    setTranslateDetail('');
    try {
      const sourceId = source?.id || 'unsaved';
      const translateModel = phaseConfig(settings, 'translate').model;
      const jobKey = translationJobKey({ markdown, settings, model: translateModel });
      const checkpoints = await getTranslationGroups(sourceId, jobKey);
      const result = await translateMarkdown({
        settings,
        markdown,
        signal: controller.signal,
        resumeGroups: checkpoints,
        onCheckpoint: (checkpoint) => saveTranslationGroup(sourceId, jobKey, checkpoint),
        onProgress: (done, total, resumed) => setTranslateDetail(
          `${done}/${total} passaggi${resumed ? ' · ripresa salvata' : ''}`,
        ),
      });
      if (controller.signal.aborted) return { ok: false, message: 'Traduzione annullata.' };

      const figures = figuresRef.current.length
        ? figuresRef.current
        : await getFigures(source.id).catch(() => []);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const label = languageLabel(settings.targetLang || 'en');
      const fileName = `${(source?.fileName || 'documento').replace(/\.[^.]+$/, '')} — ${label}`;

      figuresRef.current = figures;
      // Questo è il confine di durabilità della traduzione: prima di avviare
      // rilettura, progettazione Typst o compilazione salviamo il documento
      // italiano completo e le sue figure. Chiusure e crash successivi non
      // possono più costringere a ritradurlo.
      await saveFigures(id, figures);
      await saveSession({
        id,
        fileName,
        translatedFrom: source?.id || null,
        sourceLanguage: settings.sourceLang || 'auto',
        targetLanguage: settings.targetLang || 'en',
        translationFailures: result.failedBlockIds || [],
        rawText: result.markdown,
        preamble: '',
        chunks: [],
        workflow: settings.formatWorkflow === 'strict' ? 'strict' : 'legacy',
        translationReady: true,
        status: 'translated',
      });
      await refreshSessions();
      // Sessione nuova, non ripresa: `startFormat` riusa l'id di
      // `sessionRef.current`, quindi va impostato prima di chiamarlo.
      sessionRef.current = {
        id,
        fileName,
        translatedFrom: source?.id || null,
        sourceLanguage: settings.sourceLang || 'auto',
        targetLanguage: settings.targetLang || 'en',
        translationFailures: result.failedBlockIds || [],
      };
      setTypstCode('');
      setPreviewPdf(null);
      setCompileError(null);
      clearReview();
      setRawText(result.markdown);
      setStatus({ ...emptyStatus, ocr: 'done' });
      setPhase('running');
      await startFormat(result.markdown, fileName, controller.signal);
      await deleteTranslationJob(sourceId, jobKey);
      await refreshSessions();

      const notes = [];
      if (result.retried) notes.push(`${result.retried} passaggi ripetuti`);
      if (result.failed) {
        notes.push(`${result.failed} rimasti in lingua originale — sono segnalati nel Controllo lingua`);
      }
      return {
        ok: true,
        // Il chiamante usa `fileName` per aggiornare l'intestazione e il nome
        // del PDF scaricato: da qui in poi si lavora sulla traduzione, e
        // continuare a mostrare il nome dell'originale sarebbe una bugia.
        fileName,
        message:
          `Traduzione in ${label} completata: «${fileName}» è un documento a sé, ` +
          `l’originale resta invariato${notes.length ? ` · ${notes.join(' · ')}` : ''}.`,
      };
    } catch (e) {
      if (controller.signal.aborted || e?.name === 'AbortError') {
        return { ok: false, message: 'Traduzione annullata.' };
      }
      return { ok: false, message: e.message || 'Errore nella traduzione.' };
    } finally {
      setTranslateBusy(false);
      setTranslateDetail('');
    }
  }, [settings, rawText, startFormat, refreshSessions, clearReview]);

  /**
   * Ritraduce soltanto passaggi o pagine scelti. Ogni risposta viene valutata
   * e ribasata separatamente: un blocco respinto dal modello o non localizzato
   * nel Typst resta invariato, mentre tutti gli altri arrivano comunque alla
   * compilazione e al salvataggio finale.
   */
  const retranslatePassages = useCallback(async ({ ids = [], pages: pageSpec = '' } = {}) => {
    const s = sessionRef.current;
    if (s?.workflow !== 'strict') {
      return {
        ok: false,
        message: 'La ritraduzione selettiva richiede il workflow rigoroso.',
      };
    }
    const editor = typstCode || s.editorCode || '';
    if (!editor.trim()) return { ok: false, message: 'Nessun Typst da controllare.' };
    const targetLanguage = s.targetLanguage || inferTypstLanguage(
      editor,
      settings.targetLang || 'it',
    );
    const declaredSource = s.sourceLanguage && s.sourceLanguage !== targetLanguage
      ? s.sourceLanguage
      : 'auto';

    let requestedPages;
    try {
      requestedPages = parsePageSelection(pageSpec);
    } catch (error) {
      return { ok: false, message: error.message };
    }
    const wantedIds = new Set(ids || []);
    const wantedPages = new Set(requestedPages);
    const groupedAudit = auditTypstLanguage(editor, targetLanguage, declaredSource);
    const wantedPassageIds = new Set();
    for (const item of groupedAudit.items) {
      if (!wantedIds.has(item.id)) continue;
      for (const id of item.passageIds || [item.id]) wantedPassageIds.add(id);
    }
    const selected = typstDocumentPassages(editor)
      .map((passage) => ({
        ...passage,
        detection: detectPassageLanguage(
          passage.visibleText || passage.text,
          targetLanguage,
          declaredSource,
          { kind: passage.kind },
        ),
      }))
      .filter((passage) => (
        passage.translate && (
          // Gli id arrivano esclusivamente dal controllo lingua mostrato
          // nell'interfaccia. Per una pagina digitata a mano, invece, si
          // includono solo i passaggi effettivamente sospetti: tradurre anche
          // l'italiano già corretto sarebbe un rischio inutile.
          wantedPassageIds.has(passage.id) ||
          (wantedPages.has(passage.page) && passage.detection.suspicious)
        )
      ));
    if (!selected.length) {
      return {
        ok: false,
        message: requestedPages.length
          ? 'Nelle pagine indicate non risultano passaggi chiaramente fuori lingua.'
          : 'Nessun passaggio traducibile nella selezione.',
      };
    }
    const uniqueRequests = new Set(selected.map((passage) => passage.text)).size;
    if (uniqueRequests > 160 || selected.length > 1200) {
      return {
        ok: false,
        message: `La selezione richiede ${uniqueRequests} traduzioni per ${selected.length} occorrenze: dividila in gruppi più piccoli (massimo 160 testi distinti).`,
      };
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLanguageRepairBusy(true);
    setLanguageRepairDetail('Preparo la selezione…');
    setLanguageRepairReport(null);
    try {
      const replacements = [];
      const skipped = [];
      const skippedIds = new Set();
      const skip = (passage, reason) => {
        if (skippedIds.has(passage.id)) return;
        skippedIds.add(passage.id);
        skipped.push({
          id: passage.id,
          page: passage.page,
          reason,
          start: passage.start,
          end: passage.end,
          text: passage.text,
          sourceFormat: passage.sourceFormat,
          sample: (passage.visibleText || passage.text).replace(/\s+/g, ' ').trim().slice(0, 180),
        });
      };
      let completed = 0;
      const translationCache = new Map();
      // Ogni passaggio ha una richiesta propria. Il batching faceva dipendere
      // l'associazione dalla disciplina del modello nel ripetere tutte le
      // etichette: una sola omissione poteva rendere sospetti molti paragrafi
      // perfettamente traducibili. In una rilettura selettiva l'affidabilità
      // vale più del piccolo risparmio di chiamate, e il processo resta
      // comunque sequenziale per non saturare né API né hardware locale.
      for (const passage of selected) {
        if (controller.signal.aborted) throw new DOMException('Annullato', 'AbortError');
        const sourceLanguage = passage.detection.suspicious
          ? passage.detection.detectedLang
          : declaredSource;
        const cacheKey = `${sourceLanguage}\u0000${passage.text}`;
        const cachedTranslation = translationCache.get(cacheKey);
        if (cachedTranslation) {
          replacements.push({ ...passage, translated: cachedTranslation });
          completed++;
          continue;
        }
        const context = selectiveTranslationContext(editor, passage);
        setLanguageRepairDetail(
          `Ritraduco ${completed + 1}/${selected.length}` +
          `${passage.page ? ` · pagina ${passage.page}` : ''}…`,
        );
        try {
          const result = await translateMarkdown({
            settings: { ...settings, sourceLang: sourceLanguage, targetLang: targetLanguage },
            markdown: passage.text,
            externalBefore: context.before,
            externalAfter: context.after,
            signal: controller.signal,
          });
          const proposal = result.blockTranslations?.[0];
          const translated = proposal?.after?.trim();
          if (!proposal) {
            skip(passage, 'Il modello non ha restituito il passaggio richiesto.');
            continue;
          }
          if (proposal.failed) {
            skip(
              passage,
              proposal.failureReason || 'La risposta non ha superato i controlli di sicurezza.',
            );
            continue;
          }
          if (!translated) {
            skip(passage, 'Il modello ha restituito una risposta vuota.');
            continue;
          }
          if (translated === passage.text.trim()) {
            skip(passage, 'Il testo restituito è rimasto invariato.');
            continue;
          }
          const missing = missingInvariants(passage.text, translated);
          if (missing.length) {
            skip(
              passage,
              `La proposta perderebbe numeri o riferimenti: ${missing.slice(0, 4).join(', ')}.`,
            );
            continue;
          }
          translationCache.set(cacheKey, translated);
          replacements.push({ ...passage, translated });
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') throw error;
          const reason = String(error?.message || 'errore del modello').replace(/\s+/g, ' ').slice(0, 160);
          skip(passage, `Richiesta non completata: ${reason}`);
        } finally {
          completed++;
        }
      }

      setLanguageRepairDetail('Verifico il sorgente Typst senza applicare modifiche…');
      let nextEditor = editor;
      const applied = [...replacements];
      // Gli offset arrivano dal Typst stesso e vengono applicati dal fondo:
      // non serve più cercare un equivalente in una fonte nascosta.
      for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
        if (editor.slice(replacement.start, replacement.end) !== replacement.text) {
          skip(replacement, 'Il passaggio è cambiato nell’editor durante la ritraduzione.');
          const index = applied.indexOf(replacement);
          if (index >= 0) applied.splice(index, 1);
          continue;
        }
        nextEditor = nextEditor.slice(0, replacement.start) + replacement.translated +
          nextEditor.slice(replacement.end);
      }
      if (!applied.length) {
        const report = { applied: 0, skipped: skipped.length, items: skipped };
        setLanguageRepairReport(report);
        return {
          ok: true,
          report,
          message: `${skipped.length} passaggi lasciati invariati: nessuna proposta ha superato tutti i controlli. ` +
            'Apri il resoconto nel pannello Traduzione per vedere i motivi.',
        };
      }
      // Se il passaggio inglese era rimasto accanto alla sua traduzione, la
      // sostituzione produce due paragrafi italiani uguali. Li riconosciamo
      // solo quando sono adiacenti e testualmente identici, poi ribasiamo la
      // rimozione con il contesto completo per scegliere l'occorrenza giusta.
      let removedDuplicates = 0;
      for (const duplicate of findAdjacentTypstDuplicatePassages(nextEditor).sort((a, b) => b.start - a.start)) {
        nextEditor = nextEditor.slice(0, duplicate.start) + nextEditor.slice(duplicate.end);
        removedDuplicates++;
      }
      const checked = await diagnoseTypst(nextEditor, figuresRef.current);
      if (!checked.ok) {
        // Se è stata la sola deduplicazione automatica a creare un problema,
        // conserva comunque tutte le ritraduzioni già verificate nel rebase.
        if (removedDuplicates) {
          let withoutDedupeEditor = editor;
          for (const replacement of [...applied].sort((a, b) => b.start - a.start)) {
            withoutDedupeEditor = withoutDedupeEditor.slice(0, replacement.start) +
              replacement.translated + withoutDedupeEditor.slice(replacement.end);
          }
          if ((await diagnoseTypst(withoutDedupeEditor, figuresRef.current)).ok) {
            nextEditor = withoutDedupeEditor;
            removedDuplicates = 0;
          } else {
            const first = checked.diagnostics?.find((diag) => diag.severity === 'error') || checked.diagnostics?.[0];
            throw new Error(
              `Le proposte applicabili non superano il compilatore Typst${first?.line ? ` (riga ${first.line})` : ''}. ` +
              'Il documento è rimasto invariato.',
            );
          }
        } else {
          const first = checked.diagnostics?.find((diag) => diag.severity === 'error') || checked.diagnostics?.[0];
          throw new Error(
            `Le proposte applicabili non superano il compilatore Typst${first?.line ? ` (riga ${first.line})` : ''}. ` +
            'Il documento è rimasto invariato.',
          );
        }
      }

      const parts = splitPreamble(nextEditor);
      s.editorCode = nextEditor;
      s.preamble = parts.preamble;
      s.chunks = [{
        ...(s.chunks?.[0] || {}),
        text: s.rawText,
        body: parts.body,
        status: 'done',
        fidelity: { coverage: 1, missing: [] },
      }];
      s.verified = false;
      s.strictReview = [];
      s.strictReviewKey = null;
      releaseDesktopPdf(compiledPdfRef.current.pdf);
      compiledPdfRef.current = { source: '', figures: null, pdf: null };
      setTypstCode(nextEditor);
      setPreviewPdf(null);
      setCompileError(null);
      setStrictReport((report) => report ? { ...report, pdf: null, strictReview: [] } : report);
      setStatus((current) => ({ ...current, format: 'done', compile: 'pending' }));
      setPhase('done');
      await persist();
      refreshLanguageAudit(s, nextEditor);
      const report = { applied: applied.length, skipped: skipped.length, items: skipped };
      setLanguageRepairReport(report);
      return {
        ok: true,
        report,
        message:
          `${applied.length} passaggi ritradotti e verificati con Typst. ` +
          (skipped.length ? `${skipped.length} lasciati invariati; il processo è proseguito. ` : '') +
          (removedDuplicates ? `${removedDuplicates} duplicati adiacenti rimossi. ` : '') +
          'Il resto del documento è rimasto invariato; ricompila per aggiornare l’anteprima.',
      };
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        return { ok: false, message: 'Ritraduzione annullata: nessuna modifica applicata.' };
      }
      return { ok: false, message: error.message || 'Ritraduzione selettiva non riuscita.' };
    } finally {
      setLanguageRepairBusy(false);
      setLanguageRepairDetail('');
    }
  }, [settings, typstCode, persist, refreshLanguageAudit]);

  /** Elimina in locale le ripetizioni esatte scelte e verifica il Typst. */
  const removeDuplicatePassages = useCallback(async ({ ids = [] } = {}) => {
    const s = sessionRef.current;
    if (s?.workflow !== 'strict') {
      return { ok: false, message: 'La rimozione sicura dei duplicati richiede il workflow rigoroso.' };
    }
    const editor = typstCode || s.editorCode || '';
    const wanted = new Set(ids || []);
    const freshAudit = auditTypstDuplicates(editor);
    const selected = freshAudit.items.filter((item) => wanted.has(item.id));
    if (!selected.length) return { ok: false, message: 'Nessun duplicato ancora valido nella selezione.' };

    setDuplicateRepairBusy(true);
    setDuplicateRepairDetail('Localizzo le ripetizioni nel Typst…');
    try {
      let nextEditor = editor;
      let removed = 0;
      for (const duplicate of [...selected].sort((a, b) => b.start - a.start)) {
        nextEditor = nextEditor.slice(0, duplicate.start) + nextEditor.slice(duplicate.end);
        removed++;
      }
      if (!removed) {
        return {
          ok: false,
          message: 'Le ripetizioni selezionate non sono state localizzate in modo univoco; nessuna modifica applicata.',
        };
      }
      setDuplicateRepairDetail('Verifico il sorgente con Typst…');
      const checked = await diagnoseTypst(nextEditor, figuresRef.current);
      if (!checked.ok) {
        const first = checked.diagnostics?.find((diag) => diag.severity === 'error') || checked.diagnostics?.[0];
        return {
          ok: false,
          message: `La rimozione non supera Typst${first?.line ? ` (riga ${first.line})` : ''}; il documento è rimasto invariato.`,
        };
      }

      const parts = splitPreamble(nextEditor);
      s.editorCode = nextEditor;
      s.preamble = parts.preamble;
      s.chunks = [{
        ...(s.chunks?.[0] || {}),
        text: s.rawText,
        body: parts.body,
        status: 'done',
        fidelity: { coverage: 1, missing: [] },
      }];
      s.verified = false;
      s.strictReview = [];
      s.strictReviewKey = null;
      releaseDesktopPdf(compiledPdfRef.current.pdf);
      compiledPdfRef.current = { source: '', figures: null, pdf: null };
      setTypstCode(nextEditor);
      setPreviewPdf(null);
      setCompileError(null);
      setStrictReport((report) => report ? { ...report, pdf: null, strictReview: [] } : report);
      setStatus((current) => ({ ...current, format: 'done', compile: 'pending' }));
      setPhase('done');
      await persist();
      refreshLanguageAudit(s, nextEditor);
      return {
        ok: true,
        message: `${removed} duplicati rimossi localmente e verificati con Typst. ` +
          'Ricompila per aggiornare l’anteprima.',
      };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || 'Controllo duplicati non riuscito; il documento è rimasto invariato.',
      };
    } finally {
      setDuplicateRepairBusy(false);
      setDuplicateRepairDetail('');
    }
  }, [typstCode, persist, refreshLanguageAudit]);

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
      const occurrence = s.corrections.slice(0, index).filter(
        (item) => item.before === correction.before && item.after === correction.after,
      ).length;
      // Prima modifica il Typst autorevole. Il vecchio testo OCR serve solo
      // come coordinata di recupero per registri creati prima di questa
      // versione, mai come stato da sincronizzare sopra l'editor.
      let nextCode = replaceContextualText(typstCode, currentText, target, {
        referenceSource: currentCanonical,
        referenceFind: correction.before,
        occurrence,
        replaceCount: Math.max(1, Number(correction.count) || 1),
      });
      const temporaryCanonical = replaceContextualText(currentCanonical, currentText, target, {
        referenceSource: s.rawText,
        referenceFind: correction.before,
        occurrence,
        replaceCount: Math.max(1, Number(correction.count) || 1),
      });
      if (nextCode == null && temporaryCanonical != null) {
        nextCode = rebaseStrictRevision({
          editorCode: typstCode,
          currentCanonical,
          nextCanonical: temporaryCanonical,
          before: currentText,
          after: target,
          layoutPlan: s.layoutPlan || {},
        });
      }
      if (nextCode == null) {
        return {
          ok: false,
          message: 'Il passaggio non è più presente nel Typst o non ha un contesto univoco: nessuna modifica applicata.',
        };
      }
      nextCode = ensureExplicitHyphenation(nextCode);

      const previous = {
        corrections: s.corrections,
        editorCode: s.editorCode,
        preamble: s.preamble,
        chunks: s.chunks,
      };
      const pdfBytes = await getCompiledPdf(nextCode);
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
      refreshLanguageAudit(s, nextCode);
      return { ok: true, message: 'Scelta applicata e PDF ricontrollato.' };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, message: 'Revisione annullata.' };
      return { ok: false, message: e.message || 'Impossibile revisionare questa correzione.' };
    } finally {
      setStrictCorrectionBusy(null);
    }
  }, [getCompiledPdf, persist, refreshLanguageAudit, settings, typstCode, verifyStrictPdf]);

  /** Azioni sui passaggi discordanti fra fonte canonica e PDF compilato. */
  const reviewStrictIssue = useCallback(async (index, action) => {
    const s = sessionRef.current;
    const issue = strictReport?.pdf?.issues?.[index];
    if (s?.workflow !== 'strict' || !issue) return { ok: false, message: 'Passaggio non più disponibile.' };
    setStrictIssueBusy({ index, action });
    const saveResolution = async (value) => {
      const next = { ...(s.strictIssueResolutions || {}), [issue.key]: value };
      s.strictIssueResolutions = next;
      const covered = strictReport.pdf?.issues?.reduce(
        (total, item) => total + item.missing.length,
        0,
      ) || 0;
      const allArtifacts =
        covered >= (strictReport.pdf?.missing?.length || 0) &&
        strictReport.pdf?.issues?.every((item) => next[item.key]?.status === 'artifact');
      const pdf = strictReport.pdf ? {
        ...strictReport.pdf,
        contentOk: strictReport.pdf.missingInvariants?.length === 0 && allArtifacts,
      } : strictReport.pdf;
      s.verified = pdf?.contentOk === true;
      if (pdf) {
        const key = await createPdfVerificationKey({
          source: s.editorCode || typstCode,
          canonicalText: typstPlainText(s.editorCode || typstCode),
          figures: figuresRef.current,
          issueResolutions: next,
        });
        s.pdfVerification = { key, contentOk: s.verified, checkedAt: Date.now(), pdf };
      }
      setStrictReport((report) => {
        if (!report) return report;
        return {
          ...report,
          strictIssueResolutions: next,
          issueResolutions: next,
          pdf,
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
      let nextCode;
      if (action === 'apply-ai' && review.choice === 'proposal') {
        nextCode = replaceContextualText(typstCode, issue.source, review.text, {
          referenceSource: typstPlainText(typstCode),
          referenceFind: issue.source,
        });
        // Compatibilità con vecchi rapporti nati dal riferimento OCR: il
        // rebase può ancora localizzare il blocco, senza promuovere l'OCR a
        // nuovo stato del documento.
        if (nextCode == null) {
          const temporaryCanonical = replaceUniqueText(currentCanonical, issue.source, review.text);
          if (temporaryCanonical != null) {
            nextCode = rebaseCanonicalRevision(
              typstCode,
              currentCanonical,
              temporaryCanonical,
              s.layoutPlan || {},
            );
          }
        }
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
        editorCode: s.editorCode,
        preamble: s.preamble,
        chunks: s.chunks,
        corrections: s.corrections,
        resolutions: s.strictIssueResolutions,
      };
      const pdfBytes = await getCompiledPdf(nextCode);
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
      refreshLanguageAudit(s, nextCode);
      return { ok: true, message: 'Passaggio rigenerato, compilato e confrontato nuovamente.' };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, message: 'Revisione annullata.' };
      return { ok: false, message: e.message || 'Impossibile revisionare il passaggio.' };
    } finally {
      setStrictIssueBusy(null);
    }
  }, [getCompiledPdf, persist, refreshLanguageAudit, settings, strictReport, typstCode, verifyStrictPdf]);

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
    canonicalText: sessionRef.current?.canonicalText || rawText,
    strictWorkflow: sessionRef.current?.workflow === 'strict',
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
    proofModelLabel: phaseEngineLabel(settings, 'proof'),
    selectionAiBusy,
    selectionAiDetail,
    reviseTextSelection,
    translateBusy,
    translateDetail,
    translateSession,
    translationModelLabel: phaseEngineLabel(settings, 'translate'),
    languageAudit,
    languageRepairBusy,
    languageRepairDetail,
    languageRepairReport,
    duplicateAudit,
    duplicateRepairBusy,
    duplicateRepairDetail,
    retranslatePassages,
    recheckLanguage,
    recheckDuplicates,
    removeDuplicatePassages,
    resume,
    reset,
    cancel,
  };
}

function activeStepFromStatus(s) {
  return Object.keys(s).find((k) => s[k] === 'active') || null;
}
