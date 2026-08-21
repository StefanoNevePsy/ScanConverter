/*
  Fase 2 — Strutturazione con Google Gemini.

  Il testo grezzo estratto dall'OCR viene convertito in codice Typst pulito
  e tipograficamente curato: margini ampi per le annotazioni manuali, serif
  eleganti per il corpo, sans per i titoli, vere note a piè di pagina.

  L'API generativelanguage di Google accetta chiamate dal browser con la
  chiave passata nell'header `x-goog-api-key`.
*/

export const SYSTEM_PROMPT =
  'Sei un esperto tipografo editoriale. Prendi questo testo estratto da un ' +
  'OCR e convertilo in codice Typst puro. Usa un layout accademico moderno: ' +
  'imposta margini generosi (almeno 4cm sul lato destro per consentire ' +
  'annotazioni manuali successive), usa font serif eleganti per il corpo del ' +
  'testo e sans-serif per i titoli. Converti le note testuali in vere note a ' +
  'piè di pagina Typst `footer: [...]` o `footnote[...]`. Restituisci SOLO il ' +
  'codice Typst all’interno di un blocco di codice pulito, senza altre ' +
  'spiegazioni.';

// Direttiva di correzione conservativa dei refusi OCR, iniettata nella fase di
// strutturazione quando l'utente attiva l'opzione. Il modello ha sotto gli
// occhi tutto il chunk (contesto di frase), quindi può risolvere ciò che il
// dizionario per-parola non vede: omografi accentati, parole-funzione saltate,
// virgolette. Volutamente prudente per non intaccare la fedeltà al testo.
export const TYPO_FIX_DIRECTIVE =
  'CORREZIONE REFUSI OCR (conservativa): il testo proviene da un OCR e può ' +
  'contenere errori di scansione. Mentre converti, CORREGGI SOLO gli errori ' +
  'materiali palesi, sfruttando il contesto della frase:\n' +
  '- accenti caduti o errati: «e»→«è» quando è il verbo essere, «piu»→«più», ' +
  '«perche»→«perché», «si»→«sì» quando è affermazione, «citta»→«città», ' +
  '«E»→«È» a inizio frase;\n' +
  '- parole-funzione brevi saltate dall’OCR dove resta un vuoto/doppio spazio ' +
  '(spesso la «è»): reinseriscile;\n' +
  '- parole spezzate o fuse dall’OCR: «Eravam o»→«Eravamo», «sistem a»→' +
  '«sistema», «Pra ta»→«Prata»;\n' +
  '- virgolette/caporali «» non bilanciate e punteggiatura palesemente errata.\n' +
  'NON riscrivere, NON parafrasare, NON tradurre, NON modernizzare, NON ' +
  'cambiare la scelta lessicale dell’autore né lo stile: solo refusi ' +
  'materiali. Nel dubbio, lascia il testo IDENTICO.';

/**
 * Costruisce le istruzioni tecniche (font, gerarchia, tabelle, vincoli Typst)
 * incluse anche nel "Copia prompt + testo" per gli LLM esterni. `styleHint`
 * riporta le scelte di impaginazione dell'utente; `fixTypos` aggiunge la
 * direttiva di correzione conservativa dei refusi OCR.
 * @param {string} [styleHint]
 * @param {{fixTypos?:boolean}} [opts]
 * @returns {string}
 */
