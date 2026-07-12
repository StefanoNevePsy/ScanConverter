import { useCallback, useEffect, useRef, useState } from 'react';
import { extractPageBlocks, toTypstNvidia } from '../lib/nvidia.js';
import { toTypst, ocrImageGemini } from '../lib/gemini.js';
import { compileToPdf, compileToSvg, initTypst, locateTypstError } from '../lib/typst.js';
import { savePdf, sharePdf } from '../lib/download.js';
import { fileToDataUrl, isPdf } from '../lib/files.js';
import { renderPdfToImages } from '../lib/pdf.js';
import { assemblePage, makeFigureCounter, applyFigureWidths } from '../lib/assemble.js';
import { extractPdfText } from '../lib/pdftext.js';
import { isSpreadLike, preparePages } from '../lib/pagePrep.js';
import {
  chunkDocument,
  splitPreamble,
  outlineFromBody,
  combineDocument,
  normalizeHeadingLevels,
  enforceHeadingLevels,
} from '../lib/session.js';
import { buildPreamble, extractTitle } from '../lib/preamble.js';
import { autofixTypst, delimiterRepairCandidates } from '../lib/typstfix.js';
import { checkFidelity, fidelityNoteFrom } from '../lib/fidelity.js';
import { requestTypstFix, applyFixes, describeFix } from '../lib/aifix.js';
import {
  loadSpeller,
  findSuspects,
  requestSpellFixes,
  validateCorrections,
  applySpellFixes,
  fixSpacing,
} from '../lib/spell.js';
import { proofreadBody } from '../lib/proofread.js';
import {
  buildStrictDocument,
  buildDifferenceContexts,
  compareTokenInventory,
  compareTokenSequences,
  missingInvariants,
  repairBoundaryOverlaps,
  sourcePlainText,
} from '../lib/strict.js';
import { requestStrictDifferenceReview, requestStrictLayoutPlan } from '../lib/layoutPlan.js';
import { markTypstSearchMatch } from '../lib/searchPreview.js';
import { loadSpellIgnore, addSpellIgnore } from '../lib/storage.js';
import {
  saveSession,
  saveFigures,
  getFigures,
  deleteFigures,
  listSessions,
  deleteSession,
  savePages,
  getPages,
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
  { id: 'compile', label: 'Compilazione PDF', hint: 'Typst WASM · locale' },
];

