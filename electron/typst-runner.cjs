const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_FIGURE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_FIGURE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024 * 1024;

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function figureRelativePath(value) {
  const source = String(value || '').replace(/\\/g, '/');
  if (!source.startsWith('/figures/')) {
    throw new Error(`Percorso figura non valido: ${source || '(vuoto)'}`);
  }
  const normalized = path.posix.normalize(source).replace(/^\/+/, '');
  if (!normalized.startsWith('figures/') || normalized.includes('../')) {
    throw new Error(`Percorso figura non sicuro: ${source}`);
  }
  return normalized.split('/').join(path.sep);
}

function shortDiagnostics(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /:\d+:\d+(?:-\d+:\d+)?:\s*(?:error|warning|hint):/i.test(line));
}

function pdfCacheKey(source, figureDigest = '', cacheVersion = '1') {
  return crypto.createHash('sha256')
    .update(String(cacheVersion)).update('\0')
    .update(String(figureDigest)).update('\0')
    .update(String(source || ''), 'utf8')
    .digest('hex');
}

async function prunePdfCache(root, protectPath) {
  const MAX_FILES = 16;
  const MAX_BYTES = 4 * 1024 * 1024 * 1024;
  const RECENT_MS = 5 * 60 * 1000;
  try {
    const names = await fs.promises.readdir(root);
    const entries = (await Promise.all(names.filter((name) => name.endsWith('.pdf')).map(async (name) => {
      const file = path.join(root, name);
      const stat = await fs.promises.stat(file);
      return { file, size: stat.size, mtimeMs: stat.mtimeMs };
    }))).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = entries.reduce((sum, item) => sum + item.size, 0);
    let files = entries.length;
    for (const item of [...entries].reverse()) {
      if (files <= MAX_FILES && bytes <= MAX_BYTES) break;
      if (item.file === protectPath || Date.now() - item.mtimeMs < RECENT_MS) continue;
      await fs.promises.rm(item.file, { force: true });
      files--;
      bytes -= item.size;
    }
  } catch {
    /* manutenzione best-effort */
  }
}

function runCommand(executable, args, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (current, chunk) => {
      if (current.length >= MAX_DIAGNOSTIC_BYTES) return current;
      return (current + chunk.toString('utf8')).slice(0, MAX_DIAGNOSTIC_BYTES);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, stdout, stderr, error });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout, stderr, error: null });
    });
  });
}

