import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTypstRunner } = require('../electron/typst-runner.cjs');
const target = `${process.platform}-${process.arch}`;
const typstPath = path.resolve('native', 'typst', target, process.platform === 'win32' ? 'typst.exe' : 'typst');
const workRoot = await mkdtemp(path.join(tmpdir(), 'scanconverter-engine-smoke-'));

try {
  const runner = createTypstRunner({
    typstPath,
    workRoot,
    fontsDir: path.resolve('src', 'assets', 'fonts'),
    packageCachePath: path.join(workRoot, 'packages'),
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
  await rm(workRoot, { recursive: true, force: true });
}