const emptyStatus = { ocr: 'pending', format: 'pending', compile: 'pending' };

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
  const [previewSvg, setPreviewSvg] = useState(null); // anteprima vettoriale (SVG)
  const [compileError, setCompileError] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [downloading, setDownloading] = useState(false);
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
  const figuresRef = useRef([]); // figure ritagliate dal documento originale
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
   * bisezione (gli errori Typst non hanno numero di riga).
   */
  const describeCompileError = useCallback(async (source, message) => {
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

  /** Compila e confronta il layer testuale del PDF con la fonte canonica. */
  const verifyStrictPdf = useCallback(async (source, existingBytes = null) => {
    const s = sessionRef.current;
    if (s?.workflow !== 'strict') return existingBytes;
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
    const contentOk = inventory.missing.length === 0 && invariants.length === 0;
    const issues = buildDifferenceContexts(expected, actual, inventory.missing);
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
      layoutPlan: s.layoutPlan || null,
      strictReview: s.strictReview || [],
      strictReviewKey: s.strictReviewKey || null,
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
      styleHint: s.styleHint || null,
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
      verified: !!s.verified,
      layoutPlan: s.layoutPlan || null,
      status: allDone ? 'done' : 'paused',
    });
  }, []);

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
        parts: s.ocr.parts,
        figCount: s.ocr.figCount,
        source: s.ocr.source || 'ocr',
        comparisons: s.ocr.comparisons || [],
      },
      styleHint: s.styleHint || null,
    });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearReview();
    setPhase('idle');
    setStatus(emptyStatus);
    setActiveStep(null);
    setError(null);
    setRawText('');
    setTypstCode('');
    setPreviewSvg(null);
    setCompileError(null);
    setDetail('');
    setChunkProgress(null);
    setOcrProgress(null);
    setCanResume(false);
    setFidelityWarnings([]);
    setStrictReport(null);
    setSpellReport(null);
    figuresRef.current = [];
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
        nvidia
          ? toTypstNvidia({
              apiKey: settings.nvidiaApiKey,
              endpoint: settings.nvidiaEndpoint,
              model: settings.nvidiaTypstModel,
              rawText: args.rawText,
              styleHint: args.styleHint,
              continuation: args.continuation,
              fidelityNote: args.fidelityNote,
              fixTypos: settings.fixTypos,
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
      const combined = combineDocument(s.preamble, s.chunks.map((c) => c.body || ''));
      setTypstCode(combined);
      setStatus((x) => ({ ...x, format: 'done', compile: 'active' }));
      setActiveStep('compile');
      setDetail('');
      collectFidelity();
      try {
        if (s.workflow === 'strict') {
          setDetail('Verifica testuale del PDF compilato…');
          await verifyStrictPdf(combined);
          if (signal.aborted) return;
        }
        const svg = await compileToSvg(combined, figuresRef.current);
        if (signal.aborted) return;
        setPreviewSvg(svg);
        setStatus((x) => ({ ...x, compile: 'done' }));
        setActiveStep(null);
        setPhase('done');
        persist(); // segna la sessione come completata
      } catch (e) {
        if (signal.aborted) return;
        // Errore di compilazione Typst: non fatale, l'editor resta usabile.
        setStatus((x) => ({ ...x, compile: 'error' }));
        setCompileError(
          await describeCompileError(combined, e.message || 'Errore di compilazione Typst.'),
        );
        setActiveStep(null);
        setPhase('done');
      }
    },
    [persist, collectFidelity, describeCompileError, verifyStrictPdf],
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
        const boundaryRepair = repairBoundaryOverlaps(
          extracted,
          10,
          speller ? (word) => speller.correct(word) : null,
        );
        let canonicalText = boundaryRepair.text;
        let corrections = boundaryRepair.changes;
        if (settings.fixTypos) {
          setDetail('Correzione conservativa con registro delle modifiche…');
          const proof = await proofreadBody({
            settings,
            // Non ripartire dal testo originale: altrimenti la rilettura
            // annulla silenziosamente le riparazioni tra pagine appena fatte.
            code: canonicalText,
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
      let pageMap = pagesInMemory;
      if (!pageMap) {
        const stored = await getPages(s.id);
        pageMap = new Map(stored.map((p) => [p.index, p.dataUrl]));
      }
      for (let i = s.ocr.done; i < total; i++) {
        setOcrProgress({ done: i, total });
        const label = total > 1 ? `OCR pagina ${i + 1}/${total}` : 'Estrazione testo';
        setDetail(total > 1 ? `${label}…` : '');
        const dataUrl = pageMap.get(i);
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
          const blocks =
            settings.ocrEngine === 'gemini'
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
          const page = await assemblePage(blocks, dataUrl, figCounter);
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
      await savePages(id, pageImages);
      await persistOcr('ocr');
      const pageMap = new Map(pageImages.map((d, i) => [i, d]));
      await runOcrPhase(signal, pageMap);
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
    async (meta) => {
      if (!meta) return null;
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
            parts: meta.ocr.parts || new Array(meta.ocr.total).fill(null),
            figCount: meta.ocr.figCount || 0,
            source: meta.ocr.source || 'ocr',
            comparisons: meta.ocr.comparisons || new Array(meta.ocr.total).fill(null),
          },
          styleHint: meta.styleHint || undefined,
          lastError: '',
        };
        setRawText('');
        setTypstCode('');
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
        lastError: '',
        workflow: meta.workflow || 'legacy',
        canonicalText: meta.canonicalText || meta.rawText,
        corrections: meta.corrections || [],
        ocrComparisons: meta.ocrComparisons || [],
        layoutPlan: meta.layoutPlan || null,
        strictReview: meta.strictReview || [],
        strictReviewKey: meta.strictReviewKey || null,
        verified: meta.verified === true,
      };
      setRawText(meta.rawText || '');
      setTypstCode(combineDocument(meta.preamble || '', (meta.chunks || []).map((c) => c.body || '')));
      setStrictReport(
        meta.workflow === 'strict'
          ? {
              workflow: 'strict',
              corrections: meta.corrections || [],
              ocrComparisons: meta.ocrComparisons || [],
              layoutPlan: meta.layoutPlan || null,
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
        if (sessionRef.current?.workflow === 'strict') await verifyStrictPdf(source);
        const svg = await compileToSvg(source, figuresRef.current);
        setPreviewSvg(svg);
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
    [typstCode, describeCompileError, verifyStrictPdf],
  );

  /**
   * Ricompila soltanto l'anteprima con una singola occorrenza evidenziata.
   * Il sorgente salvato e il PDF scaricato non vengono mai modificati.
   */
  const previewSearchMatch = useCallback(
    async (match) => {
      const requestId = ++searchPreviewRef.current;
      if (!typstCode.trim()) return false;
      const source = match
        ? markTypstSearchMatch(typstCode, match.start, match.end)
        : typstCode;
      if (match && source === typstCode) return false;
      try {
        const svg = await compileToSvg(source, figuresRef.current);
        if (requestId !== searchPreviewRef.current) return false;
        setPreviewSvg(svg);
        return true;
      } catch {
        // Una ricerca dentro codice/preambolo resta selezionata nell'editor,
        // ma non deve sostituire un'anteprima PDF valida con un errore.
        return false;
      }
    },
    [typstCode],
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
        let bytes = await compileToPdf(typstCode, figuresRef.current);
        bytes = await verifyStrictPdf(typstCode, bytes);
        if (mode === 'share') await sharePdf(bytes, fileName || 'documento');
        else await savePdf(bytes, fileName || 'documento');
      } catch (e) {
        setCompileError(e.message || 'Errore nella generazione del PDF.');
      } finally {
        setDownloading(false);
      }
    },
    [typstCode, verifyStrictPdf],
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
      const preamble = buildPreamble(sel, { title: extractTitle(body) });
      const next = combineDocument(preamble, [body]);
      setTypstCode(next);
      // salva anche nel corpo della sessione (se attiva) per la persistenza
      if (sessionRef.current) sessionRef.current.preamble = preamble;
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
    const deterministic = autofixTypst(typstCode);
    let code = deterministic.fixed;
    const changes = [...deterministic.changes];
    let finalSvg = null;

    // Fino a quattro errori locali consecutivi. Ogni modifica resta solo in
    // memoria finché l'intero documento non compila: in caso di insuccesso
    // l'editor conserva esattamente il sorgente dell'utente.
    for (let round = 0; round < 4; round++) {
      try {
        finalSvg = await compileToSvg(code, figuresRef.current);
        break;
      } catch (compileFailure) {
        const message = compileFailure.message || String(compileFailure);
        if (!/unclosed|delimiter|unterminated|expected\s+.*[\])}]/i.test(message)) break;
        const location = await locateTypstError(code, figuresRef.current);
        const candidates = delimiterRepairCandidates(code, location?.line || 1);
        let progressed = null;
        for (const candidate of candidates) {
          try {
            const svg = await compileToSvg(candidate.fixed, figuresRef.current);
            progressed = { ...candidate, svg };
            break;
          } catch (candidateFailure) {
            // Se l'errore si è spostato in avanti, questa riparazione ha
            // risolto il blocco corrente: conservala provvisoriamente e passa
            // al successivo. Nulla viene salvato finché non compila tutto.
            const nextLocation = await locateTypstError(candidate.fixed, figuresRef.current);
            if (location && nextLocation?.line > location.line) {
              progressed = { ...candidate, svg: null };
              break;
            }
            const nextMessage = candidateFailure.message || String(candidateFailure);
            if (/unclosed|delimiter|unterminated/i.test(message) && !/unclosed|delimiter|unterminated/i.test(nextMessage)) {
              progressed = { ...candidate, svg: null };
              break;
            }
          }
        }
        if (!progressed) break;
        code = progressed.fixed;
        changes.push(progressed.description);
        if (progressed.svg) {
          finalSvg = progressed.svg;
          break;
        }
      }
    }

    if (finalSvg) {
      setTypstCode(code);
      setPreviewSvg(finalSvg);
      setCompileError(null);
      return { changes, ok: true };
    }
    // Mostra nuovamente l'errore arricchito, senza applicare tentativi non
    // verificati. Le sostituzioni statiche precedenti mantengono il vecchio
    // comportamento soltanto se erano effettivamente presenti.
    if (deterministic.changes.length) setTypstCode(deterministic.fixed);
    await recompile(deterministic.fixed);
    return { changes: deterministic.changes, ok: false };
    } finally {
      setCompiling(false);
    }
  }, [typstCode, recompile]);

  /**
   * Correzione AI puntiforme: compila → se fallisce chiede al modello forte
   * (fixEngine/fixModel) le sostituzioni minime {find, replace}, le applica e
   * ricompila; fino a 3 giri. Prova prima l'autofix deterministico (gratuito).
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
    try {
      const det = autofixTypst(code);
      if (det.changes.length) {
        code = det.fixed;
        log.push(...det.changes);
      }
      let lastError = '';
      for (let round = 0; round < 3; round++) {
        try {
          const svg = await compileToSvg(code, figuresRef.current);
          setTypstCode(code);
          setPreviewSvg(svg);
          setCompileError(null); // risolto: ora il banner può sparire
          return {
            ok: true,
            message: log.length
              ? `Corretto e compilato. Modifiche: ${log.join(' · ')}`
              : 'Il codice compila già, nessuna correzione necessaria.',
          };
        } catch (e) {
          lastError = e.message || 'Errore di compilazione Typst.';
          if (round === 2) break; // niente più tentativi AI
          // Localizza l'errore per bisezione: il modello riceve riga e blocco
          // indiziato (gli errori Typst non hanno posizione).
          const loc = await locateTypstError(code, figuresRef.current);
          const res = await requestTypstFix({ settings, code, error: lastError, hint: loc });
          const { code: next, applied } = applyFixes(code, res.fixes);
          if (!applied.length) {
            setTypstCode(code);
            setCompileError(await describeCompileError(code, lastError));
            return {
              ok: false,
              message:
                'L’AI non ha prodotto correzioni applicabili' +
                (res.explanation ? ` (${res.explanation})` : '.'),
            };
          }
          code = next;
          if (res.explanation && !log.includes(res.explanation)) log.push(res.explanation);
          log.push(...applied.map(describeFix));
        }
      }
      // Tre compilazioni fallite: mantieni comunque le modifiche applicate
      // (spesso avvicinano alla soluzione) e mostra l'errore residuo con la
      // posizione localizzata per bisezione.
      const described = await describeCompileError(code, lastError);
      setTypstCode(code);
      setCompileError(described);
      return {
        ok: false,
        message:
          (log.length ? `Applicate: ${log.join(' · ')} — ` : '') +
          `errore residuo: ${described}`,
      };
    } catch (e) {
      setCompileError(e.message || 'Errore nella correzione AI.');
      return { ok: false, message: e.message || 'Errore nella correzione AI.' };
    } finally {
      setAiFixing(false);
    }
  }, [typstCode, settings, describeCompileError]);

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
    const { fixed, changes } = fixSpacing(typstCode);
    if (!changes.length) {
      return { ok: true, message: 'Spaziatura e punteggiatura già a posto.' };
    }
    setTypstCode(fixed);
    await recompile(fixed);
    return { ok: true, message: `Spaziatura sistemata: ${changes.join(' · ')}` };
  }, [typstCode, recompile]);

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
        // A lotti, per non superare i limiti di output del modello.
        const proposals = [];
        for (let i = 0; i < suspects.length; i += 60) {
          proposals.push(
            ...(await requestSpellFixes({ settings, entries: suspects.slice(i, i + 60) })),
          );
        }
        // Guardrail deterministici: parola singola, nota ai dizionari, e
        // SOLO tra quelle inviate (mai «correzioni» a parole non richieste).
        const speller = await loadSpeller();
        const allowed = new Set(suspects.map((s) => s.word));
        const { ok: corrections, rejected } = validateCorrections(proposals, speller, allowed);
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
          const svg = await compileToSvg(code, figuresRef.current);
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
            await verifyStrictPdf(code);
          }
          setPreviewSvg(svg);
          setCompileError(null);
        } catch (eAfter) {
          if (strictSession) {
            strictSession.canonicalText = previousCanonical;
            strictSession.corrections = previousCorrections;
          }
          let beforeOk = false;
          try {
            await compileToSvg(before, figuresRef.current);
            beforeOk = true;
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
    [spellReport, typstCode, settings, verifyStrictPdf],
  );

  /**
   * Rilettura AI contestuale (italiano): ripristina gli accenti sugli omografi
   * («è»/«e», «sì»/«si»), reinserisce le parole-funzione saltate dall'OCR e
   * bilancia le caporali — la classe di errori che dizionario e fedeltà non
   * possono vedere. Guard di sicurezza in `proofreadBody`: mai rimuovere o
   * cambiare parole. Rete di sicurezza sulla compilazione come per l'ortografia.
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
            : 'Rilettura completata: nessun accento o parola da correggere.',
        };
      }
      // Rete di sicurezza: se compilava PRIMA ma non DOPO, si annulla tutto.
      const strictSession = sessionRef.current?.workflow === 'strict' ? sessionRef.current : null;
      const previousCanonical = strictSession?.canonicalText;
      const previousCorrections = strictSession?.corrections || [];
      try {
        const svg = await compileToSvg(code, figuresRef.current);
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
          await verifyStrictPdf(code);
        }
        setPreviewSvg(svg);
        setCompileError(null);
      } catch (eAfter) {
        if (strictSession) {
          strictSession.canonicalText = previousCanonical;
          strictSession.corrections = previousCorrections;
        }
        let beforeOk = false;
        try {
          await compileToSvg(before, figuresRef.current);
          beforeOk = true;
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
          `Rilettura applicata a ${changed} paragrafi (accenti, parole saltate, ` +
          `virgolette)` + (skipped ? ` · ${skipped} proposte scartate dal controllo` : '') + '.',
      };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, message: 'Rilettura annullata.' };
      return { ok: false, message: e.message || 'Errore nella rilettura AI.' };
    } finally {
      setProofreadBusy(false);
      setProofreadDetail('');
    }
  }, [typstCode, settings, verifyStrictPdf]);

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
      setFidelityWarnings([]);
      setOcrProgress(null);
      clearReview();
      figuresRef.current = [];

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
        setPageReview(
          pageImages.map((d, i) => ({
            index: i,
            url: d,
            rotate: 0,
            split: isSpreadLike(d),
          })),
        );
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
    previewSvg,
    downloadPdf,
    downloading,
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
    sessions,
    openSession,
    deleteSavedSession,
    refreshSessions,
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
