import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectArchive,
  inspectProjectArchive,
} from '../src/lib/projectArchive.js';

test('il progetto portatile conserva stato, parti, figure e pagine sospese', async () => {
  const archive = await createProjectArchive({
    session: {
      id: '1752230000000-aaaaa',
      fileName: 'Libro di prova.pdf',
      status: 'ocr',
      editorCode: '#set page(margin: 2cm)\n= Titolo',
      ocr: { total: 3, done: 2 },
      googleApiKey: 'non-deve-uscire',
      nested: { access_token: 'nemmeno-questo' },
    },
    parts: ['pagina uno', 'pagina due', null],
    figures: [{ path: '/figures/fig-1.png', bytes: new Uint8Array([1, 2, 3]), widthPct: 72 }],
    pages: [{ index: 2, dataUrl: 'data:image/png;base64,AQIDBA==' }],
  });

  assert.match(archive.fileName, /^Libro di prova\.scanconverter$/);
  const imported = await inspectProjectArchive(archive.bytes);
  assert.equal(imported.session.fileName, 'Libro di prova.pdf');
  assert.equal(imported.session.editorCode, '#set page(margin: 2cm)\n= Titolo');
  assert.equal(imported.session.googleApiKey, undefined);
  assert.equal(imported.session.nested.access_token, undefined);
  assert.deepEqual(imported.parts.slice(0, 3), ['pagina uno', 'pagina due']);
  assert.deepEqual(imported.figures[0].bytes, new Uint8Array([1, 2, 3]));
  assert.equal(imported.figures[0].path, '/figures/fig-1.png');
  assert.equal(imported.figures[0].widthPct, 72);
  assert.equal(imported.pages[0].index, 2);
  assert.equal(imported.pages[0].dataUrl, 'data:image/png;base64,AQIDBA==');
});

test('rifiuta file che non sono progetti ScanConverter', async () => {
  await assert.rejects(
    () => inspectProjectArchive(new Uint8Array([1, 2, 3, 4])),
    /zip|archivio|progetto/i,
  );
});
