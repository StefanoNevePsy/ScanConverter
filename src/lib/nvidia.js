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

  const data = await callNemotron({ apiKey, endpoint, model, imageDataUrl, tool: 'markdown_bbox', signal });
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

async function callNemotron({ apiKey, endpoint, model, imageDataUrl, tool, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');

  const body = {
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
export async function toTypstNvidia({ apiKey, endpoint, model, rawText, styleHint, continuation, fidelityNote, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');
  if (!rawText?.trim()) throw new Error('Nessun testo da formattare.');

  const guidance =
    buildGuidance(styleHint) +
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

  const body = {
    model: model || 'meta/llama-3.3-70b-instruct',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          guidance +
          '\n\nTesto estratto dall’OCR da convertire in Typst:\n\n"""\n' +
          rawText +
          '\n"""',
      },
    ],
    temperature: 0.2,
    max_tokens: 8192,
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
    throw new Error(`NVIDIA NIM ha risposto ${res.status}. ${detail}`);
  }

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  // Alcuni modelli "reasoning" antepongono il ragionamento in `reasoning_content`
  // e mettono la risposta in `content`: usiamo sempre e solo `content`.
  let text = typeof msg?.content === 'string' ? msg.content : '';
  if (Array.isArray(msg?.content)) {
    text = msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (!text.trim()) {
    const reason = data?.choices?.[0]?.finish_reason;
    throw new Error(`Il modello NVIDIA non ha restituito codice (finish_reason: ${reason || 'n/d'}).`);
  }
  return unwrapCodeBlock(stripReasoning(text));
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
