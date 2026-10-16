/*
  Fase 1 — Estrazione OCR/parsing con NVIDIA NIM (modello Nemotron-Parse).

  Contratto verificato sulla documentazione NVIDIA (NIM Vision Language
  Models · nemotron-parse):
    - Input: SOLO immagini (`image_url` con data URI base64). I PDF vanno
      rasterizzati a immagini prima della chiamata (vedi src/lib/pdf.js).
    - `tools: [{ type: 'function', function: { name: 'markdown_no_bbox' } }]`
      chiede il testo trascritto in Markdown senza bounding box.
    - Risposta: il testo è in
      `choices[0].message.tool_calls[0].function.arguments` → JSON con `.text`.

  Il parser resta comunque tollerante (gestisce anche `message.content` e
  formati strutturati) per non rompersi se il NIM cambia forma di risposta.
*/

import { SYSTEM_PROMPT, buildGuidance, unwrapCodeBlock } from './gemini.js';

/**
 * Esegue l'OCR di UNA immagine (una pagina).
 *
 * @param {object} params
 * @param {string} params.apiKey        NVIDIA_API_KEY
 * @param {string} params.endpoint      URL del NIM Nemotron-Parse
 * @param {string} params.imageDataUrl  data URL immagine (`data:image/png;base64,...`)
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>} testo estratto (Markdown)
 */
/**
 * Esegue l'OCR di UNA immagine restituendo i BLOCCHI strutturati
 * (markdown_bbox): ogni blocco ha `type` (Section-header, Text, Picture,
 * Caption, Table, …), `bbox` normalizzata e `text` in Markdown. Questo
 * preserva la gerarchia dei titoli e localizza le figure.
 *
 * @returns {Promise<Array<{type:string,bbox:object,text:string}>>}
 */
