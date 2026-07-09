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

/**
 * Costruisce le istruzioni tecniche (font, gerarchia, tabelle, vincoli Typst)
 * incluse anche nel "Copia prompt + testo" per gli LLM esterni. `styleHint`
 * riporta le scelte di impaginazione dell'utente.
 * @param {string} [styleHint]
 * @returns {string}
 */
export function buildGuidance(styleHint) {
  return (
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
    'caption: [didascalia])`, MANTENENDO il percorso esatto. Non inventare né ' +
    'omettere immagini; non aggiungere immagini con altri percorsi.\n' +
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
    '- Per la bibliografia scrivi una lista o dei paragrafi semplici; NON usare ' +
    'riferimenti `@etichetta` a meno di definire l’etichetta corrispondente.' +
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
export async function toTypst({ apiKey, model, rawText, styleHint, continuation, signal }) {
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
      : '');

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
