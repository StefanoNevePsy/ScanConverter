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
export async function extractPageText({ apiKey, endpoint, imageDataUrl, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');

  const body = {
    model: 'nvidia/nemotron-parse',
    tools: [{ type: 'function', function: { name: 'markdown_no_bbox' } }],
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
    res = await fetch(endpoint, {
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

  const data = await res.json();
  const text = pickExtractedText(data);
  if (!text || !text.trim()) {
    throw new Error('La risposta di NVIDIA NIM non conteneva testo estraibile.');
  }
  return text.trim();
}

/** Estrae il testo dai formati di risposta noti (tool_calls prima di tutto). */
function pickExtractedText(data) {
  const message = data?.choices?.[0]?.message;

  // Formato ufficiale nemotron-parse: tool_calls con arguments JSON {text}
  const call = message?.tool_calls?.[0]?.function;
  if (call?.arguments) {
    try {
      const args =
        typeof call.arguments === 'string'
          ? JSON.parse(call.arguments)
          : call.arguments;
      if (args?.text) return args.text;
      if (args?.markdown) return args.markdown;
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
