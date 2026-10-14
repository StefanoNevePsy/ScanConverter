/*
  Motore OCR PaddleOCR-VL — lo stesso modello, due strade.

  PaddleOCR-VL (Baidu, ~0,9 miliardi di parametri, licenza Apache 2.0) è fra
  i modelli più precisi nelle classifiche pubbliche di lettura di documenti, e
  restituisce quello che serve alla pipeline: blocchi con classe semantica
  (titolo, testo, tabella, figura, nota…), riquadro e ordine di lettura.

  Due modi di usarlo, con LO STESSO protocollo:
  - ONLINE: il servizio gratuito di Baidu AI Studio. Si crea un token e un
    indirizzo personale sulla pagina del modello, e si incollano qui.
  - LOCALE: il server in `tools/paddle-ocr`, che imita la stessa API
    (`POST /layout-parsing`). Niente quota, niente rete, le pagine non
    lasciano il computer.

  Siccome la risposta è identica, la conversione nei blocchi della pipeline è
  una sola, qui sotto, e si può provare senza rete né modello.
*/

export const DEFAULT_PADDLE_LOCAL_ENDPOINT = 'http://localhost:8001/layout-parsing';

/**
 * Classi di PaddleOCR-VL → tipi già noti alla pipeline (quelli di
 * Nemotron-Parse). Una classe sconosciuta diventa testo: perderla sarebbe
 * peggio che impaginarla come paragrafo.
 */
const LABELS = {
  doc_title: 'Title',
  paragraph_title: 'Section-header',
  figure_title: 'Caption',
  table_title: 'Caption',
  chart_title: 'Caption',
  image: 'Picture',
  chart: 'Picture',
  seal: 'Picture',
  header_image: 'Picture',
  footer_image: 'Picture',
  table: 'Table',
  formula: 'Formula',
  display_formula: 'Formula',
  footnote: 'Footnote',
  vision_footnote: 'Footnote',
  header: 'Page-header',
  footer: 'Page-footer',
  number: 'Page-footer',
};

/** Blocchi che esistono per la loro geometria anche senza testo. */
const VISUAL = new Set(['Picture']);

/**
 * Converte una tabella HTML (formato di PaddleOCR-VL) in tabella Markdown a
 * barre, che il resto della pipeline sa già leggere. Le celle unite
 * (`colspan`) diventano celle vuote: la griglia resta rettangolare.
 */
