/*
  Il percorso completo della traduzione, con un modello finto al posto della
  rete: pianificazione, chiamata, rilettura delle etichette, ricomposizione.

  Quello che si verifica non è la qualità della traduzione — non è verificabile
  qui — ma che il documento torni INTERO e nello stesso ordine anche quando il
  modello si comporta male: salta un blocco, riscrive un percorso, risponde
  senza etichette.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewTranslationPassages,
  sanitizeTranslationCandidate,
  translateDocument,
} from '../src/lib/translate.js';

const SETTINGS = {
  localEndpoint: 'http://localhost:11434/v1/chat/completions',
  phases: { translate: { engine: 'local', models: { local: 'finto' } } },
  targetLang: 'en',
  translateOverlap: 1,
  chunkSize: 2000,
  // Questi test verificano ricomposizione e checkpoint con un modello finto
  // che premette [EN] ma non traduce davvero il testo.
  translationLanguageGuard: false,
};

/**
 * Modello finto: rimanda indietro le etichette ricevute con il testo
 * prefissato. `sabotage` permette di simulare i modi in cui un modello vero
 * sbaglia.
 */
function fakeModel({ sabotage } = {}) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages.at(-1).content;
    calls.push(user);
    const marks = [...user.matchAll(/<<<(\d+)>>>\n([\s\S]*?)(?=\n\n<<<|\n\nRegole|$)/g)];
    let content = marks
      .map(([, id, text]) => `<<<${id}>>>\n[EN] ${text.trim()}`)
      .join('\n\n');
    if (sabotage) content = sabotage(content, marks, calls.length);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return calls;
}

const ORIGINAL = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = ORIGINAL; });

test('il documento torna intero, nello stesso ordine, tutto tradotto', async () => {
  fakeModel();
  const markdown = [
    '# Teoria e prassi',
    'Il primo paragrafo del capitolo.',
    'Il secondo paragrafo, più lungo del primo e con due frasi. Questa è la seconda.',
    '![Figura 1](figure/fig-1.png)',
  ].join('\n\n');

  const out = await translateDocument({ settings: SETTINGS, markdown });
  const blocks = out.markdown.split('\n\n');
  assert.equal(blocks.length, 4);
  assert.equal(out.failed, 0);
  assert.ok(blocks[0].startsWith('[EN] # Teoria'), blocks[0]);
  assert.ok(blocks[1].includes('primo paragrafo'));
  assert.ok(blocks[3].includes('figure/fig-1.png'), 'il percorso della figura sopravvive');
});

test('l’avanzamento arriva fino in fondo', async () => {
  fakeModel();
  const markdown = Array.from({ length: 30 }, (_, i) => `Paragrafo ${i} del documento.`).join('\n\n');
  const seen = [];
  const out = await translateDocument({
    settings: SETTINGS,
    markdown,
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen.at(-1), [seen.at(-1)[1], seen.at(-1)[1]], 'l’ultimo aggiornamento è 100%');
  assert.equal(out.markdown.split('\n\n').length, 30);
});

test('un blocco saltato dal modello viene ritentato da solo, non perso', async () => {
  // Alla prima richiesta il modello dimentica il secondo blocco.
  fakeModel({
    sabotage: (content, marks, call) => {
      if (call !== 1 || marks.length < 2) return content;
      return content.split('\n\n').filter((_, i) => i !== 1).join('\n\n');
    },
  });
  const markdown = ['Primo blocco.', 'Secondo blocco.', 'Terzo blocco.'].join('\n\n');
  const out = await translateDocument({ settings: SETTINGS, markdown });

  assert.equal(out.retried, 1, 'il blocco mancante è stato richiesto di nuovo');
  assert.equal(out.failed, 0);
  const blocks = out.markdown.split('\n\n');
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].includes('Secondo blocco'), blocks[1]);
});

