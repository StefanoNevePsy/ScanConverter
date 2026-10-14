/*
  PaddleOCR-VL online e locale rispondono nello stesso formato: la
  conversione nei blocchi della pipeline è una sola e va provata senza rete.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlTableToMarkdown, paddleResponseToBlocks, paddleHealthUrl } from '../src/lib/paddle.js';
import { parseV2Blocks, isParseV2 } from '../src/lib/nvidia.js';

const response = (list, extra = {}) => ({
  errorCode: 0,
  result: { layoutParsingResults: [{ prunedResult: { width: 1000, height: 2000, parsing_res_list: list, ...extra } }] },
});

test('classi PaddleOCR → tipi della pipeline, bbox normalizzate', () => {
  const blocks = paddleResponseToBlocks(response([
    { block_label: 'doc_title', block_content: 'Il doppio legame', block_bbox: [100, 200, 900, 300] },
    { block_label: 'text', block_content: 'Un paragrafo.', block_bbox: [100, 400, 900, 800] },
    { block_label: 'image', block_content: '', block_bbox: [0, 1000, 500, 1500] },
    { block_label: 'footnote', block_content: '1. Nota.', block_bbox: [100, 1900, 900, 1950] },
    { block_label: 'number', block_content: '12', block_bbox: [480, 1960, 520, 1990] },
    { block_label: 'text', block_content: '   ', block_bbox: [0, 0, 1, 1] },
  ]));
  assert.deepEqual(blocks.map((b) => b.type), ['Title', 'Text', 'Picture', 'Footnote', 'Page-footer']);
  assert.deepEqual(blocks[0].bbox, { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.15 });
  assert.equal(blocks[2].text, '');
});

test('le tabelle HTML diventano tabelle Markdown rettangolari', () => {
  const md = htmlTableToMarkdown(
    '<table><tr><td colspan="2">Gruppo</td></tr><tr><td>a|b</td><td>&amp; c</td></tr></table>',
  );
  assert.equal(md, '| Gruppo |  |\n| --- | --- |\n| a\\|b | & c |');
});

test('senza elenco di blocchi si usa il Markdown della pagina', () => {
  const blocks = paddleResponseToBlocks({
    errorCode: 0,
    result: { layoutParsingResults: [{ markdown: { text: '# Titolo\n\nTesto' } }] },
  });
  assert.deepEqual(blocks, [{ type: 'Text', bbox: null, text: '# Titolo\n\nTesto' }]);
});

test('un errore del servizio diventa un messaggio leggibile', () => {
  assert.throws(() => paddleResponseToBlocks({ errorCode: 403, errorMsg: 'token scaduto' }), /token scaduto/);
});

test('indirizzo di prova del server locale', () => {
  assert.equal(paddleHealthUrl('http://localhost:8001/layout-parsing'), 'http://localhost:8001/health');
});

test('Nemotron-Parse 2.0 usa il protocollo a prompt e i suoi token', () => {
  assert.equal(isParseV2('nvidia/nemotron-parse-2.0'), true);
  assert.equal(isParseV2('nvidia/nemotron-parse'), false);
  const blocks = parseV2Blocks(
    { choices: [{ message: { content: '<x_0.1><y_0.1>Titolo<x_0.5><y_0.2><class_Title><x_0.2><y_0.3><x_0.6><y_0.5><class_Picture>' } }] },
    { width: 1664, height: 2048 },
  );
  assert.deepEqual(blocks.map((b) => [b.type, b.text]), [['Title', 'Titolo'], ['Picture', '']]);
});
