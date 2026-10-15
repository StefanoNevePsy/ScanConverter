import test from 'node:test';
import assert from 'node:assert/strict';
import { plainOcrToMarkdown } from '../src/lib/ollamaOcr.js';

// Uscita tipica di PaddleOCR-VL («OCR:»): righe come sulla pagina (Manuale SST, p. 22).
const PAGE = `INCONTRO 1: INTRODUZIONE E ASPETTATIVE
Si affrontano le aspettative dei partecipanti rispetto al gruppo SST e si fornisce
una panoramica tra gli argomenti, focalizzandosi sulle abilità trattate e sul con-
cetto di autoregolazione delle emozioni.
Mi presento
Chi sono io, le cose che mi piacciono, le mie qualità fisiche (cosa mi piace del mio
corpo), altre mie qualità, i miei interessi speciali.
• "Vorrei essere più sicuro di me."
• "Vorrei essere più disinvolto."`;

test('PaddleOCR via Ollama: titoli riconosciuti, paragrafi ricomposti', () => {
  const md = plainOcrToMarkdown(PAGE);
  const blocks = md.split('\n\n');
  assert.equal(blocks[0], '## INCONTRO 1: INTRODUZIONE E ASPETTATIVE');
  assert.match(blocks[1], /^Si affrontano .* sul concetto di autoregolazione delle emozioni\.$/);
  assert.equal(blocks[2], '## Mi presento');
  assert.match(blocks[3], /^Chi sono io, .*interessi speciali\.$/);
  assert.equal(blocks[4], '• "Vorrei essere più sicuro di me."');
  assert.equal(blocks[5], '• "Vorrei essere più disinvolto."');
});

test('una riga breve dentro un paragrafo non diventa titolo', () => {
  const md = plainOcrToMarkdown('Il saluto può apparire banale, ma spesso i partecipanti\nnon ci pensano.');
  assert.doesNotMatch(md, /^##/m);
});
