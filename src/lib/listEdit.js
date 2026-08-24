/*
  Trasformazioni di elenco sulla selezione dell'editor Typst.

  Operano sul TYPST, non sul Markdown: quando l'utente è nell'editor il
  documento è già generato, e ciò che vede è ciò che va cambiato. «Segnare la
  fine di un elenco» non è quindi un marcatore astratto da reinterpretare più
  avanti, ma togliere il rientro alle righe scelte — deterministico, visibile
  subito, e ha la precedenza sull'euristica che indovina dove finisce l'ultima
  voce (vedi `planListNesting` in strict.js).

  Tutte le funzioni sono pure e lavorano su `{ value, start, end }`,
  restituendo il nuovo testo e la selezione risultante: l'editor deve poter
  ripristinare l'evidenziazione dopo la modifica, altrimenti a ogni pulsante
  premuto l'utente perde il punto in cui stava lavorando.
*/

/** Rientro di una voce annidata: due spazi, come in `markdownToStrictTypst`. */
export const ITEM_INDENT = '  ';

/**
 * Estende la selezione ai confini di riga.
 *
 * Senza, selezionare metà parola trasformerebbe solo quel pezzo: le azioni di
 * elenco sono per definizione azioni su righe intere.
 */
export function lineRange(value, start, end) {
  const text = String(value || '');
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let to = text.indexOf('\n', end);
  if (to === -1) to = text.length;
  // Una selezione che finisce a inizio riga non deve tirarsi dentro la riga
  // successiva: è il caso del doppio clic che seleziona fino al ritorno a capo.
  // Il cursore lampeggiante (selezione vuota) è escluso, altrimenti un clic a
  // inizio riga non avrebbe nessuna riga su cui agire.
  if (end > start && text[end - 1] === '\n') return { from, to: end };
  return { from, to };
}

/** Marcatore di elenco già presente su una riga, se c'è. */
export function listMarker(line) {
  const match = String(line || '').match(/^(\s*)([-+*]|\d+[.)])\s+/);
  if (!match) return null;
  return {
    indent: match[1],
    marker: match[2],
    kind: /^\d/.test(match[2]) ? 'ordered' : 'bullet',
    length: match[0].length,
  };
}

/** Riga senza il suo marcatore di elenco (e senza il rientro). */
function stripMarker(line) {
  const found = listMarker(line);
  return found ? line.slice(found.length) : line.replace(/^\s+/, '');
}

function applyToLines(value, start, end, transform) {
  const text = String(value || '');
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split('\n');
  const changed = transform(lines).join('\n');
  return {
    value: text.slice(0, from) + changed + text.slice(to),
    start: from,
    end: from + changed.length,
  };
}

/**
 * Trasforma le righe selezionate in un elenco.
 *
 * Le righe vuote restano vuote e NON interrompono la numerazione: separano le
 * voci l'una dall'altra ma non sono voci.
 *
 * @param {string} value      testo completo dell'editor
 * @param {number} start
 * @param {number} end
 * @param {'bullet'|'ordered'} kind
 * @param {{marker?: string}} [options] marcatore per gli ordinati: «1.» o «1)»
 * @returns {{value:string, start:number, end:number}}
 */
export function toList(value, start, end, kind, options = {}) {
  const suffix = options.marker === '1)' ? ')' : '.';
  return applyToLines(value, start, end, (lines) => {
    let n = 0;
    return lines.map((line) => {
      if (!line.trim()) return line;
      const body = stripMarker(line);
      if (kind === 'ordered') {
        n += 1;
        return `${n}${suffix} ${body}`;
      }
      return `- ${body}`;
    });
  });
}

/** Toglie il marcatore di elenco dalle righe selezionate. */
export function clearList(value, start, end) {
  return applyToLines(value, start, end, (lines) => lines.map((line) => (
    line.trim() ? stripMarker(line) : line
  )));
}

/**
 * Rientra le righe selezionate dentro la voce di elenco che le precede.
 *
 * È l'operazione che tiene insieme una voce e il suo corpo — la spiegazione,
 * l'esempio, la trascrizione — impedendo a Typst di chiudere l'elenco e far
 * ripartire la numerazione al blocco successivo.
 */
export function indentIntoItem(value, start, end) {
  return applyToLines(value, start, end, (lines) => lines.map((line) => (
    line.trim() ? ITEM_INDENT + line : line
  )));
}

/**
 * Toglie un livello di rientro: è il modo di dire «l'elenco finisce qui».
 *
 * Toglie esattamente `ITEM_INDENT`, o meno se la riga ne ha meno: non azzera
 * rientri più profondi, così un elenco dentro un elenco perde un solo livello
 * per volta, come ci si aspetta da un tasto di sdentatura.
 */
export function endList(value, start, end) {
  return applyToLines(value, start, end, (lines) => lines.map((line) => {
    if (!line.trim()) return line;
    for (let width = ITEM_INDENT.length; width > 0; width--) {
      const prefix = ' '.repeat(width);
      if (line.startsWith(prefix)) return line.slice(width);
    }
    return line;
  }));
}

/**
 * Che cosa sono, oggi, le righe selezionate.
 *
 * Serve all'interfaccia per mostrare lo stato dei pulsanti invece di
 * proporre azioni che non cambierebbero niente.
 *
 * @returns {{bullet:boolean, ordered:boolean, indented:boolean, lines:number}}
 */
export function describeSelection(value, start, end) {
  const text = String(value || '');
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split('\n').filter((line) => line.trim());
  if (!lines.length) return { bullet: false, ordered: false, indented: false, lines: 0 };
  const markers = lines.map(listMarker);
  return {
    bullet: markers.every((m) => m?.kind === 'bullet'),
    ordered: markers.every((m) => m?.kind === 'ordered'),
    indented: lines.every((line) => line.startsWith(' ')),
    lines: lines.length,
  };
}