export function buildGuidance(styleHint, opts = {}) {
  return (
    (opts.docContext
      ? 'CONTESTO DEL DOCUMENTO (per riconoscere il lessico specialistico e ' +
        'non scambiarlo per un refuso): ' +
        String(opts.docContext).trim().slice(0, 600) +
        '\n\n'
      : '') +
    'Font disponibili nel compilatore (usa SOLO questi nomi ESATTI): serif ' +
    '"Libertinus Serif", "New Computer Modern", "PT Serif"; sans-serif ' +
    '"DejaVu Sans", "PT Sans"; monospazio "DejaVu Sans Mono". NON usare altri ' +
    'font (es. "Linux Libertine", "Liberation Sans", "Times New Roman"): non ' +
    'sono disponibili.\n' +
    'GERARCHIA: preserva ESATTAMENTE i livelli di titolo del Markdown in ' +
    'ingresso — "# " → "= ", "## " → "== ", "### " → "=== ", "#### " → ' +
    '"==== " — senza appiattirli né rinumerarli.\n' +
    'FIGURE: ogni segnaposto Markdown `![didascalia](/figures/fig-N.png)` va ' +
    'convertito in `#figure(image("/figures/fig-N.png", width: 80%), ' +
    'caption: [didascalia])`, MANTENENDO il percorso esatto. Se il testo alt ' +
    'è VUOTO (`![](…)`) e nel documento non c’è una vera didascalia, usa ' +
    '`#figure(image("…", width: 80%))` SENZA `caption`: non inventare ' +
    'didascalie e non scrivere "Figura N" (la numerazione la aggiunge Typst). ' +
    'Non inventare né omettere immagini; non aggiungere immagini con altri ' +
    'percorsi.\n' +
    'DIALOGHI: le battute introdotte dal nome del parlante in MAIUSCOLO ' +
    'seguito da due punti (es. «TERAPISTA (rivolto a Sissi): …», «FIGLIO: …») ' +
    'vanno OGNUNA in un proprio paragrafo, MAI fuse insieme sulla stessa ' +
    'riga. Rendi il nome del parlante in grassetto (`*Terapista:*`) e ' +
    'l’eventuale indicazione tra parentesi in corsivo.\n' +
    'TABELLE: converti le tabelle LaTeX (`\\begin{tabular}{…}…\\end{tabular}`) ' +
    'e le tabelle Markdown in tabelle Typst native `#table(columns: N, ' +
    'table.header[…][…], …)`; usa `[*testo*]` per le celle di intestazione e ' +
    'preserva righe/colonne. Avvolgi in `#figure(…, caption: […])` se c’è una ' +
    'didascalia.\n' +
    'CORSIVO/ENFASI: preserva SEMPRE il corsivo del Markdown (`_testo_` o ' +
    '`*testo*`) con l’enfasi Typst `_testo_`. Un intero paragrafo in corsivo ' +
    'che sembra una trascrizione o una citazione lunga va reso come blocco ' +
    'citazione leggermente più piccolo: `#block(inset: (left: 1em))[#text(' +
    'size: 0.9em, style: "italic")[…]]`.\n' +
    'VINCOLI TECNICI (Typst 0.13) — il codice DEVE compilare senza errori:\n' +
    '- Spaziatura dei blocchi: usa `above:` / `below:` (i parametri `top:` e ' +
    '`bottom:` NON esistono su `block` e danno errore).\n' +
    '- Paragrafi: usa `#set par(...)`. La funzione `paragraph` NON esiste ' +
    '(`#set paragraph(...)` è un errore).\n' +
    '- Rientro prima riga: `#set par(first-line-indent: 1.5em)`.\n' +
    '- Non usare funzioni/variabili non definite; se definisci un `#let`, ' +
    'definiscilo PRIMA di usarlo. Non fare `#import` di pacchetti esterni.\n' +
    '- Converti eventuale HTML residuo (es. `<sup>1</sup>`) in costrutti Typst ' +
    'nativi (`footnote`/`super`). Chiudi sempre parentesi tonde e quadre.\n' +
    '- MATEMATICA: usa la sintassi Typst, NON LaTeX. Dentro `$…$` scrivi i ' +
    'simboli per nome SENZA backslash: `alpha`, `beta`, `->` (freccia), `<->` ' +
    '(doppia freccia), `<=` `>=` `!=`, `times`, `dot.c`, `sum`, `integral`, ' +
    '`infinity`, `sqrt(x)`, `frac(a, b)`, pedici `x_(i)` e apici `x^(2)` con ' +
    'le parentesi TONDE. NON usare mai `\\leftrightarrow`, `\\alpha`, `\\frac`, ' +
    '`\\left(`/`\\right)` né altri comandi LaTeX con backslash: in Typst danno ' +
    'errori come "unclosed delimiter" o testo spurio.\n' +
    '- Per la bibliografia scrivi una lista o dei paragrafi semplici; NON usare ' +
    'riferimenti `@etichetta` a meno di definire l’etichetta corrispondente.\n' +
    'NOTE A PIÈ DI PAGINA: se lo stesso richiamo (es. un unico asterisco) vale ' +
    'per più elementi (es. tutti gli autori), genera UNA sola `footnote` alla ' +
    'prima occorrenza: non duplicarla.\n' +
    'COMPLETEZZA: trascrivi INTEGRALMENTE il contenuto fornito, senza ' +
    'riassumere, accorciare né omettere frasi, esempi o paragrafi.' +
    (opts.fixTypos ? '\n\n' + TYPO_FIX_DIRECTIVE : '') +
    (styleHint
      ? '\n\nRICHIESTA DI STILE PRIORITARIA dell’utente (rispettala): ' + styleHint
      : '')
  );
}

