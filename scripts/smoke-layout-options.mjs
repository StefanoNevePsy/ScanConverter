import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPreamble } from '../src/lib/preamble.js';

const require = createRequire(import.meta.url);
const { createTypstRunner } = require('../electron/typst-runner.cjs');
const target = `${process.platform}-${process.arch}`;
const typstPath = path.resolve(
  'native',
  'typst',
  target,
  process.platform === 'win32' ? 'typst.exe' : 'typst',
);
const workRoot = await mkdtemp(path.join(tmpdir(), 'scanconverter-layout-smoke-'));

try {
  const runner = createTypstRunner({
    typstPath,
    workRoot,
    fontsDir: path.resolve('src', 'assets', 'fonts'),
    packageCachePath: path.join(workRoot, 'packages'),
  });
  const preamble = buildPreamble(
    {
      paper: 'custom',
      pageWidthMm: 170,
      pageHeightMm: 240,
      marginMode: 'mirrored',
      marginInsideCm: 3.2,
      marginOutsideCm: 1.8,
      columns: 2,
      bodySizePt: 11.5,
      bodyWeight: 500,
      trackingPt: 0.05,
      leadingEm: 0.72,
      paragraphSpacingEm: 0.7,
      indentAll: true,
      headingalign: 'center',
      headingNumbering: 'decimal-dot',
      pageNumbering: 'roman-upper',
      pageNumberPosition: 'bottom-right',
      headerMode: 'custom',
      headerText: 'Archivio "A"',
      figureAlign: 'left',
      captionPosition: 'top',
      footnoteSizePt: 8,
    },
    { title: 'Titolo di prova' },
  );
  const result = await runner.compile({
    id: 'layout-options',
    figureSetId: 'layout-options',
    figures: [],
    source: `${preamble}\n= Titolo di prova\n\nTesto di prova con nota.#footnote[Nota di prova.]\n\n#figure(rect(width: 20mm, height: 8mm), caption: [Didascalia])`,
  });
  if (!result.ok || !result.pdfPath || !result.size) {
    throw new Error(result.error || result.diagnostics?.join('\n') || 'Preambolo non compilabile.');
  }
  process.stdout.write(`Impaginazione granulare verificata con Typst nativo (${result.size} byte).\n`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
