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
} from '../lib/session.js';

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
  const figuresRef = useRef([]); // figure ritagliate dal documento originale
  const sessionRef = useRef(null); // { chunks, preamble, styleHint, lastError }

  const abortRef = useRef(null);
  const pdfUrlRef = useRef(null);

  // Precarica il WASM di Typst appena montato: rende istantanea la prima
  // compilazione quando la pipeline arriva alla fase 3.
  useEffect(() => {
    initTypst().catch(() => {
      /* l'errore reale emergerà alla prima compilazione con contesto utile */
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
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Elabora i chunk della sessione con Gemini, uno alla volta, preservando
   * preambolo e gerarchia. Ritorna 'done' | 'error' | 'aborted'. In caso di
   * errore (es. rate limit) i chunk completati restano: la sessione è
   * ripristinabile con `resume`.
   */
  const processChunks = useCallback(
    async (signal) => {
      const s = sessionRef.current;
      const total = s.chunks.length;
      for (let i = 0; i < total; i++) {
        const ch = s.chunks[i];
        const doneCount = s.chunks.filter((c) => c.status === 'done').length;
        setChunkProgress(total > 1 ? { done: doneCount, total } : null);
        if (ch.status === 'done') continue;
        setDetail(total > 1 ? `Layout: chunk ${i + 1}/${total}…` : '');
        try {
          if (i === 0) {
            const code = await toTypst({
              apiKey: settings.googleApiKey,
              model: settings.geminiModel,
              rawText: ch.text,
              styleHint: s.styleHint,
              signal,
            });
            const { preamble, body } = splitPreamble(code);
            s.preamble = preamble;
            ch.body = body;
          } else {
            const prior = s.chunks
              .slice(0, i)
              .map((c) => c.body)
              .filter(Boolean)
              .join('\n\n');
            const body = await toTypst({
              apiKey: settings.googleApiKey,
              model: settings.geminiModel,
              rawText: ch.text,
              styleHint: s.styleHint,
              continuation: { preamble: s.preamble, outline: outlineFromBody(prior) },
              signal,
            });
            ch.body = body;
          }
          ch.status = 'done';
          // Aggiorna progressivamente l'editor col documento parziale.
          setTypstCode(combineDocument(s.preamble, s.chunks.map((c) => c.body || '')));
        } catch (e) {
          if (signal.aborted || e?.name === 'AbortError') return 'aborted';
          ch.status = 'error';
          s.lastError = e.message || 'Errore Gemini.';
          return 'error';
        }
      }
      setChunkProgress(null);
      return 'done';
    },
    [settings],
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
      } catch (e) {
        if (signal.aborted) return;
        // Errore di compilazione Typst: non fatale, l'editor resta usabile.
        setStatus((x) => ({ ...x, compile: 'error' }));
        setCompileError(e.message || 'Errore di compilazione Typst.');
        setActiveStep(null);
        setPhase('done');
      }
    },
    [setPdf],
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
      sessionRef.current = {
        chunks: chunkDocument(rawText).map((t) => ({ text: t, body: '', status: 'pending' })),
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
        const extracted = parts.join('\n\n');

        figuresRef.current = figures;
        setDetail('');
        setRawText(extracted);
        setStatus((s) => ({ ...s, ocr: 'done' }));

        // [2/3] + [3/3] Formattazione a chunk (gerarchia continua) e
        // compilazione. La sessione gestisce internamente fasi ed errori.
        sessionRef.current = {
          chunks: chunkDocument(extracted).map((t) => ({ text: t, body: '', status: 'pending' })),
          preamble: '',
          styleHint: undefined,
          lastError: '',
        };
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
    [settings, runFormat, typstCode],
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
