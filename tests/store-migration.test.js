import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

/*
  La migrazione dello schema è l'unico punto in cui un errore distrugge dati
  già salvati dall'utente: qui si verifica su un database costruito nella forma
  V2 precedente, che le sessioni sopravvivano intatte e che il testo esca dal
  record di sessione per finire nello store `part`.
*/

/** Crea a mano un database nella forma V2, come quelli già sul telefono. */
function seedV2() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open('scanconverter', 2);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      db.createObjectStore('session', { keyPath: 'id' });
      db.createObjectStore('figure', { keyPath: 'key' });
      db.createObjectStore('page', { keyPath: 'key' });
    };
    rq.onsuccess = () => {
      const db = rq.result;
      const t = db.transaction('session', 'readwrite');
      const os = t.objectStore('session');
      // Libro fermo a metà OCR, col vecchio array di parti dentro la sessione.
      os.put({
        id: '1752230000000-aaaaa',
        fileName: 'libro.pdf',
        status: 'ocr',
        updatedAt: 1000,
        ocr: {
          total: 6,
          done: 4,
          figCount: 2,
          source: 'ocr',
          parts: ['pagina uno', 'pagina due', 'pagina tre', 'pagina quattro', null, null],
        },
      });
      // Documento già formattato: testo e chunk devono restare dove sono.
      os.put({
        id: '1752230000001-bbbbb',
        fileName: 'saggio.pdf',
        status: 'done',
        updatedAt: 2000,
        rawText: 'testo completo',
        chunks: [
          { text: 'a', body: '= A', status: 'done' },
          { text: 'b', body: '= B', status: 'done' },
        ],
        preamble: '#set page(margin: 2cm)',
      });
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
    rq.onerror = () => reject(rq.error);
  });
}

test('la migrazione V2→V4 conserva le sessioni e alleggerisce l’elenco', async () => {
  await seedV2();
  // L'import avviene DOPO il seed: store.js apre il database (e migra) da sé.
  const store = await import('../src/lib/store.js');

  const list = await store.listSessions();
  assert.equal(list.length, 2);

  // L'elenco non deve più trascinarsi dietro il testo dei documenti.
  for (const s of list) {
    assert.ok(!('rawText' in s), 'il riepilogo non contiene rawText');
    assert.ok(!('chunks' in s), 'il riepilogo non contiene i chunk');
    assert.ok(!('ocr' in s), 'il riepilogo non contiene le parti OCR');
  }

  const a = list.find((s) => s.id === '1752230000000-aaaaa');
  assert.equal(a.fileName, 'libro.pdf');
  assert.equal(a.kind, 'ocr');
  assert.equal(a.done, 4);
  assert.equal(a.total, 6);

  const b = list.find((s) => s.id === '1752230000001-bbbbb');
  assert.equal(b.kind, 'format');
  assert.equal(b.done, 2);
  assert.equal(b.total, 2);

  // Le parti OCR sono state spostate, non perse: la ripresa deve funzionare.
  const parts = await store.getParts('1752230000000-aaaaa', 6);
  assert.deepEqual(parts, [
    'pagina uno', 'pagina due', 'pagina tre', 'pagina quattro', null, null,
  ]);

  const fullA = await store.getSession('1752230000000-aaaaa');
  assert.ok(!fullA.ocr.parts, 'le parti non restano duplicate nella sessione');
  assert.equal(fullA.ocr.done, 4);
  assert.equal(fullA.ocr.total, 6);
  assert.equal(fullA.ocr.figCount, 2);

  // La sessione già formattata resta integra.
  const fullB = await store.getSession('1752230000001-bbbbb');
  assert.equal(fullB.rawText, 'testo completo');
  assert.equal(fullB.chunks.length, 2);
  assert.match(fullB.preamble, /margin/);
});

test('i checkpoint di traduzione sono isolati per documento e lavoro', async () => {
  const store = await import('../src/lib/store.js');
  await store.saveTranslationGroup('1752230000000-aaaaa', 'job-a', {
    index: 0, signature: 'sig-a', pieces: [[0, 'tradotto']], retried: 0, failed: 0,
  });
  await store.saveTranslationGroup('1752230000000-aaaaa', 'job-b', {
    index: 0, signature: 'sig-b', pieces: [[0, 'altro']], retried: 0, failed: 0,
  });
  assert.equal((await store.getTranslationGroups('1752230000000-aaaaa', 'job-a')).length, 1);
  await store.deleteTranslationJob('1752230000000-aaaaa', 'job-a');
  assert.equal((await store.getTranslationGroups('1752230000000-aaaaa', 'job-a')).length, 0);
  assert.equal((await store.getTranslationGroups('1752230000000-aaaaa', 'job-b')).length, 1);
});

test('le letture restano confinate alla singola sessione', async () => {
  const store = await import('../src/lib/store.js');
  await store.savePages('1752230000000-aaaaa', ['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
  await store.savePages('1752230000001-bbbbb', ['data:image/png;base64,CCC']);

  assert.deepEqual(await store.getPageIndexes('1752230000000-aaaaa'), [0, 1]);
  assert.deepEqual(await store.getPageIndexes('1752230000001-bbbbb'), [0]);
  assert.equal(await store.getPage('1752230000000-aaaaa', 1), 'data:image/png;base64,BBB');

  // Cancellare una sessione non deve toccare le pagine dell'altra.
  await store.deletePagesFor('1752230000000-aaaaa');
  assert.deepEqual(await store.getPageIndexes('1752230000000-aaaaa'), []);
  assert.deepEqual(await store.getPageIndexes('1752230000001-bbbbb'), [0]);
});

test('savePart aggiorna una sola pagina senza toccare le altre', async () => {
  const store = await import('../src/lib/store.js');
  await store.savePart('1752230000000-aaaaa', 4, 'pagina cinque');
  const parts = await store.getParts('1752230000000-aaaaa', 6);
  assert.equal(parts[0], 'pagina uno');
  assert.equal(parts[4], 'pagina cinque');
  assert.equal(parts[5], null);
});