test('riprende i gruppi salvati senza richiamare il modello', async () => {
  const calls = fakeModel();
  const checkpoints = [];
  const markdown = Array.from({ length: 12 }, (_, i) =>
    `Paragrafo ${i} abbastanza lungo da produrre più gruppi di traduzione.`,
  ).join('\n\n');
  const settings = { ...SETTINGS, chunkSize: 240 };
  const first = await translateDocument({
    settings,
    markdown,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  const callsAfterFirst = calls.length;
  const resumed = await translateDocument({ settings, markdown, resumeGroups: checkpoints });
  assert.equal(calls.length, callsAfterFirst, 'nessuna richiesta duplicata');
  assert.equal(resumed.markdown, first.markdown);
});

test('un checkpoint con blocchi falliti viene ritentato alla ripresa', async () => {
  const checkpoints = [];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  });
  const markdown = 'The family is connected by loyalty and obligation.';
  const first = await translateDocument({
    settings: { ...SETTINGS, sourceLang: 'en', targetLang: 'it' },
    markdown,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  assert.equal(first.failed, 1);
  assert.equal(checkpoints[0].failed, 1);

  const calls = fakeModel();
  const resumed = await translateDocument({
    settings: { ...SETTINGS, sourceLang: 'en', targetLang: 'it' },
    markdown,
    resumeGroups: checkpoints,
  });
  assert.ok(calls.length > 0, 'il checkpoint incompleto non deve essere accettato come definitivo');
  assert.equal(resumed.failed, 0);
  assert.match(resumed.markdown, /^\[EN\]/);
});

test('un delimitatore perso dal modello fa ritentare il blocco', async () => {
  fakeModel({
    sabotage: (content, _marks, call) => (
      call === 1 ? content.replace('_termine_', '_termine') : content
    ),
  });
  const out = await translateDocument({
    settings: SETTINGS,
    markdown: 'Il _termine_ deve restare enfatizzato.',
  });
  assert.equal(out.retried, 1);
  assert.equal(out.failed, 0);
  assert.match(out.markdown, /_termine_/);
});

test('se il ritentativo risponde senza etichetta la risposta vale lo stesso', async () => {
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    call++;
    const user = JSON.parse(init.body).messages.at(-1).content;
    const ids = [...user.matchAll(/<<<(\d+)>>>/g)].map((m) => m[1]);
    // Prima richiesta: risposta vuota. Seconda (un blocco solo): testo nudo.
    const content = call === 1 ? '' : '[EN] testo tradotto';
    return { ok: true, json: async () => ({ choices: [{ message: { content: content || ids.length && '' } }] }) };
  };
  const out = await translateDocument({ settings: SETTINGS, markdown: 'Un solo paragrafo.' });
  assert.equal(out.failed, 0);
  assert.equal(out.markdown, '[EN] testo tradotto');
});

test('un blocco irrecuperabile resta in originale ed è dichiarato', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
  const out = await translateDocument({ settings: SETTINGS, markdown: 'Paragrafo che non torna.' });
  assert.equal(out.failed, 1, 'il fallimento va dichiarato, non nascosto');
  assert.equal(out.markdown, 'Paragrafo che non torna.', 'meglio l’originale che il vuoto');
});

test('il contesto viaggia nel prompt ma non finisce nel documento', async () => {
  const calls = fakeModel();
  // Paragrafi realistici: con frasi da poche parole il documento starebbe in
  // un'unica richiesta e il contesto non entrerebbe mai in gioco.
  const markdown = Array.from(
    { length: 12 },
    (_, i) => `Paragrafo ${i} del documento. Contiene una seconda frase di ` +
      'lunghezza ordinaria, così il passaggio ha una dimensione realistica.',
  ).join('\n\n');
  const out = await translateDocument({ settings: { ...SETTINGS, chunkSize: 800 }, markdown });
  assert.ok(calls.length > 1, 'il documento è stato diviso');
  assert.ok(
    calls.slice(1).some((c) => c.includes('CONTESTO PRECEDENTE')),
    'i passaggi dopo il primo ricevono il contesto',
  );
  // Ogni paragrafo compare una volta sola: il contesto è in più, non in mezzo.
  for (let i = 0; i < 12; i++) {
    const occurrences = out.markdown.split(`Paragrafo ${i} del documento.`).length - 1;
    assert.equal(occurrences, 1, `«Paragrafo ${i}» compare ${occurrences} volte`);
  }
});

