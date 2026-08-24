import { useEffect, useRef, useState } from 'react';
import { IconArrowLeft, IconDownload, IconSpinner, IconFile, IconShare } from './Icons.jsx';
import { isNativeApp } from '../lib/download.js';
import { loadPdfDocument } from '../lib/pdf.js';
import { hasPdfData } from '../lib/desktop.js';
import {
  choosePdfSearchPage,
  countPdfTextOccurrences,
  normalizePdfSearchText,
} from '../lib/pdfPreview.js';

const MAX_PREVIEW_WIDTH = 768;
const MAX_DEVICE_SCALE = 2;

function multiplyTransforms(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function highlightRects(items, viewport, query) {
  const normalizedQuery = normalizePdfSearchText(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(' ').filter((token) => token.length > 2);
  const usefulTokens = tokens.length ? tokens : [normalizedQuery];

  return items.flatMap((item, index) => {
    const itemText = normalizePdfSearchText(item?.str);
    if (!itemText) return [];
    const matches =
      itemText.includes(normalizedQuery) ||
      normalizedQuery.includes(itemText) ||
      usefulTokens.some((token) => itemText.includes(token) || token.includes(itemText));
    if (!matches || !Array.isArray(item.transform)) return [];

    const matrix = multiplyTransforms(viewport.transform, item.transform);
    const height = Math.max(3, Math.hypot(matrix[2], matrix[3]));
    const width = Math.max(3, (Number(item.width) || itemText.length * height * 0.45) * viewport.scale);
    return [{
      id: `${index}-${Math.round(matrix[4])}-${Math.round(matrix[5])}`,
      left: matrix[4],
      top: matrix[5] - height,
      width,
      height,
    }];
  });
}

/**
 * Anteprima paginata del PDF già compilato. Mantiene nel DOM un solo canvas:
 * anche un libro di centinaia di pagine non genera più un SVG monolitico con
 * centinaia di migliaia di nodi. Lo stesso artefatto (handle file desktop o
 * byte web) viene riusato dal download senza una seconda compilazione Typst.
 */
export default function PdfPreview({ pdfBytes, compiling, downloading, onDownload, searchTarget, documentKey }) {
  const native = isNativeApp();
  const viewportRef = useRef(null);
  const canvasRef = useRef(null);
  const textCacheRef = useRef(new Map());
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [availableWidth, setAvailableWidth] = useState(640);
  const [pageRatio, setPageRatio] = useState(1 / Math.sqrt(2));
  const [opening, setOpening] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [searching, setSearching] = useState(false);
  const [locatedSearch, setLocatedSearch] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [previewError, setPreviewError] = useState('');

  // La colonna può cambiare larghezza passando fra schede mobile e desktop.
  // Il canvas viene ridisegnato alla risoluzione visibile, mai a una misura
  // arbitrariamente alta per l'intero documento.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.max(240, Math.min(MAX_PREVIEW_WIDTH, node.clientWidth - 24));
        setAvailableWidth((current) => (Math.abs(current - width) > 2 ? width : current));
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // pdf.js riceve una copia dei byte e lavora nel proprio worker. Al cambio
  // documento il loading task precedente viene distrutto esplicitamente.
  // Cambiare documento riporta a pagina 1; RICOMPILARE lo stesso documento no:
  // durante l'anteprima live si sta guardando una pagina precisa, e tornare
  // ogni volta all'inizio di un libro di quattrocento pagine è insostenibile.
  const lastDocumentKeyRef = useRef(documentKey);
  useEffect(() => {
    setPdfDocument(null);
    setPageCount(0);
    if (lastDocumentKeyRef.current !== documentKey) {
      lastDocumentKeyRef.current = documentKey;
      setPageNumber(1);
    }
    setHighlights([]);
    setLocatedSearch(null);
    setPreviewError('');
    textCacheRef.current.clear();
    if (!hasPdfData(pdfBytes)) return undefined;

    let active = true;
    const loadingTask = loadPdfDocument(pdfBytes);
    setOpening(true);
    loadingTask.promise
      .then((doc) => {
        if (!active) return;
        setPdfDocument(doc);
        setPageCount(doc.numPages);
        setPageNumber((current) => Math.min(Math.max(1, current), doc.numPages));
      })
      .catch((error) => {
        if (active) setPreviewError(error?.message || 'Impossibile aprire l’anteprima PDF.');
      })
      .finally(() => {
        if (active) setOpening(false);
      });

    return () => {
      active = false;
      loadingTask.destroy();
    };
  }, [pdfBytes]);

  // La ricerca usa il layer testuale del PDF già aperto: nessuna nuova
  // compilazione e nessun SVG completo. L'indice dell'occorrenza nel sorgente
  // è un suggerimento; in caso di divergenza si mostra la prima pagina utile.
  useEffect(() => {
    if (!pdfDocument || !searchTarget?.text) {
      setLocatedSearch(null);
      setSearching(false);
      return undefined;
    }
    let active = true;
    setSearching(true);
    (async () => {
      const matchCounts = [];
      let seen = 0;
      for (let number = 1; number <= pdfDocument.numPages && active; number++) {
        let text = textCacheRef.current.get(number);
        if (text == null) {
          const page = await pdfDocument.getPage(number);
          try {
            const content = await page.getTextContent();
            text = content.items.map((item) => item.str || '').join(' ');
            textCacheRef.current.set(number, text);
          } finally {
            page.cleanup();
          }
        }
        let count = countPdfTextOccurrences(text, searchTarget.text);
        if (!count && /\s/.test(searchTarget.text)) {
          // PDF.js può separare una parola in più item senza spazio.
          count = countPdfTextOccurrences(text.replace(/\s+/g, ''), searchTarget.text.replace(/\s+/g, ''));
        }
        matchCounts.push(count);
        seen += count;
        const chosen = choosePdfSearchPage(matchCounts, searchTarget.occurrence);
        if (chosen >= 0 && searchTarget.occurrence < seen) break;
      }
      if (!active) return;
      const pageIndex = choosePdfSearchPage(matchCounts, searchTarget.occurrence);
      if (pageIndex >= 0) {
        const foundPage = pageIndex + 1;
        setLocatedSearch({ id: searchTarget.id, page: foundPage, text: searchTarget.text });
        setPageNumber(foundPage);
      } else {
        setLocatedSearch(null);
      }
    })()
      .catch(() => {
        if (active) setLocatedSearch(null);
      })
      .finally(() => {
        if (active) setSearching(false);
      });
    return () => {
      active = false;
    };
  }, [pdfDocument, searchTarget]);

  // Renderizza esclusivamente la pagina corrente. Il device scale è limitato
  // a 2: oltre non migliora la leggibilità nel pannello ma moltiplica memoria
  // e costo di rasterizzazione.
  useEffect(() => {
    if (!pdfDocument || !canvasRef.current || !pageCount) return undefined;
    let active = true;
    let renderTask = null;
    setRendering(true);
    setHighlights([]);

    (async () => {
      const page = await pdfDocument.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const cssScale = availableWidth / base.width;
        const cssViewport = page.getViewport({ scale: cssScale });
        const deviceScale = Math.min(MAX_DEVICE_SCALE, Math.max(1, window.devicePixelRatio || 1));
        const renderViewport = page.getViewport({ scale: cssScale * deviceScale });
        const canvas = canvasRef.current;
        if (!active || !canvas) return;

        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        canvas.style.width = `${Math.round(cssViewport.width)}px`;
        canvas.style.height = `${Math.round(cssViewport.height)}px`;
        setPageRatio(base.width / base.height);

        const context = canvas.getContext('2d', {
          alpha: false,
          // Consente a Chromium di scegliere una superficie accelerata e di
          // presentare il frame senza sincronizzarlo con il thread principale.
          desynchronized: true,
          willReadFrequently: false,
        });
        if (!context) throw new Error('Canvas non disponibile per l’anteprima PDF.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({ canvasContext: context, viewport: renderViewport });
        await renderTask.promise;

        if (active && locatedSearch?.page === pageNumber) {
          const content = await page.getTextContent();
          setHighlights(highlightRects(content.items, cssViewport, locatedSearch.text));
        }
      } finally {
        page.cleanup();
      }
    })()
      .catch((error) => {
        if (active && error?.name !== 'RenderingCancelledException') {
          setPreviewError(error?.message || 'Impossibile renderizzare questa pagina.');
        }
      })
      .finally(() => {
        if (active) setRendering(false);
      });

    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [availableWidth, locatedSearch, pageCount, pageNumber, pdfDocument]);

  const busy = compiling || opening;
  const previousPage = () => setPageNumber((number) => Math.max(1, number - 1));
  const nextPage = () => setPageNumber((number) => Math.min(pageCount, number + 1));

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-2 shrink-0 rounded-full bg-annote" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">Anteprima</h2>
          <span className="truncate text-xs text-faint">
            {pageCount ? `${pageCount} ${pageCount === 1 ? 'pagina' : 'pagine'}` : 'PDF paginato'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {pageCount > 1 && (
            <nav aria-label="Navigazione pagine PDF" className="mr-1 flex items-center gap-1">
              <button
                type="button"
                onClick={previousPage}
                disabled={pageNumber <= 1 || busy}
                aria-label="Pagina precedente"
                className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
              >
                <IconArrowLeft width={14} height={14} />
              </button>
              <span className="min-w-14 text-center text-xs tabular-nums text-muted" aria-live="polite">
                {pageNumber} / {pageCount}
              </span>
              <button
                type="button"
                onClick={nextPage}
                disabled={pageNumber >= pageCount || busy}
                aria-label="Pagina successiva"
                className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
              >
                <IconArrowLeft width={14} height={14} className="rotate-180" />
              </button>
            </nav>
          )}
          {native && (
            <button
              type="button"
              onClick={() => onDownload('share')}
              disabled={!hasPdfData(pdfBytes) || downloading}
              title="Condividi il PDF (foglio di condivisione)"
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconShare width={14} height={14} />
              <span className="hidden sm:inline">Condividi</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onDownload('save')}
            disabled={!hasPdfData(pdfBytes) || downloading}
            title={native ? 'Salva in Files: scegli cartella e nome' : 'Scarica il PDF'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading ? <IconSpinner width={14} height={14} /> : <IconDownload width={14} height={14} />}
            {downloading ? 'Preparo…' : native ? 'Salva PDF' : 'Scarica PDF'}
          </button>
        </div>
      </header>

      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-auto bg-surface-2 [contain:strict]">
        {hasPdfData(pdfBytes) ? (
          <div className="mx-auto max-w-3xl p-3">
            <div
              className="relative mx-auto overflow-hidden rounded-lg bg-white shadow-lg"
              style={{ width: availableWidth, aspectRatio: pageRatio }}
            >
              <canvas
                ref={canvasRef}
                className={`block max-w-full transition-opacity ${rendering ? 'opacity-70' : 'opacity-100'}`}
                aria-label={`Pagina ${pageNumber} di ${pageCount || 1}`}
              />
              {highlights.map((rect) => (
                <span
                  key={rect.id}
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-sm bg-[#ffde59]/45 outline outline-1 outline-[#b56d00]/70"
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="grid size-full place-items-center p-8 text-center">
            <div className="max-w-xs">
              <span className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-surface-3 text-faint">
                <IconFile width={22} height={22} />
              </span>
              <p className="text-sm text-muted">
                L’anteprima apparirà qui. Modifica il codice Typst e premi
                <span className="text-ink"> Genera PDF</span> per aggiornarla.
              </p>
            </div>
          </div>
        )}

        {(busy || searching) && (
          <div className="absolute inset-0 grid place-items-center bg-bg/70 backdrop-blur-sm">
            <div className="flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2 text-sm text-ink">
              <IconSpinner width={16} height={16} className="text-primary" />
              {searching ? 'Cerco nel PDF…' : compiling ? 'Compilazione Typst…' : 'Apro il PDF…'}
            </div>
          </div>
        )}

        {previewError && !busy && (
          <div role="alert" className="absolute inset-x-3 bottom-3 rounded-lg border border-danger/40 bg-surface px-3 py-2 text-xs text-danger">
            {previewError}
          </div>
        )}
      </div>
    </section>
  );
}