/**
 * @param {object} params
 * @param {string} params.apiKey     GOOGLE_API_KEY
 * @param {string} params.model      es. "gemini-flash-latest"
 * @param {string} params.rawText    testo estratto dall'OCR
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>} codice Typst
 */
export async function toTypst({ apiKey, model, rawText, styleHint, continuation, fidelityNote, fixTypos, docContext, signal }) {
  if (!apiKey) throw new Error('Chiave API Google mancante. Aprine le Impostazioni.');
  if (!rawText?.trim()) throw new Error('Nessun testo da formattare.');

  // In dev web il proxy del dev server evita problemi di rete/CORS; in
  // produzione/nativo si usa l'URL diretto (Google supporta il CORS).
  let base = 'https://generativelanguage.googleapis.com';
  try {
    if (import.meta.env.DEV) base = '/__gemini__';
  } catch {
    /* Node/prod: URL diretto */
  }
  const endpoint = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

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

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              guidance +
              '\n\nTesto estratto dall’OCR da convertire in Typst:\n\n' +
              '"""\n' +
              rawText +
              '\n"""',
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new Error(`Impossibile contattare Google Gemini (rete). ${e.message}`);
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(`Google Gemini ha risposto ${res.status}. ${detail}`);
  }

  const data = await res.json();
  const finish = data?.candidates?.[0]?.finishReason;
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => p?.text || '').join('')
    : '';

  if (finish === 'MAX_TOKENS') {
    throw new Error('Gemini ha interrotto il codice per limite di token. Riduci la dimensione dei chunk e riprendi.');
  }

  if (!text.trim()) {
    const block = data?.promptFeedback?.blockReason;
    throw new Error(
      block
        ? `Richiesta bloccata da Gemini (${block}).`
        : `Gemini non ha restituito codice (finishReason: ${finish || 'n/d'}).`,
    );
  }

  return unwrapCodeBlock(text);
}

/** Base URL dell'API Gemini (proxy del dev server in sviluppo web). */
function geminiBase() {
  try {
    if (import.meta.env.DEV) return '/__gemini__';
  } catch {
    /* Node/prod: URL diretto */
  }
  return 'https://generativelanguage.googleapis.com';
}

/**
 * Chiamata generica a Gemini: system + user → testo. Con `json: true` chiede
 * una risposta JSON (responseMimeType).
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {string} [p.system]
 * @param {string} p.user
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {boolean} [p.json]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>}
 */
