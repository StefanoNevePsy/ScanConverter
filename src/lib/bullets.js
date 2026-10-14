/*
  Pallini d'elenco scritti in LaTeX dall'OCR.

  Nemotron-Parse trascrive spesso il pallino «•» come formula LaTeX:
  `\(\bullet\)`, `$\bullet$`, `\bullet`. Arrivato in Typst diventa testo
  letterale («\(\bullet\)» stampato nel PDF) invece di un elenco. Si
  corregge in modo deterministico, senza IA, in due punti:
  - nel testo OCR, prima che diventi Typst → riga d'elenco Markdown «- »;
  - nel codice Typst già generato (documenti esistenti e uscita del modello).
*/

// Simbolo d'elenco in LaTeX (con o senza delimitatori di formula), o un
// carattere-pallino tipografico.
const LATEX_MARK = String.raw`(?:\\\(\s*\\(?:bullet|circ|cdot|diamond|star)\s*\\\)|\$\s*\\(?:bullet|circ|cdot|diamond|star)\s*\$|\\(?:bullet|textbullet)\b)`;
const GLYPH_MARK = '[•◦▪▫●○■□‣⁃∙·]';

const OCR_LINE = new RegExp(`^(\\s*)(?:${LATEX_MARK}|${GLYPH_MARK})\\s*`, 'gmu');

/** Testo OCR (Markdown): pallino a inizio riga → «- ». */
export function normalizeOcrBullets(text) {
  return String(text || '').replace(OCR_LINE, '$1- ');
}

// Nel sorgente Typst le barre e le parentesi arrivano spesso con l'escape
// di Typst davanti: `\\(\\bullet\\)`.
const TYPST_MARK = String.raw`(?:\\{1,2}\(\s*\\{1,2}(?:bullet|circ|cdot)\s*\\{1,2}\)|\\?\$\s*\\{1,2}(?:bullet|circ|cdot)\s*\\?\$|\\{1,2}bullet\b)`;

/**
 * Codice Typst: un pallino LaTeX a inizio riga diventa voce d'elenco «- »;
 * dentro un blocco (citazioni, corsivi) diventa il carattere «•», che si
 * stampa correttamente senza smontare la struttura del blocco.
 * @returns {{code:string, count:number}}
 */
export function fixTypstBullets(code) {
  let count = 0;
  let out = String(code || '').replace(new RegExp(`^(\\s*)${TYPST_MARK}\\s*`, 'gmu'), (_, indent) => {
    count++;
    return `${indent}- `;
  });
  out = out.replace(new RegExp(`${TYPST_MARK}\\s*`, 'gu'), () => {
    count++;
    return '• ';
  });
  return { code: out, count };
}
