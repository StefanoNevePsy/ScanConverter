import { useCallback, useEffect, useRef, useState } from 'react';
import { extractPageBlocks } from '../lib/nvidia.js';
import { toTypst } from '../lib/gemini.js';
import { compileToPdf, pdfObjectUrl, initTypst } from '../lib/typst.js';
import { fileToDataUrl, isPdf } from '../lib/files.js';
import { renderPdfToImages } from '../lib/pdf.js';
import { assemblePage, makeFigureCounter } from '../lib/assemble.js';

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
  const figuresRef = useRef([]); // figure ritagliate dal documento originale

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
    figuresRef.current = [];
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
      const { signal } = controller;

      setError(null);
      setCompileError(null);
      setStatus((s) => ({ ...s, format: 'active', compile: 'pending' }));
      setPhase('running');
      setActiveStep('format');
      setDetail('Rigenerazione layout…');
      try {
        const code = await toTypst({
          apiKey: settings.googleApiKey,
          model: settings.geminiModel,
          rawText,
          styleHint,
          signal,
        });
        if (signal.aborted) return false;
        setTypstCode(code);
        setStatus((s) => ({ ...s, format: 'done', compile: 'active' }));
        setActiveStep('compile');
        const bytes = await compileToPdf(code, figuresRef.current);
        if (signal.aborted) return false;
        setPdf(bytes);
        setStatus((s) => ({ ...s, compile: 'done' }));
        setActiveStep(null);
        setDetail('');
        setPhase('done');
        return true;
      } catch (e) {
        setDetail('');
        if (signal.aborted || e?.name === 'AbortError') {
          setPhase('done');
          return false;
        }
        setError(e.message || 'Errore nella rigenerazione del layout.');
        setPhase('error');
        return false;
      }
    },
    [rawText, settings, setPdf],
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

        // [2/3] Formattazione layout (Gemini → Typst)
        setActiveStep('format');
        setStatus((s) => ({ ...s, format: 'active' }));
        const code = await toTypst({
          apiKey: settings.googleApiKey,
          model: settings.geminiModel,
          rawText: extracted,
          signal,
        });
        if (signal.aborted) return;
        setTypstCode(code);
        setStatus((s) => ({ ...s, format: 'done' }));

        // [3/3] Compilazione PDF (Typst WASM, locale)
        setActiveStep('compile');
        setStatus((s) => ({ ...s, compile: 'active' }));
        const bytes = await compileToPdf(code, figuresRef.current);
        if (signal.aborted) return;
        setPdf(bytes);
        setStatus((s) => ({ ...s, compile: 'done' }));

        setActiveStep(null);
        setDetail('');
        setPhase('done');
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
    [settings, setPdf, typstCode],
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
    runPipeline,
    recompile,
    restyle,
    reset,
    cancel,
  };
}

function activeStepFromStatus(s) {
  return Object.keys(s).find((k) => s[k] === 'active') || null;
}