export async function geminiGenerate({ apiKey, model, system, user, temperature = 0.2, maxTokens = 4096, json = false, signal }) {
  if (!apiKey) throw new Error('Chiave API Google mancante. Aprine le Impostazioni.');
  const endpoint = `${geminiBase()}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Impossibile contattare Google Gemini (rete). ${e.message}`);
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(`Google Gemini ha risposto ${res.status}. ${detail}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('') : '';
  const finish = data?.candidates?.[0]?.finishReason;
  if (finish === 'MAX_TOKENS') {
    throw new Error('Gemini ha interrotto la risposta per limite di token.');
  }
  if (!text.trim()) {
    const block = data?.promptFeedback?.blockReason;
    throw new Error(
      block
        ? `Richiesta bloccata da Gemini (${block}).`
        : `Gemini non ha restituito testo (finishReason: ${finish || 'n/d'}).`,
    );
  }
  return text;
}

// Istruzione OCR per Gemini (vision): trascrizione fedele, niente interpretazione.
const OCR_PROMPT =
  'Sei un sistema OCR di alta precisione. Trascrivi INTEGRALMENTE e alla ' +
  'lettera tutto il testo presente in questa pagina (scansione o foto), ' +
  'nell’ordine di lettura corretto (con due o tre colonne, completa ciascuna ' +
  'colonna dall’alto in basso prima di passare alla successiva). Usa Markdown: ' +
  '"#"/"##"/"###" per i VERI titoli secondo dimensione, numerazione e ' +
  'gerarchia (documento/parte, capitolo, sezione, sottosezione); non trasformare ' +
  'mai una testatina in titolo. Mantieni una riga vuota tra i paragrafi, ' +
  '_corsivo_ dove il testo è in corsivo, e le note a piè di pagina come testo ' +
  'in fondo, racchiudendo ciascuna nota in `<footnote>testo della nota</footnote>` ' +
  'senza inserirla come paragrafo del corpo. NON tradurre, NON riassumere, NON correggere gli errori del ' +
  'testo, NON aggiungere commenti o spiegazioni tue. Se una parola è ' +
  'illeggibile trascrivila come meglio puoi. Se una parola è tagliata dal bordo ' +
  'pagina, trascrivi soltanto il frammento realmente visibile e il suo eventuale ' +
  'trattino: non completarla inventando lettere. Ignora SEMPRE l’arredo di pagina ' +
  '(numeri di pagina in alto o in basso, testatine, titoli correnti ripetuti, ' +
  'cornici). Restituisci SOLO la trascrizione.';

/**
 * OCR di UNA pagina con Gemini (multimodale): invia l'immagine e riceve il
 * testo trascritto in Markdown. Alternativa a Nemotron-Parse — più robusta su
 * scansioni pessime e utilizzabile anche da web (Gemini invia gli header CORS)
 * — ma NON estrae figure/bounding box.
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model         modello vision (es. "gemini-flash-latest")
 * @param {string} p.imageDataUrl  data URL dell'immagine di pagina
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>} testo trascritto (Markdown)
 */
export async function ocrImageGemini({ apiKey, model, imageDataUrl, signal }) {
  return geminiVision({ apiKey, model, imageDataUrl, prompt: OCR_PROMPT, signal });
}

/**
 * Chiamata multimodale generica: invia UNA immagine con un prompt libero e
 * restituisce il testo. Usata dall'OCR di pagina intera e dal riparsing dei
 * singoli segmenti (tabelle, formule) ritagliati dalla pagina.
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model         modello vision (es. "gemini-flash-latest")
 * @param {string} p.imageDataUrl  data URL dell'immagine
 * @param {string} p.prompt        istruzione da applicare all'immagine
 * @param {number} [p.maxTokens]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>} testo restituito dal modello
 */
export async function geminiVision({ apiKey, model, imageDataUrl, prompt, maxTokens = 8192, signal }) {
  if (!apiKey) throw new Error('Chiave API Google mancante. Aprine le Impostazioni.');
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');

  const comma = imageDataUrl.indexOf(',');
  const meta = imageDataUrl.slice(5, comma); // es. "image/png;base64"
  const mimeType = meta.split(';')[0] || 'image/png';
  const dataB64 = imageDataUrl.slice(comma + 1);

  const endpoint = `${geminiBase()}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: dataB64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Impossibile contattare Google Gemini (rete). ${e.message}`);
  }
  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(`Google Gemini ha risposto ${res.status}. ${detail}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('') : '';
  if (!text.trim()) {
    const block = data?.promptFeedback?.blockReason;
    const finish = data?.candidates?.[0]?.finishReason;
    throw new Error(
      block
        ? `Richiesta bloccata da Gemini (${block}).`
        : `Gemini non ha estratto testo (finishReason: ${finish || 'n/d'}).`,
    );
  }
  return text.trim();
}

/**
 * Elenca i modelli Gemini disponibili per l'API key, filtrando quelli che
 * supportano `generateContent`. Ritorna gli id (senza il prefisso "models/").
 * @param {object} params
 * @param {string} params.apiKey
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string[]>}
 */
export async function listGeminiModels({ apiKey, signal }) {
  if (!apiKey) throw new Error('Chiave API Google mancante.');
  let base = 'https://generativelanguage.googleapis.com';
  try {
    if (import.meta.env.DEV) base = '/__gemini__';
  } catch {
    /* Node/prod: URL diretto */
  }
  const res = await fetch(`${base}/v1beta/models`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Google /models ha risposto ${res.status}.`);
  const data = await res.json();
  const ids = (data?.models || [])
    .filter((m) => (m?.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => (m?.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * Rimuove l'eventuale recinto Markdown (```typst ... ```) restituendo solo
 * il codice Typst grezzo.
 */
export function unwrapCodeBlock(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:typst|typ)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) return fence[1].trim();
  // Recinto d'apertura senza chiusura corretta: togli comunque le righe ```
  return trimmed.replace(/^```(?:typst|typ)?\s*\n?/i, '').replace(/\n?```$/i, '').trim();
}

async function safeErrorDetail(res) {
  try {
    const j = await res.json();
    return j?.error?.message || j?.message || JSON.stringify(j).slice(0, 300);
  } catch {
    try {
      return (await res.text()).slice(0, 300);
    } catch {
      return '';
    }
  }
}