export async function extractPageBlocks({ apiKey, endpoint, model, imageDataUrl, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');

  // Modelli di visione generici (es. Nemotron 3.5 Super VL): non hanno il
  // protocollo a «tools» dei parser, si chiede la pagina in Markdown con i
  // titoli marcati. Niente riquadri: niente figure ritagliate.
  if (model && !/parse/i.test(model)) {
    return [{ type: 'Text', bbox: null, text: await visionPageMarkdown({ apiKey, endpoint, model, imageDataUrl, signal }) }];
  }
  const data = await callNemotron({ apiKey, endpoint, model, imageDataUrl, tool: 'markdown_bbox', signal });
  if (isParseV2(model)) {
    try {
      return parseV2Blocks(data, await imageDims(imageDataUrl));
    } catch (error) {
      // Il servizio ospitato di Parse 2.0 risponde spesso vuoto (solo token
      // <s> ripetuti). Invece di fermare il libro, la pagina passa alla
      // versione 1, che sullo stesso endpoint funziona.
      console.warn('Nemotron-Parse 2.0 senza testo, ripiego su nemotron-parse:', error.message);
      return extractPageBlocks({ apiKey, endpoint, model: 'nvidia/nemotron-parse', imageDataUrl, signal });
    }
  }
  const args = parseToolArguments(data);
  // markdown_bbox può annidare i blocchi: [[{...}]] oppure [{...}]
  const blocks = Array.isArray(args?.[0]) ? args[0] : args;
  if (Array.isArray(blocks) && blocks.length && blocks[0]?.type) {
    return blocks;
  }
  // Fallback: nessuna struttura → un unico blocco di testo.
  const text = pickExtractedText(data);
  if (!text.trim()) throw new Error('La risposta di NVIDIA NIM non conteneva testo estraibile.');
  return [{ type: 'Text', bbox: null, text }];
}

/** Variante testuale semplice (markdown_no_bbox) — usata come fallback. */
export async function extractPageText({ apiKey, endpoint, model, imageDataUrl, signal }) {
  const data = await callNemotron({ apiKey, endpoint, model, imageDataUrl, tool: 'markdown_no_bbox', signal });
  const text = pickExtractedText(data);
  if (!text || !text.trim()) {
    throw new Error('La risposta di NVIDIA NIM non conteneva testo estraibile.');
  }
  return text.trim();
}

const VISION_OCR_PROMPT =
  'Trascrivi ESATTAMENTE il testo di questa pagina di libro in Markdown. ' +
  'Marca i titoli con # (capitolo), ## (sezione), ### (sottosezione) secondo la ' +
  'loro evidenza grafica. Elenchi puntati con «- », numerati con «1. ». Ometti ' +
  'testatina e numero di pagina. Non tradurre, non correggere, non commentare: ' +
  'solo il testo della pagina.';

async function visionPageMarkdown({ apiKey, endpoint, model, imageDataUrl, signal }) {
  const text = await nvidiaChat({
    apiKey,
    endpoint,
    model,
    user: [
      { type: 'image_url', image_url: { url: imageDataUrl } },
      { type: 'text', text: VISION_OCR_PROMPT },
    ],
    temperature: 0,
    maxTokens: 6000,
    signal,
  });
  const clean = String(text || '').replace(/^```(?:markdown)?\s*|\s*```$/g, '').trim();
  if (!clean) throw new Error(`Il modello «${model}» non ha restituito testo per questa pagina.`);
  return clean;
}

/** Nemotron-Parse 2.x: protocollo a prompt invece che a «tools». */
export function isParseV2(model) {
  return /nemotron-parse-(?:v)?2/i.test(String(model || ''));
}

const PARSE_V2_PROMPT = '</s><s><predict_bbox><predict_classes><output_markdown><predict_no_text_in_pic>';

// Il modello lavora su una tela fissa: la pagina è rimpicciolita per starci
// dentro e il resto è riempito a destra e in basso. Le coordinate escono in
// frazioni della TELA, non della pagina.
const PARSE_V2_CANVAS = { width: 1664, height: 2048 };

async function imageDims(dataUrl) {
  if (typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Testo di Parse 2.0 → blocchi della pipeline.
 * Forma: `<x_0.1><y_0.2>testo<x_0.9><y_0.3><class_Text>` ripetuto.
 * Pura ed esportata per i test.
 */
export function parseV2Blocks(data, dims) {
  const raw = pickExtractedText(data) || '';
  const re = /<x_([\d.]+)><y_([\d.]+)>([\s\S]*?)<x_([\d.]+)><y_([\d.]+)><class_([^>]+)>/g;
  // Fattore tela→pagina: la pagina occupa solo una parte della tela.
  let fx = 1;
  let fy = 1;
  if (dims?.width && dims?.height) {
    const scale = Math.min(PARSE_V2_CANVAS.width / dims.width, PARSE_V2_CANVAS.height / dims.height);
    fx = PARSE_V2_CANVAS.width / (dims.width * scale);
    fy = PARSE_V2_CANVAS.height / (dims.height * scale);
  }
  const clamp = (n) => Math.min(1, Math.max(0, n));
  const blocks = [];
  for (const m of raw.matchAll(re)) {
    const type = m[6].trim();
    const text = m[3].replace(/<\/?s>/g, '').trim();
    const bbox = {
      xmin: clamp(Number(m[1]) * fx),
      ymin: clamp(Number(m[2]) * fy),
      xmax: clamp(Number(m[4]) * fx),
      ymax: clamp(Number(m[5]) * fy),
    };
    if (!text && !/Picture|Figure|Image|Chart|Table/i.test(type)) continue;
    blocks.push({ type: type === 'Chart' ? 'Picture' : type, bbox, text });
  }
  if (blocks.length) return blocks;
  const plain = raw.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (!plain) {
    throw new Error(
      'Nemotron-Parse 2.0 ha risposto senza testo. Il servizio online di questo ' +
        'modello a volte restituisce risposte vuote: riprova, oppure torna a ' +
        '«nvidia/nemotron-parse» o usa PaddleOCR.',
    );
  }
  return [{ type: 'Text', bbox: null, text: plain }];
}

async function callNemotron({ apiKey, endpoint, model, imageDataUrl, tool, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');

  // Parse 2.0 non usa i «tools» delle versioni 1.x: il compito si chiede con
  // un prompt di token di controllo. Mandargli `tools` fa rispondere al NIM
  // 400 «auto tool choice requires --enable-auto-tool-choice».
  const body = isParseV2(model)
    ? {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PARSE_V2_PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        // Il NIM ospitato ha un contesto totale di 4096 token (immagine +
        // prompt + risposta): chiederne di più fa rispondere 400.
        max_tokens: 3500,
        temperature: 0.0,
        top_k: 1,
        repetition_penalty: 1.1,
        skip_special_tokens: false,
      }
    : {
    model: model || 'nvidia/nemotron-parse',
    tools: [{ type: 'function', function: { name: tool } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: imageDataUrl } }],
      },
    ],
    temperature: 0.0,
  };

  let res;
  try {
    res = await fetch(resolveEndpoint(endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(
      'Impossibile contattare NVIDIA NIM (rete o CORS). Su web il browser ' +
        'può bloccare la chiamata cross-origin; nell’app Android le richieste ' +
        'passano in nativo (CapacitorHttp) e il problema non si presenta. ' +
        'Dettaglio: ' +
        e.message,
    );
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    if (res.status === 410 || res.status === 404) {
      throw new Error(
        `Il modello NVIDIA «${body.model}» non è più disponibile. Aprine un altro in ` +
          `Impostazioni → Motori per fase (pulsante ↻ per l’elenco aggiornato). Dettaglio: ${detail}`,
      );
    }
    throw new Error(`NVIDIA NIM ha risposto ${res.status}. ${detail}`);
  }

  return res.json();
}

/**
 * Fase 2 (alternativa a Gemini) — Strutturazione Typst con un modello NVIDIA.
 *
 * I NIM di NVIDIA espongono l'API OpenAI-compatibile chat/completions: si
 * inviano un messaggio di sistema (il tipografo) e uno utente (istruzioni +
 * testo OCR). La risposta è testo in `choices[0].message.content`, da cui si
 * estrae il codice Typst.
 *
 * @param {object} params
 * @param {string} params.apiKey    NVIDIA_API_KEY
 * @param {string} params.endpoint  URL chat/completions del NIM
 * @param {string} params.model     es. "meta/llama-3.3-70b-instruct"
 * @param {string} params.rawText   testo estratto dall'OCR
 * @param {string} [params.styleHint]
 * @param {{preamble:string,outline:string}} [params.continuation]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>} codice Typst
 */
/**
 * Chiamata chat generica (OpenAI-compatibile) a un NIM NVIDIA. Restituisce il
 * testo della risposta, già ripulito dagli eventuali blocchi di ragionamento.
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.endpoint  URL chat/completions
 * @param {string} p.model
 * @param {string} [p.system]  messaggio di sistema
 * @param {string} p.user      messaggio utente
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>}
 */
export async function nvidiaChat({ apiKey, endpoint, model, system, user, temperature = 0.2, maxTokens = 8192, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');

  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  let res;
  try {
    res = await fetch(resolveEndpoint(endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Impossibile contattare NVIDIA NIM (rete). ${e.message}`);
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    if (res.status === 410 || res.status === 404) {
      throw new Error(
        `Il modello NVIDIA «${body.model}» non è più disponibile. Aprine un altro in ` +
          `Impostazioni → Motori per fase (pulsante ↻ per l’elenco aggiornato). Dettaglio: ${detail}`,
      );
    }
    throw new Error(`NVIDIA NIM ha risposto ${res.status}. ${detail}`);
  }

  const data = await res.json();
  const finishReason = data?.choices?.[0]?.finish_reason;
  if (finishReason === 'length') {
    throw new Error('Il modello NVIDIA ha interrotto la risposta per limite di token.');
  }
  const msg = data?.choices?.[0]?.message;
  // Alcuni modelli "reasoning" antepongono il ragionamento: usiamo solo content.
  let text = typeof msg?.content === 'string' ? msg.content : '';
  if (Array.isArray(msg?.content)) {
    text = msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (!text.trim()) {
    throw new Error(`Il modello NVIDIA non ha restituito testo (finish_reason: ${finishReason || 'n/d'}).`);
  }
  return stripReasoning(text);
}

/**
 * Costruisce il messaggio utente della fase Typst. Estratto a parte perché è
 * identico per ogni motore: cambiando il modello non deve cambiare il prompt.
 */
export function buildTypstUser({ rawText, styleHint, continuation, fidelityNote, fixTypos, docContext }) {
  const guidance =
    buildGuidance(styleHint, { fixTypos, docContext }) +
    (continuation
      ? '\n\nCONTINUAZIONE DI DOCUMENTO: il documento è GIÀ iniziato. Il ' +
        'preambolo Typst è già definito, NON ripeterlo e NON usare #set / ' +
        '#show / #import. Restituisci SOLO il corpo che continua il ' +
        'documento, coerente con i livelli di titolo esistenti (non ' +
        'rinumerare, non ripartire da "= 1").\n' +
        'Preambolo già presente (solo per riferimento):\n' +
        continuation.preamble +
        '\n\nPosizione gerarchica corrente (continua da qui):\n' +
        (continuation.outline || '(inizio documento)')
      : '') +
    (fidelityNote ? '\n\n' + fidelityNote : '');

  return (
    guidance +
    '\n\nTesto estratto dall’OCR da convertire in Typst:\n\n"""\n' +
    rawText +
    '\n"""'
  );
}

export async function toTypstNvidia({ apiKey, endpoint, model, rawText, styleHint, continuation, fidelityNote, fixTypos, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');
  if (!rawText?.trim()) throw new Error('Nessun testo da formattare.');
  const text = await nvidiaChat({
    apiKey,
    endpoint,
    model: model || 'meta/llama-3.3-70b-instruct',
    system: SYSTEM_PROMPT,
    user: buildTypstUser({ rawText, styleHint, continuation, fidelityNote, fixTypos }),
    temperature: 0.2,
    maxTokens: 8192,
    signal,
  });
  return unwrapCodeBlock(text);
}

/**
 * Rimuove eventuali blocchi di ragionamento `<think>…</think>` che alcuni
 * modelli (es. DeepSeek-R1, Nemotron reasoning) inseriscono prima del codice.
 */
function stripReasoning(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Elenca i modelli disponibili sull'account NVIDIA (endpoint OpenAI-compatibile
 * `/v1/models`). Ritorna gli id ordinati alfabeticamente.
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} params.endpoint  endpoint chat/completions (se ne deriva /models)
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string[]>}
 */
export async function listNvidiaModels({ apiKey, endpoint, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante.');
  const url = resolveEndpoint(modelsUrlFromEndpoint(endpoint));
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`NVIDIA /models ha risposto ${res.status}.`);
  const data = await res.json();
  const ids = (data?.data || []).map((m) => m?.id).filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * L'elenco /v1/models è il CATALOGO intero: molti modelli rispondono poi
 * «Not found for account» perché il servizio gratuito non li offre a tutti
 * gli account. L'unico modo di saperlo è provarli con una richiesta minima.
 */
const NOT_CHAT = /embed|rerank|parse|ocr|guard|safety|reward|clip|vila|vision|vl\b|-vl-|paligemma|kosmos|deplot|neva|fuyu|nemoretriever|retriever|asr|tts|whisper|riva|audio|stable-diffusion|flux|sdxl|cosmos|bge|nv-embed|arctic-embed|detector|segment|grounding|pii|translate|code-?gemma|starcoder|codellama|granite-.*code/i;

export function chatCandidates(ids) {
  return ids.filter((id) => !NOT_CHAT.test(id));
}

export async function probeNvidiaModel({ apiKey, endpoint, model, signal, timeoutMs = 20000 }) {
  // Un modello che non risponde entro 20 secondi è inutilizzabile per un
  // libro: si passa al successivo invece di restare bloccati.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs);
  const onAbort = () => timer.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(resolveEndpoint(endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Rispondi solo: ok' }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: timer.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, status: 0, timedOut: e?.name === 'AbortError' };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Deriva l'URL `/v1/models` dall'endpoint chat/completions configurato. */
function modelsUrlFromEndpoint(endpoint) {
  const fallback = 'https://integrate.api.nvidia.com/v1/models';
  try {
    const u = new URL(endpoint);
    u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, '/models');
    if (!/\/models$/.test(u.pathname)) u.pathname = '/v1/models';
    u.search = '';
    return u.toString();
  } catch {
    return fallback;
  }
}

/** Ritorna l'array `arguments` del tool call, già parsato. */
function parseToolArguments(data) {
  const raw = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * In sviluppo web instrada l'endpoint NVIDIA verso il proxy del dev server
 * (`/__nvidia__`), aggirando l'assenza di CORS. In Node e in produzione
 * nativa (CapacitorHttp) resta l'URL reale.
 */
function resolveEndpoint(endpoint) {
  // Vite sostituisce staticamente `import.meta.env.DEV` (true in dev, false in
  // build). In Node l'accesso lancia: lo intercettiamo e trattiamo come prod.
  let dev = false;
  try {
    dev = import.meta.env.DEV;
  } catch {
    dev = false;
  }
  if (!dev) return endpoint;
  try {
    const u = new URL(endpoint);
    if (u.hostname.endsWith('api.nvidia.com')) {
      return '/__nvidia__' + u.pathname + u.search;
    }
  } catch {
    /* endpoint relativo: usa così com'è */
  }
  return endpoint;
}

/** Estrae il testo dai formati di risposta noti (tool_calls prima di tutto). */
function pickExtractedText(data) {
  const message = data?.choices?.[0]?.message;

  // Formato ufficiale nemotron-parse: tool_calls con `arguments` JSON.
  // Verificato sull'endpoint reale: arguments è un ARRAY [{text}, ...]
  // (un elemento per blocco); può anche essere un singolo oggetto {text}.
  const call = message?.tool_calls?.[0]?.function;
  if (call?.arguments) {
    try {
      const args =
        typeof call.arguments === 'string'
          ? JSON.parse(call.arguments)
          : call.arguments;
      const blocks = Array.isArray(args) ? args : [args];
      const text = blocks
        .map((b) => b?.text || b?.markdown || (typeof b === 'string' ? b : ''))
        .filter(Boolean)
        .join('\n\n');
      if (text) return text;
    } catch {
      // arguments non-JSON: usa il grezzo
      if (typeof call.arguments === 'string') return call.arguments;
    }
  }

  // Fallback: content standard (string o parti)
  if (typeof message?.content === 'string' && message.content) return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .join('\n');
  }

  // Fallback: formati strutturati
  if (typeof data?.markdown === 'string') return data.markdown;
  if (typeof data?.text === 'string') return data.text;
  if (Array.isArray(data?.data)) {
    return data.data
      .map((el) => el?.markdown || el?.text || el?.content || '')
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

async function safeErrorDetail(res) {
  try {
    const j = await res.json();
    return j?.detail || j?.error?.message || j?.message || JSON.stringify(j).slice(0, 300);
  } catch {
    try {
      return (await res.text()).slice(0, 300);
    } catch {
      return '';
    }
  }
}