function createTypstRunner(config) {
  const typstPath = path.resolve(config.typstPath);
  const workRoot = path.resolve(config.workRoot);
  const fontsDir = config.fontsDir ? path.resolve(config.fontsDir) : '';
  const packageCachePath = config.packageCachePath
    ? path.resolve(config.packageCachePath)
    : path.join(workRoot, 'packages');
  const pdfCacheRoot = config.pdfCacheRoot ? path.resolve(config.pdfCacheRoot) : '';
  const cacheVersion = String(config.cacheVersion || 'typst-0.15.1-v1');
  // Lascia almeno un core al renderer/sistema e limita il parallelismo
  // eccessivo sui workstation: un libro deve finire senza congelare il Mac/PC.
  const jobs = Math.max(1, Math.min(8, Number(config.jobs)
    || Math.max(1, os.availableParallelism() - 1)));
  const readyFigureSets = new Set();
  const figureSetBytes = new Map();
  const figureSetHashes = new Map();
  const figureSetDigests = new Map();

  function projectFor(figureSetId) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(figureSetId || ''))) {
      throw new Error('Identificatore del progetto Typst non valido.');
    }
    const projectRoot = path.join(workRoot, `project-${figureSetId}`);
    if (!inside(workRoot, projectRoot)) throw new Error('Percorso progetto Typst non sicuro.');
    return projectRoot;
  }

  async function writeFigure(projectRoot, figureSetId, figure) {
    const figuresRoot = path.join(projectRoot, 'figures');
    const bytes = Buffer.from(figure?.bytes || []);
    if (bytes.length > MAX_FIGURE_BYTES) throw new Error('Una figura supera il limite di 256 MB.');
    const total = (figureSetBytes.get(figureSetId) || 0) + bytes.length;
    if (total > MAX_TOTAL_FIGURE_BYTES) throw new Error('Le figure superano il limite complessivo di 2 GB.');
    const destination = path.resolve(projectRoot, figureRelativePath(figure?.path));
    if (!inside(figuresRoot, destination)) throw new Error('Percorso figura fuori dal progetto.');
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, bytes);
    figureSetBytes.set(figureSetId, total);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    figureSetHashes.get(figureSetId)?.set(figureRelativePath(figure?.path), digest);
  }

  /** Registra le figure una alla volta per tenere basso il picco IPC/RAM. */
  async function prepareFigureSet(request) {
    try {
      const figureSetId = String(request?.figureSetId || '');
      const projectRoot = projectFor(figureSetId);
      const figuresRoot = path.join(projectRoot, 'figures');
      await fs.promises.mkdir(path.join(projectRoot, 'scanconverter'), { recursive: true });
      if (request.reset) {
        await fs.promises.rm(figuresRoot, { recursive: true, force: true });
        await fs.promises.mkdir(figuresRoot, { recursive: true });
        figureSetBytes.set(figureSetId, 0);
        figureSetHashes.set(figureSetId, new Map());
        figureSetDigests.delete(figureSetId);
        readyFigureSets.delete(figureSetId);
      }
      if (request.figure) await writeFigure(projectRoot, figureSetId, request.figure);
      if (request.finalize) {
        const entries = [...(figureSetHashes.get(figureSetId) || new Map()).entries()]
          .sort(([a], [b]) => a.localeCompare(b));
        figureSetDigests.set(figureSetId, crypto.createHash('sha256')
          .update(JSON.stringify(entries)).digest('hex'));
        readyFigureSets.add(figureSetId);
      }
      return {
        ok: true,
        figureSetReady: readyFigureSets.has(figureSetId),
        diagnostics: [],
      };
    } catch (error) {
      return { ok: false, infrastructure: true, error: error.message, diagnostics: [] };
    }
  }

  async function prepareProject(figureSetId, figures) {
    const projectRoot = projectFor(figureSetId);

    if (!readyFigureSets.has(figureSetId) && !Array.isArray(figures)) {
      return { unknown: true, projectRoot };
    }

    await fs.promises.mkdir(path.join(projectRoot, 'scanconverter'), { recursive: true });
    if (Array.isArray(figures)) {
      const checked = async (operation) => {
        const result = await prepareFigureSet(operation);
        if (!result.ok) throw new Error(result.error || 'Registrazione figure fallita.');
      };
      await checked({ figureSetId, reset: true });
      for (const figure of figures) await checked({ figureSetId, figure });
      await checked({ figureSetId, finalize: true });
    }
    return { unknown: false, projectRoot };
  }

  async function compile(request) {
    const source = String(request?.source || '');
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      return {
        ok: false,
        infrastructure: false,
        error: 'Il documento Typst supera il limite locale di 128 MB.',
        diagnostics: [],
      };
    }

    const requestedDigest = String(request?.figureDigest || '');
    const requestedCachePath = pdfCacheRoot && !request.diagnoseOnly && requestedDigest
      ? path.join(pdfCacheRoot, `${pdfCacheKey(source, requestedDigest, cacheVersion)}.pdf`)
      : '';
    if (requestedCachePath) {
      try {
        const cached = await fs.promises.stat(requestedCachePath);
        if (cached.isFile() && cached.size > 0) {
          await fs.promises.utimes(requestedCachePath, new Date(), new Date()).catch(() => {});
          return {
            ok: true,
            figureSetReady: false,
            diagnostics: [],
            pdfPath: requestedCachePath,
            size: cached.size,
            persistent: true,
            cacheHit: true,
          };
        }
      } catch {
        /* cache miss: il progetto figure verrà richiesto normalmente */
      }
    }

    let prepared;
    try {
      prepared = await prepareProject(request.figureSetId, request.figures);
    } catch (error) {
      return { ok: false, infrastructure: true, error: error.message, diagnostics: [] };
    }
    if (prepared.unknown) {
      return {
        ok: false,
        code: 'UNKNOWN_FIGURE_SET',
        figureSetReady: false,
        infrastructure: false,
        error: 'Le figure del progetto devono essere registrate nuovamente.',
        diagnostics: [],
      };
    }


    const figureDigest = requestedDigest || figureSetDigests.get(request.figureSetId) || '';
    const cachePath = pdfCacheRoot && !request.diagnoseOnly
      ? path.join(pdfCacheRoot, `${pdfCacheKey(source, figureDigest, cacheVersion)}.pdf`)
      : '';
    if (cachePath) {
      try {
        const cached = await fs.promises.stat(cachePath);
        if (cached.isFile() && cached.size > 0) {
          await fs.promises.utimes(cachePath, new Date(), new Date()).catch(() => {});
          return {
            ok: true,
            figureSetReady: true,
            diagnostics: [],
            pdfPath: cachePath,
            size: cached.size,
            persistent: true,
            cacheHit: true,
          };
        }
      } catch {
        /* cache miss */
      }
    }

    const requestId = String(request.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
    const mainPath = path.join(prepared.projectRoot, 'scanconverter', 'main.typ');
    const outputPath = path.join(prepared.projectRoot, `output-${requestId}.pdf`);
    await fs.promises.writeFile(mainPath, source, 'utf8');
    await fs.promises.mkdir(packageCachePath, { recursive: true });

    const args = [
      'compile',
      '--diagnostic-format', 'short',
      '--root', prepared.projectRoot,
      '--package-cache-path', packageCachePath,
      '--jobs', String(jobs),
      '--ignore-system-fonts',
    ];
    if (fontsDir && fs.existsSync(fontsDir)) args.push('--font-path', fontsDir);
    args.push(mainPath, outputPath);

    const result = await runCommand(typstPath, args, prepared.projectRoot);
    const diagnostics = shortDiagnostics(result.stderr);
    if (result.error) {
      return {
        ok: false,
        figureSetReady: true,
        infrastructure: true,
        error: `Impossibile avviare Typst nativo: ${result.error.message}`,
        diagnostics,
      };
    }
    if (result.code !== 0) {
      await fs.promises.rm(outputPath, { force: true }).catch(() => {});
      return {
        ok: false,
        figureSetReady: true,
        infrastructure: false,
        error: diagnostics[0] || result.stderr.trim() || result.stdout.trim() || 'Errore di compilazione Typst.',
        diagnostics,
      };
    }

    let stat;
    try {
      stat = await fs.promises.stat(outputPath);
    } catch (error) {
      return {
        ok: false,
        figureSetReady: true,
        infrastructure: true,
        error: `Typst non ha prodotto il PDF atteso: ${error.message}`,
        diagnostics,
      };
    }
    if (!stat.isFile() || stat.size === 0) {
      return {
        ok: false,
        figureSetReady: true,
        infrastructure: true,
        error: 'Typst nativo ha prodotto un PDF vuoto.',
        diagnostics,
      };
    }

    if (request.diagnoseOnly) {
      await fs.promises.rm(outputPath, { force: true }).catch(() => {});
      return { ok: true, figureSetReady: true, diagnostics };
    }
    if (cachePath) {
      try {
        await fs.promises.mkdir(pdfCacheRoot, { recursive: true });
        const staging = `${cachePath}.${process.pid}.tmp`;
        await fs.promises.copyFile(outputPath, staging);
        await fs.promises.rename(staging, cachePath).catch(async () => {
          await fs.promises.rm(staging, { force: true }).catch(() => {});
        });
        const cached = await fs.promises.stat(cachePath);
        await fs.promises.rm(outputPath, { force: true }).catch(() => {});
        await prunePdfCache(pdfCacheRoot, cachePath);
        return {
          ok: true,
          figureSetReady: true,
          diagnostics,
          pdfPath: cachePath,
          size: cached.size,
          persistent: true,
          cacheHit: false,
        };
      } catch {
        // Se la cache persistente non è scrivibile, il PDF temporaneo resta
        // perfettamente valido: non si trasforma un'ottimizzazione in errore.
      }
    }
    return {
      ok: true,
      figureSetReady: true,
      diagnostics,
      pdfPath: outputPath,
      size: stat.size,
    };
  }

  return { compile, prepareFigureSet };
}

module.exports = {
  createTypstRunner,
  figureRelativePath,
  pdfCacheKey,
  shortDiagnostics,
};
