/*
  Pulizia tipografica italiana, a regole fisse.

  Gli errori tipici dell'OCR (e delle macchine da scrivere da cui vengono
  molte fotocopie) sui testi italiani sono sempre gli stessi, e non serve un
  modello linguistico per correggerli:
  - accento scritto come apostrofo: «E'» → «È», «perche'» → «perché»,
    «piu'» → «più», «citta'» → «città»;
  - apostrofo dritto → tipografico: «l'altro» → «l’altro»;
  - spazi doppi, spazio prima della punteggiatura, spazio dentro le
    virgolette caporali.

  Le eccezioni vere (po', be', mo', imperativi come di', fa', va') restano
  com'erano. Ogni regola è prudente: nel dubbio non tocca.
*/

// Parole in cui l'apostrofo finale è corretto e NON è un accento.
const KEEP_APOSTROPHE = new Set(['po', 'mo', 'be', 'to', 'di', 'da', 'fa', 'va', 'sta', 'de', 'ne', 'pie', 'a', 'i', 'o', 'u']);

// Finali in «-che» e monosillabi con accento acuto: perché, poiché, né, sé, ventitré…
const ACUTE_E = /(?:ch|tr|n|s)e$/i;

function accented(word) {
  const stem = word.slice(0, -1);
  const last = word.slice(-1);
  const upper = last === last.toUpperCase();
  let mark;
  switch (last.toLowerCase()) {
    case 'a': mark = 'à'; break;
    case 'i': mark = 'ì'; break;
    case 'o': mark = 'ò'; break;
    case 'u': mark = 'ù'; break;
    case 'e': mark = ACUTE_E.test(word) && word.length > 2 ? 'é' : 'è'; break;
    default: return null;
  }
  return stem + (upper ? mark.toUpperCase() : mark);
}

/**
 * @param {string} text  testo OCR (Markdown)
 * @returns {{text:string, changes:string[]}}
 */
export function italianTypography(text) {
  const changes = [];
  let s = String(text || '');

  // «E'» / «E’» da sola = «È» (a inizio frase o dopo punteggiatura).
  s = s.replace(/(^|[\s«"“(])E['’](?=[\s,.;:!?»”)]|$)/gmu, (_, before) => {
    changes.push("E' → È");
    return `${before}È`;
  });
  // «e'» minuscola da sola = «è».
  s = s.replace(/(^|[\s«"“(])e['’](?=[\s,.;:!?»”)]|$)/gmu, (_, before) => {
    changes.push("e' → è");
    return `${before}è`;
  });

  // Parole che finiscono con vocale + apostrofo seguito da spazio o
  // punteggiatura: l'apostrofo era un accento (perche' → perché).
  s = s.replace(
    /(^|[^\p{L}'’])(\p{L}{2,}[aeiouAEIOU])['’](?=[\s,.;:!?»”)\]]|$)/gmu,
    (whole, before, word) => {
      if (KEEP_APOSTROPHE.has(word.toLowerCase())) return whole;
      const fixed = accented(word);
      if (!fixed) return whole;
      changes.push(`${word}' → ${fixed}`);
      return `${before}${fixed}`;
    },
  );

  // Apostrofo dritto fra due lettere (elisione) → tipografico.
  const before = s;
  s = s.replace(/(\p{L})'(?=\p{L})/gu, '$1’');
  if (s !== before) changes.push("apostrofi ' → ’");

  // Spazi: doppi, prima della punteggiatura, dentro le caporali.
  const spaced = s;
  s = s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(\S)[ \t]+([,;:.!?»])(?=\s|$|[»”)])/gmu, '$1$2')
    .replace(/«[ \t]+/g, '«');
  if (s !== spaced) changes.push('spazi sistemati');

  return { text: s, changes: [...new Set(changes)] };
}
