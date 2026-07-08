/*
  Fase 1 — Estrazione OCR/parsing con NVIDIA NIM (modello Nemotron-Parse).

  Il modello riceve l'immagine della pagina scansionata e restituisce il
  testo strutturato (Markdown/JSON), riconoscendo titoli, note e tabelle.

  Nota sul contratto: i NIM VLM di NVIDIA espongono in genere un'interfaccia
  compatibile con OpenAI Chat Completions, dove l'immagine viaggia come
  `image_url` con un data URI base64. Il parsing della risposta qui sotto è
  volutamente tollerante (gestisce sia `choices[].message.content` sia
  eventuali payload strutturati), così l'app resta funzionante se il NIM
  aggiorna la forma della risposta. Endpoint e modello sono configurabili
  dalle Impostazioni.
*/

/**
 * @param {object} params
 * @param {string} params.apiKey        NVIDIA_API_KEY
 * @param {string} params.endpoint      URL del NIM Nemotron-Parse
 * @param {string} params.imageDataUrl  data URL dell'immagine (`data:...;base64,...`)
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>} testo estratto (Markdown/JSON)
 */
export async function extractText({ apiKey, endpoint, imageDataUrl, signal }) {
  if (!apiKey) throw new Error('Chiave API NVIDIA mancante. Aprine le Impostazioni.');
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');

  const body = {
    // Il campo `model` viene ignorato dagli endpoint model-specific ma è
    // richiesto da quelli in stile /chat/completions: lo includiamo per
    // compatibilità.
    model: 'meta/nemotron-parse-1.1',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Esegui il parsing di questo documento scansionato. Restituisci ' +
              'il testo strutturato in Markdown preservando titoli, paragrafi, ' +
              'note a piè di pagina e tabelle.',
          },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.0,
    stream: false,
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
    // TypeError = fetch fallita a livello di rete/CORS prima della risposta.
    throw new Error(
      'Impossibile contattare NVIDIA NIM (rete o CORS). ' +
        'Se il browser blocca la chiamata cross-origin, instrada la ' +
        'richiesta tramite un proxy server-side. Dettaglio: ' +
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

/** Estrae il testo dai formati di risposta più comuni. */
function pickExtractedText(data) {
  // Formato OpenAI-compatibile
  const msg = data?.choices?.[0]?.message;
  if (msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((p) => (typeof p === 'string' ? p : p?.text || ''))
        .join('\n');
    }
  }
  // Possibili formati strutturati del document-parsing
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