export function htmlTableToMarkdown(html) {
  const source = String(html || '');
  if (!/<t[dh][\s>]/i.test(source)) return source.trim();
  const rows = [];
  for (const row of source.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [];
    for (const cell of row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []) {
      const span = Number((cell.match(/colspan\s*=\s*["']?(\d+)/i) || [])[1]) || 1;
      const text = decodeEntities(cell.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      cells.push(text);
      for (let k = 1; k < span; k++) cells.push('');
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Risposta di `/layout-parsing` → blocchi della pipeline.
 * Pura: è la parte che si prova senza rete.
 *
 * @param {object} data   JSON della risposta
 * @param {{width?:number, height?:number}} [size] misure dell'immagine
 *        inviata, se la risposta non le riporta
 * @returns {Array<{type:string, bbox:object|null, text:string}>}
 */
export function paddleResponseToBlocks(data, size = {}) {
  if (data && data.errorCode && data.errorCode !== 0) {
    throw new Error(`PaddleOCR: ${data.errorMsg || `errore ${data.errorCode}`}`);
  }
  const page = data?.result?.layoutParsingResults?.[0];
  if (!page) throw new Error('PaddleOCR non ha restituito risultati per la pagina.');
  const pruned = page.prunedResult || {};
  const list = Array.isArray(pruned.parsing_res_list) ? pruned.parsing_res_list : null;

  // Senza elenco di blocchi resta il Markdown della pagina: si perde la
  // geometria (niente figure ritagliate), non il testo.
  if (!list) {
    const text = String(page.markdown?.text || '').trim();
    if (!text) throw new Error('PaddleOCR non ha restituito testo.');
    return [{ type: 'Text', bbox: null, text }];
  }

  const width = Number(pruned.width || size.width) || 0;
  const height = Number(pruned.height || size.height) || 0;
  const out = [];
  for (const block of list) {
    const label = String(block?.block_label || '').toLowerCase();
    const type = LABELS[label] || 'Text';
    let text = String(block?.block_content ?? '').trim();
    if (type === 'Table') text = htmlTableToMarkdown(text);
    if (type === 'Picture') text = '';
    const bbox = normalizeBox(block?.block_bbox, width, height);
    if (!text && !(VISUAL.has(type) && bbox)) continue;
    out.push({ type, bbox, text });
  }
  return out;
}

function normalizeBox(box, width, height) {
  if (!Array.isArray(box) || box.length < 4 || !width || !height) return null;
  const [x0, y0, x1, y1] = box.slice(0, 4).map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const clamp = (n) => Math.min(1, Math.max(0, n));
  return {
    xmin: clamp(Math.min(x0, x1) / width),
    ymin: clamp(Math.min(y0, y1) / height),
    xmax: clamp(Math.max(x0, x1) / width),
    ymax: clamp(Math.max(y0, y1) / height),
  };
}

/** Misure di un'immagine data URL (solo browser; altrove {}). */
async function imageSize(dataUrl) {
  if (typeof Image === 'undefined') return {};
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({});
    img.src = dataUrl;
  });
}

/**
 * OCR di una pagina con PaddleOCR-VL.
 *
 * @param {object} p
 * @param {'online'|'local'} p.mode
 * @param {string} [p.url]     indirizzo AI Studio (modalità online)
 * @param {string} [p.token]   token AI Studio (modalità online)
 * @param {string} [p.endpoint] indirizzo del server locale
 * @param {string} p.imageDataUrl
 * @param {AbortSignal} [p.signal]
 */
export async function paddleOcrBlocks({ mode = 'online', url, token, endpoint, imageDataUrl, signal }) {
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');
  const local = mode === 'local';
  const target = String(local ? endpoint || DEFAULT_PADDLE_LOCAL_ENDPOINT : url || '').trim();
  if (!target) {
    throw new Error(
      'Manca l’indirizzo del servizio PaddleOCR online. Copialo dalla pagina ' +
        'PaddleOCR-VL di Baidu AI Studio in Impostazioni → PaddleOCR.',
    );
  }
  if (!local && !String(token || '').trim()) {
    throw new Error('Manca il token di Baidu AI Studio (Impostazioni → PaddleOCR).');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (!local) headers.Authorization = `token ${String(token).trim()}`;
  const file = String(imageDataUrl).replace(/^data:[^;]+;base64,/, '');

  const send = () =>
    fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        file,
        fileType: 1,
        useDocOrientationClassify: false,
        useDocUnwarping: false,
      }),
      // In locale una pagina dura secondi: oltre 4 minuti il modello si è
      // incastrato, e aspettare oltre non serve.
      signal: local && typeof AbortSignal?.any === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(240000)].filter(Boolean))
        : signal,
    });
  let res;
  try {
    try {
      res = await send();
    } catch (first) {
      // Il server locale si spegne da solo quando non serve: sul desktop lo
      // si riaccende e si riprova una volta.
      const ensure = globalThis.window?.scanConverterDesktop?.paddleEnsure;
      if (!local || first?.name === 'AbortError' || typeof ensure !== 'function') throw first;
      const started = await ensure();
      if (!started?.ok) throw new Error(started?.detail || first.message);
      res = await send();
    }
  } catch (e) {
    if (e?.name === 'TimeoutError' || (local && e?.name === 'AbortError' && !signal?.aborted)) {
      const err = new Error(
        'Il server PaddleOCR locale non ha finito la pagina entro 4 minuti: il modello si è ' +
          'probabilmente incastrato. Riavvia il server e premi «Riprendi».',
      );
      err.local = true;
      throw err;
    }
    if (e?.name === 'AbortError') throw e;
    throw new Error(
      local
        ? `Server PaddleOCR locale non raggiungibile su ${target}. Avvialo da ` +
            'Impostazioni → PaddleOCR (o con lo script start-paddle-ocr). ' +
            `Dettaglio: ${e.message}`
        : `Impossibile contattare PaddleOCR online (rete o CORS). Nell’app ` +
            `desktop funziona; nel browser il servizio può rifiutare la chiamata. ` +
            `Dettaglio: ${e.message}`,
    );
  }
  if (res.status === 429) {
    const err = new Error('PaddleOCR: quota giornaliera o limite di velocità raggiunto.');
    err.status = 429;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('PaddleOCR ha rifiutato il token: controllalo in Impostazioni.');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (local) {
      // Il server locale non è mai «occupato»: un errore è un errore vero
      // (modello non caricato, memoria, libreria). Va mostrato subito, non
      // riprovato all'infinito come se fosse un limite di quota.
      let reason = detail;
      try {
        reason = JSON.parse(detail)?.errorMsg || detail;
      } catch {
        /* testo semplice */
      }
      const err = new Error(
        `Il server PaddleOCR locale ha avuto un problema leggendo la pagina: ${String(reason).slice(0, 400)}`,
      );
      err.local = true;
      throw err;
    }
    const err = new Error(`PaddleOCR ha risposto ${res.status}. ${detail.slice(0, 200)}`.trim());
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const pruned = data?.result?.layoutParsingResults?.[0]?.prunedResult;
  const size = pruned?.width && pruned?.height ? {} : await imageSize(imageDataUrl);
  return paddleResponseToBlocks(data, size);
}

/** Indirizzo /health del server locale, per la prova. */
export function paddleHealthUrl(endpoint) {
  return String(endpoint || DEFAULT_PADDLE_LOCAL_ENDPOINT).replace(/\/layout-parsing\/?$/, '/health');
}