test('la lingua di destinazione arriva al modello', async () => {
  const calls = fakeModel();
  await translateDocument({
    settings: { ...SETTINGS, targetLang: 'de', sourceLang: 'it' },
    markdown: 'Un paragrafo.',
  });
  assert.match(calls[0], /verso «Tedesco»/);
  assert.match(calls[0], /dalla lingua «Italiano»/);
});

test('una risposta con originale e traduzione duplicata produce un solo paragrafo', async () => {
  fakeModel({
    sabotage: (content) => content.replace(
      /<<<0>>>\n\[EN\] ([\s\S]+)/,
      (_match, original) => `<<<0>>>\n${original}\n\n[EN] ${original}\n\n[EN] ${original}`,
    ),
  });
  const out = await translateDocument({
    settings: SETTINGS,
    markdown: 'Un paragrafo sufficientemente lungo da essere tradotto senza perdere il proprio contenuto.',
  });
  assert.equal(out.failed, 0);
  assert.equal(out.markdown.split(/\n{2,}/).length, 1);
  assert.match(out.markdown, /^\[EN\]/);
});

test('espone le traduzioni per blocco per il rebase selettivo', async () => {
  fakeModel();
  const out = await translateDocument({
    settings: SETTINGS,
    markdown: 'Primo passaggio.\n\nSecondo passaggio.',
  });
  assert.deepEqual(out.blockTranslations.map((item) => item.id), [0, 1]);
  assert.match(out.blockTranslations[0].after, /^\[EN\] Primo/);
  assert.match(out.blockTranslations[1].after, /^\[EN\] Secondo/);
});

test('l’annullamento interrompe senza restituire mezzo documento', async () => {
  fakeModel();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => translateDocument({
      settings: SETTINGS,
      markdown: Array.from({ length: 20 }, (_, i) => `Paragrafo ${i}.`).join('\n\n'),
      signal: controller.signal,
    }),
    (e) => e.name === 'AbortError',
  );
});

test('senza testo si spiega perché, invece di produrre un documento vuoto', async () => {
  fakeModel();
  await assert.rejects(
    () => translateDocument({ settings: SETTINGS, markdown: '   ' }),
    /Non c’è testo da tradurre/,
  );
});

test('la revisione elimina originale, contesto e copie duplicate dalla proposta', () => {
  const cleaned = sanitizeTranslationCandidate({
    current: 'The family is connected by loyalty.',
    candidate:
      'The family is connected by loyalty.\n\n' +
      'La famiglia è legata dalla lealtà.\n\n' +
      'La famiglia è legata dalla lealtà.\n\n' +
      'Contesto seguente da non ripetere.',
    next: 'Contesto seguente da non ripetere.',
  });
  assert.equal(cleaned, 'La famiglia è legata dalla lealtà.');
});

test('il ricontrollo usa il modello della fase traduzione e restituisce patch localizzate', async () => {
  let requestedModel = '';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requestedModel = body.model;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '<<<0>>>\nLa famiglia è un sistema.' } }] }),
    };
  };
  const changes = await reviewTranslationPassages({
    settings: {
      ...SETTINGS,
      phases: { translate: { engine: 'local', models: { local: 'traduttore-corrente:7b' } } },
      sourceLang: 'en',
      targetLang: 'it',
    },
    sourceLang: 'en',
    targetLang: 'it',
    passages: [{ id: 'p1', text: 'The family is a system.', suspicious: true }],
  });
  assert.equal(requestedModel, 'traduttore-corrente:7b');
  assert.deepEqual(changes, [{ id: 'p1', before: 'The family is a system.', after: 'La famiglia è un sistema.' }]);
});
