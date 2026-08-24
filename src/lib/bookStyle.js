/*
  Segni tipografici da libro applicati al CORPO del documento.

  Quasi tutta la resa sta nel preambolo, dove si può cambiare idea quante volte
  si vuole. L'apertura di capitolo no: Typst non ha un modo per dire «il
  paragrafo che viene subito dopo un titolo» — la via con lo stato non
  converge, e il compilatore lo dice — quindi quel paragrafo va marcato dove
  si trova.

  Il marcatore è però soltanto un NOME: `#apertura[…]` dice «questa è
  un'apertura di capitolo», e come si vede lo decide il preambolo (maiuscoletto,
  iniziale grande, o niente). Cambiare stile riscrive una riga del preambolo,
  non il testo; e togliere lo stile toglie anche il marcatore, lasciando prosa
  pulita.
*/

/** Riga di titolo di primo livello: `= Titolo` (non `==`). */
const CHAPTER_RE = /^=\s+\S/u;
const OPENER_PREFIX = '#apertura[';

/** true se la riga è già marcata come apertura di capitolo. */
export function isOpener(line) {
  const text = String(line || '');
  return text.startsWith(OPENER_PREFIX) && text.trimEnd().endsWith(']');
}

/** Toglie il marcatore da una riga, se c'è. */
export function stripOpener(line) {
  if (!isOpener(line)) return line;
  const text = String(line);
  return text.slice(OPENER_PREFIX.length, text.trimEnd().length - 1);
}

/** Voce di elenco: è già l'apertura del capitolo, non la precede. */
function isListItem(line) {
  return /^\s*(?:[-+*]\s|\d+[.)]\s)/u.test(String(line || ''));
}

/**
 * Riga che sta fra il titolo e il primo paragrafo senza esserne parte: riga
 * vuota, commento di pagina, figura, blocco di codice. Si attraversa e si
 * continua a cercare la prosa.
 */
function isTransparent(line) {
  const text = String(line || '').trim();
  if (!text) return true;
  return text.startsWith('#') || text.startsWith('//') || text.startsWith('<');
}

/**
 * Marca (o smarca) il primo paragrafo di ogni capitolo.
 *
 * @param {string} body   corpo Typst, senza preambolo
 * @param {boolean} enabled  se falso, toglie i marcatori esistenti
 * @returns {string}
 */
export function setChapterOpeners(body, enabled) {
  const lines = String(body || '').split('\n');
  const out = [];
  let waiting = false;
  for (const line of lines) {
    const bare = stripOpener(line);
    if (CHAPTER_RE.test(bare.trim())) {
      waiting = true;
      out.push(bare);
      continue;
    }
    // Un'apertura marcata da un giro precedente torna prosa: lo stile si
    // riapplica da capo, così spegnerlo non lascia residui.
    if (!waiting || isTransparent(bare)) {
      out.push(bare);
      continue;
    }
    // Un capitolo che si apre con un elenco è già aperto: l'apertura
    // tipografica riguarda la prosa, e non va cercata più avanti.
    if (isListItem(bare)) {
      out.push(bare);
      waiting = false;
      continue;
    }
    out.push(enabled ? `${OPENER_PREFIX}${bare.trimEnd()}]` : bare);
    waiting = false;
  }
  return out.join('\n');
}
