import { useCallback, useEffect, useRef, useState } from 'react';
import { extractPageBlocks } from '../lib/nvidia.js';
import { toTypst } from '../lib/gemini.js';
import { compileToPdf, pdfObjectUrl, initTypst } from '../lib/typst.js';
import { fileToDataUrl, isPdf } from '../lib/files.js';
import { renderPdfToImages } from '../lib/pdf.js';
import { assemblePage, makeFigureCounter } from '../lib/assemble.js';
import {
  chunkDocument,
  splitPreamble,
  outlineFromBody,
  combineDocument,
  normalizeHeadingLevels,
  enforceHeadingLevels,
} from '../lib/session.js';
import {
  saveSession,
  saveFigures,
  getFigures,
  listSessions,
  deleteSession,
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

// Le tre fasi dello split delle operazioni, nell'ordine mostrato all'utente.
export const STEPS = [
  { id: 'ocr', label: 'Estrazione testo', hint: 'NVIDIA Nemotron-Parse' },
  { id: 'format', label: 'Formattazione layout', hint: 'Google Gemini → Typst' },
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
  const [pdfUrl, setPdfUrl] = useState(null);
  const [compileError, setCompileError] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [detail, setDetail] = useState(''); // sotto-progresso della fase attiva
  const [chunkProgress, setChunkProgress] = useState(null); // {done,total} | null
  const [canResume, setCanResume] = useState(false); // sessione interrotta ripristinabile
  const [sessions, setSessions] = useState([]); // sessioni salvate su IndexedDB
  const figuresRef = useRef([]); // figure ritagliate dal documento originale
  const sessionRef = useRef(null); // { id, fileName, rawText, chunks, preamble, styleHint }

  const abortRef = useRef(null);
  const pdfUrlRef = useRef(null);

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
    const allDone = s.chunks.every((c) => c.status === 'done');
    await saveSession({
      id: s.id,
      fileName: s.fileName,
      rawText: s.rawText,
      preamble: s.preamble,
      styleHint: s.styleHint || null,
      chunks: s.chunks.map((c) => ({ text: c.text, body: c.body, status: c.status })),
      status: allDone ? 'done' : 'paused',
    });
  }, []);

  const setPdf = useCallback((bytes) => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    const url = pdfObjectUrl(bytes);
    pdfUrlRef.current = url;
    setPdfUrl(url);
  }, []);

  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    if (pdfUrlRef.current) {
      URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = null;
    }
    setPhase('idle');
    setStatus(emptyStatus);
    setActiveStep(null);
    setError(null);
    setRawText('');
    setTypstCode('');
    setPdfUrl(null);
    setCompileError(null);
    setDetail('');
    setChunkProgress(null);
    setCanResume(false);
    figuresRef.current = [];
    sessionRef.current = null;
    refreshSessions(); // riallinea l'elenco al ritorno sulla home
  }, [refreshSessions]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Elabora i chunk della sessione con Gemini, uno alla volta, preservando
   * preambolo e gerarchia. Ritorna 'done' | 'error' | 'aborted'. In caso di
   * errore (es. rate limit) i chunk completati restano: la sessione è
   * ripristinabile con `resume`.
   */
  // Chiama Gemini con auto-retry sul rate limit (429/quota) e backoff
  // esponenziale: così documenti lunghi/libri si convertono "lentamente"
  // senza intervento manuale. Gli altri errori si propagano subito.
  const callGeminiWithRetry = useCallback(
    async (args, signal, chunkLabel) => {
      let delay = 15000;
      for (let attempt = 0; ; attempt++) {
        try {
          return await toTypst({ ...args, signal });
        } catch (e) {
          if (signal.aborted || e?.name === 'AbortError') throw e;
          if (!RETRYABLE_RE.test(e.message || '') || attempt >= 6) throw e;
          const secs = Math.round(delay / 1000);
          setDetail(`${chunkLabel} · servizio occupato: nuovo tentativo tra ${secs}s…`);
          await abortableSleep(delay, signal);
          delay = Math.min(delay * 2, 120000);
        }
      }
    },
    [],
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
          if (i === 0) {
            const code = await callGeminiWithRetry(
              {
                apiKey: settings.googleApiKey,
                model: settings.geminiModel,
                rawText: ch.text,
                styleHint: s.styleHint,
              },
              signal,
              label,
            );
            const { preamble, body } = splitPreamble(code);
            s.preamble = preamble;
            ch.body = enforceHeadingLevels(body, ch.text);
          } else {
            const prior = s.chunks
              .slice(0, i)
              .map((c) => c.body)
              .filter(Boolean)
              .join('\n\n');
            const body = await callGeminiWithRetry(
              {
                apiKey: settings.googleApiKey,
                model: settings.geminiModel,
                rawText: ch.text,
                styleHint: s.styleHint,
                continuation: { preamble: s.preamble, outline: outlineFromBody(prior) },
              },
              signal,
              label,
            );
            // Impone in modo deterministico i livelli di titolo del sorgente.
            ch.body = enforceHeadingLevels(body, ch.text);
          }
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
      try {
        const bytes = await compileToPdf(combined, figuresRef.current);
        if (signal.aborted) return;
        setPdf(bytes);
        setStatus((x) => ({ ...x, compile: 'done' }));
        setActiveStep(null);
        setPhase('done');
        persist(); // segna la sessione come completata
      } catch (e) {
        if (signal.aborted) return;
        // Errore di compilazione Typst: non fatale, l'editor resta usabile.
        setStatus((x) => ({ ...x, compile: 'error' }));
        setCompileError(e.message || 'Errore di compilazione Typst.');
        setActiveStep(null);
        setPhase('done');
      }
    },
    [setPdf, persist],
  );

  /** Esegue la fase 2+3 sulla sessione corrente (fresh o resume). */
  const runFormat = useCallback(
    async (signal) => {
      const r = await processChunks(signal);
      if (r === 'aborted') return;
      if (r === 'error') {
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
    [processChunks, finalizeCompile],
  );

  /** Riprende una sessione interrotta dai chunk non ancora completati. */
  const resume = useCallback(async () => {
    const s = sessionRef.current;
    if (!s?.chunks?.length) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    s.chunks.forEach((c) => {
      if (c.status === 'error') c.status = 'pending';
    });
    setError(null);
    setCanResume(false);
    setPhase('running');
    setActiveStep('format');
    setStatus((x) => ({ ...x, format: 'active' }));
    await runFormat(controller.signal);
  }, [runFormat]);

  /** Riprende una sessione salvata su IndexedDB (dopo chiusura dell'app). */
  const openSession = useCallback(
    async (meta) => {
      if (!meta) return null;
      const figs = await getFigures(meta.id);
      figuresRef.current = figs;
      sessionRef.current = {
        id: meta.id,
        fileName: meta.fileName,
        rawText: meta.rawText,
        chunks: meta.chunks.map((c) => ({ ...c })),
        preamble: meta.preamble || '',
        styleHint: meta.styleHint || undefined,
        lastError: '',
      };
      setRawText(meta.rawText || '');
      setTypstCode(combineDocument(meta.preamble || '', meta.chunks.map((c) => c.body || '')));
      setStatus({ ocr: 'done', format: 'active', compile: 'pending' });
      setCanResume(false);
      setError(null);
      setPhase('running');
      setActiveStep('format');
      const controller = new AbortController();
      abortRef.current = controller;
      sessionRef.current.chunks.forEach((c) => {
        if (c.status === 'error') c.status = 'pending';
      });
      await runFormat(controller.signal);
      return meta;
    },
    [runFormat],
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
        const bytes = await compileToPdf(source, figuresRef.current);
        setPdf(bytes);
        return true;
      } catch (e) {
        setCompileError(e.message || 'Errore di compilazione Typst.');
        return false;
      } finally {
        setCompiling(false);
      }
    },
    [typstCode, setPdf],
  );

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

      try {
        // [1/3] Estrazione testo (NVIDIA). Nemotron-Parse accetta solo
        // immagini: i PDF vengono prima rasterizzati pagina per pagina.
        setActiveStep('ocr');
        setStatus((s) => ({ ...s, ocr: 'active' }));
        setDetail('');

        let pageImages;
        if (isPdf(file)) {
          setDetail('Rendering del PDF…');
          const buffer = await file.arrayBuffer();
          pageImages = await renderPdfToImages(buffer, {
            maxPages: settings.maxPages,
            onProgress: (p, t) => setDetail(`Rendering pagina ${p}/${t}…`),
          });
        } else {
          pageImages = [await fileToDataUrl(file)];
        }
        if (signal.aborted) return;
        if (!pageImages.length) throw new Error('Nessuna pagina da elaborare.');

        const figCounter = makeFigureCounter();
        const parts = [];
        const figures = [];
        for (let i = 0; i < pageImages.length; i++) {
          if (pageImages.length > 1) {
            setDetail(`OCR pagina ${i + 1}/${pageImages.length}…`);
          }
          const blocks = await extractPageBlocks({
            apiKey: settings.nvidiaApiKey,
            endpoint: settings.nvidiaEndpoint,
            model: settings.nvidiaModel,
            imageDataUrl: pageImages[i],
            signal,
          });
          if (signal.aborted) return;
          // Ricostruisce il testo (gerarchia preservata) e ritaglia le figure.
          const page = await assemblePage(blocks, pageImages[i], figCounter);
          parts.push(
            pageImages.length > 1 ? `<!-- pagina ${i + 1} -->\n${page.markdown}` : page.markdown,
          );
          figures.push(...page.figures);
        }
        // Normalizza i livelli di titolo sull'INTERO documento (coerenza
        // gerarchica deterministica su tutte le pagine).
        const extracted = normalizeHeadingLevels(parts.join('\n\n'));

        figuresRef.current = figures;
        setDetail('');
        setRawText(extracted);
        setStatus((s) => ({ ...s, ocr: 'done' }));

        // [2/3] + [3/3] Formattazione a chunk (gerarchia continua) e
        // compilazione. La sessione persiste su IndexedDB per riprendere
        // dopo rate limit o chiusura dell'app.
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        sessionRef.current = {
          id,
          fileName: file.name,
          rawText: extracted,
          chunks: chunkDocument(extracted, settings.chunkSize).map((t) => ({
            text: t,
            body: '',
            status: 'pending',
          })),
          preamble: '',
          styleHint: undefined,
          lastError: '',
        };
        await saveFigures(id, figures);
        await persist();
        setActiveStep('format');
        setStatus((s) => ({ ...s, format: 'active' }));
        await runFormat(signal);
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
    [settings, runFormat, typstCode, persist],
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
    pdfUrl,
    compileError,
    compiling,
    chunkProgress,
    canResume,
    sessions,
    openSession,
    deleteSavedSession,
    refreshSessions,
    runPipeline,
    recompile,
    restyle,
    resume,
    reset,
    cancel,
  };
}

function activeStepFromStatus(s) {
  return Object.keys(s).find((k) => s[k] === 'active') || null;
}
