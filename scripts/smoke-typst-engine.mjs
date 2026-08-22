import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTypstRunner } = require('../electron/typst-runner.cjs');
const target = `${process.platform}-${process.arch}`;
const typstPath = path.resolve('native', 'typst', target, process.platform === 'win32' ? 'typst.exe' : 'typst');
const workRoot = await mkdtemp(path.join(tmpdir(), 'scanconverter-engine-smoke-'));
let runner = null;

try {
  runner = createTypstRunner({
    typstPath,
    workRoot,
    fontsDir: path.resolve('src', 'assets', 'fonts'),
    packageCachePath: path.join(workRoot, 'packages'),
    incrementalWatch: true,
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const valid = await runner.compile({
    id: 'valid',
    figureSetId: 'smoke',
    figures: [{ path: '/figures/smoke.png', bytes: png }],
    source: '#set text(font: "Libertinus Serif")\n= Prova\n\nMotore nativo attivo. #image("/figures/smoke.png", width: 8pt)',
  });
  if (!valid.ok || !valid.pdfPath || !valid.size) throw new Error(valid.error || 'Compilazione nativa fallita.');

  const incremental = await runner.compile({
    id: 'incremental',
    figureSetId: 'smoke',
    source: '#set text(font: "Libertinus Serif")\n= Prova aggiornata\n\nSeconda compilazione incrementale.',
  });
  if (!incremental.ok || !incremental.pdfPath || !incremental.size) {
    throw new Error(incremental.error || 'Compilazione incrementale fallita.');
  }

  const brokenSource = '= Errore incrementale\n\n#variabile-inesistente()';
  const broken = await runner.compile({
    id: 'broken',
    figureSetId: 'smoke',
    source: brokenSource,
  });
  const brokenAgain = await runner.compile({
    id: 'broken-again',
    figureSetId: 'smoke',
    source: brokenSource,
  });
  if (broken.ok || brokenAgain.ok) {
    throw new Error('Il watcher ha riusato un vecchio PDF dopo un errore Typst.');
  }

  const recovered = await runner.compile({
    id: 'recovered',
    figureSetId: 'smoke',
    source: '= Ripristinato\n\nIl watcher compila di nuovo dopo la correzione.',
  });
  if (!recovered.ok) throw new Error(recovered.error || 'Ripristino del watcher fallito.');

  const invalid = await runner.compile({
    id: 'invalid',
    figureSetId: 'smoke',
    diagnoseOnly: true,
    source: 'Test #variabile-inesistente()',
  });
  if (invalid.ok || invalid.diagnostics?.[0]?.includes(':1:6:') !== true) {
    throw new Error(`Diagnostica nativa inattesa: ${JSON.stringify(invalid)}`);
  }
  process.stdout.write(`Motore Typst nativo verificato (${valid.size} byte, diagnostica riga/colonna presente).\n`);
} finally {
  runner?.close();
  // Windows può trattenere per pochi millisecondi gli handle del watcher.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(workRoot, { recursive: true, force: true });
}
