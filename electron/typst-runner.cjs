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

function stripTerminalControl(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

/**
 * Mantiene `typst watch` vivo sul documento attivo. Il processo ufficiale
 * conserva parser, layout e memoizzazione fra due salvataggi, mentre invocare
 * `typst compile` ogni volta riparte da zero. Un solo watcher è sufficiente:
 * ScanConverter espone un documento attivo per finestra.
 */
function createIncrementalWatcher({ executable, args, cwd, mainPath, outputPath }) {
  let child = null;
  let pending = null;
  let stdout = '';
  let stderr = '';
  let lastSource = null;
  let lastResult = null;
  let closed = false;

  const finish = (ok, infrastructure = false, fallback = '') => {
    const current = pending;
    if (!current) return;
    pending = null;
    clearTimeout(current.timer);
    // stdout e stderr sono stream distinti: un piccolo rinvio lascia arrivare
    // l'ultima diagnostica prima di chiudere la richiesta.
    setTimeout(async () => {
      const diagnostics = shortDiagnostics(stderr);
      const error = diagnostics.find((line) => /:\s*error:/i.test(line)) || diagnostics[0] || fallback;
      stdout = '';
      stderr = '';
      if (!ok) {
        lastResult = { ok: false, infrastructure, diagnostics, error };
        current.resolve(lastResult);
        return;
      }
      try {
        const stat = await fs.promises.stat(outputPath);
        if (!stat.isFile() || stat.size === 0) throw new Error('PDF incrementale vuoto.');
        lastResult = { ok: true, diagnostics, outputPath, size: stat.size };
        current.resolve(lastResult);
      } catch (error2) {
        lastResult = {
          ok: false,
          infrastructure: true,
          diagnostics,
          error: `Typst incrementale non ha prodotto il PDF: ${error2.message}`,
        };
        current.resolve(lastResult);
      }
    }, 25);
  };

  const inspect = () => {
    // Typst può instradare i messaggi di stato sul terminale di output o di
    // errore a seconda della piattaforma e del tipo di terminale collegato.
    const text = stripTerminalControl(`${stdout}\n${stderr}`);
    if (/compiled (?:successfully|with warnings) in/i.test(text)) finish(true);
    else if (/compiled with errors/i.test(text)) finish(false, false, 'Errore di compilazione Typst.');
  };

  const begin = () => {
    if (pending) throw new Error('Compilazione Typst incrementale già in corso.');
    stdout = '';
    stderr = '';
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending) return;
        pending = null;
        lastResult = {
          ok: false,
          infrastructure: true,
          diagnostics: shortDiagnostics(stderr),
          error: 'Timeout del compilatore Typst incrementale.',
        };
        resolve(lastResult);
      }, 5 * 60 * 1000);
      timer.unref?.();
      pending = { resolve, timer };
    });
  };

  const attach = () => {
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-MAX_DIAGNOSTIC_BYTES);
      inspect();
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_DIAGNOSTIC_BYTES);
      inspect();
    });
    child.once('error', (error) => finish(false, true, error.message));
    child.once('exit', (code) => {
      closed = true;
      finish(false, true, `Il processo Typst incrementale si è chiuso (codice ${code}).`);
    });
  };

  return {
    get closed() { return closed; },
    async start(source) {
      lastSource = source;
      await fs.promises.writeFile(mainPath, source, 'utf8');
      const result = begin();
      child = spawn(executable, ['watch', ...args, mainPath, outputPath], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      attach();
      return result;
    },
    async update(source) {
      if (closed || !child) return { ok: false, infrastructure: true, error: 'Watcher Typst non attivo.' };
      if (source === lastSource && lastResult) {
        if (!lastResult.ok) return lastResult;
        try {
          const stat = await fs.promises.stat(outputPath);
          return { ...lastResult, size: stat.size };
        } catch (error) {
          return {
            ok: false,
            infrastructure: true,
            diagnostics: [],
            error: `Il PDF incrementale non è più disponibile: ${error.message}`,
          };
        }
      }
      const result = begin();
      lastSource = source;
      try {
        await fs.promises.writeFile(mainPath, source, 'utf8');
      } catch (error) {
        finish(false, true, `Impossibile aggiornare il sorgente Typst: ${error.message}`);
      }
      return result;
    },
    kill() {
      closed = true;
      child?.kill();
      child = null;
    },
  };
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
  // Lascia un core al renderer/sistema; sulle workstation consente a Typst
  // di usare fino a 12 job invece del precedente tetto di 8.
  const jobs = Math.max(1, Math.min(12, Number(config.jobs)
    || Math.max(1, os.availableParallelism() - 1)));
  const incrementalWatch = config.incrementalWatch === true;
  const readyFigureSets = new Set();
  const figureSetBytes = new Map();
  const figureSetHashes = new Map();
  const figureSetDigests = new Map();
  let activeWatcher = null;

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
    // Le diagnosi del correttore non devono riscrivere main.typ: se il watcher
    // è attivo, una patch di prova scatenerebbe una seconda compilazione e
    // distruggerebbe il vantaggio incrementale.
    const mainPath = path.join(
      prepared.projectRoot,
      'scanconverter',
      request.diagnoseOnly ? `diagnose-${requestId}.typ` : 'main.typ',
    );
    let outputPath = path.join(prepared.projectRoot, `output-${requestId}.pdf`);
    await fs.promises.mkdir(packageCachePath, { recursive: true });

    const commonArgs = [
      '--diagnostic-format', 'short',
      '--root', prepared.projectRoot,
      '--package-cache-path', packageCachePath,
      '--jobs', String(jobs),
      '--ignore-system-fonts',
    ];
    if (fontsDir && fs.existsSync(fontsDir)) commonArgs.push('--font-path', fontsDir);

    let diagnostics = [];
    let stat = null;
    let usedWatcher = false;
    if (incrementalWatch && !request.diagnoseOnly) {
      const watcherKey = `${prepared.projectRoot}\0${figureDigest}`;
      if (activeWatcher && (activeWatcher.key !== watcherKey || activeWatcher.compiler.closed)) {
        activeWatcher.compiler.kill();
        activeWatcher = null;
      }
      if (!activeWatcher) {
        outputPath = path.join(prepared.projectRoot, 'watch-output.pdf');
        activeWatcher = {
          key: watcherKey,
          compiler: createIncrementalWatcher({
            executable: typstPath,
            args: commonArgs,
            cwd: prepared.projectRoot,
            mainPath,
            outputPath,
          }),
        };
        const watched = await activeWatcher.compiler.start(source);
        if (watched.ok) {
          usedWatcher = true;
          diagnostics = watched.diagnostics || [];
          outputPath = watched.outputPath;
          stat = { isFile: () => true, size: watched.size };
        } else if (!watched.infrastructure) {
          return {
            ok: false,
            figureSetReady: true,
            infrastructure: false,
            error: watched.error || 'Errore di compilazione Typst.',
            diagnostics: watched.diagnostics || [],
          };
        } else {
          activeWatcher.compiler.kill();
          activeWatcher = null;
        }
      } else {
        outputPath = path.join(prepared.projectRoot, 'watch-output.pdf');
        const watched = await activeWatcher.compiler.update(source);
        if (watched.ok) {
          usedWatcher = true;
          diagnostics = watched.diagnostics || [];
          outputPath = watched.outputPath;
          stat = { isFile: () => true, size: watched.size };
        } else if (!watched.infrastructure) {
          return {
            ok: false,
            figureSetReady: true,
            infrastructure: false,
            error: watched.error || 'Errore di compilazione Typst.',
            diagnostics: watched.diagnostics || [],
          };
        } else {
          activeWatcher.compiler.kill();
          activeWatcher = null;
        }
      }
    }

    if (!stat) {
      // Fallback affidabile per ambienti dove il file watcher non è
      // disponibile (alcuni filesystem di rete/esterni) e per le diagnosi.
      await fs.promises.writeFile(mainPath, source, 'utf8');
      const result = await runCommand(
        typstPath,
        ['compile', ...commonArgs, mainPath, outputPath],
        prepared.projectRoot,
      );
      diagnostics = shortDiagnostics(result.stderr);
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
        if (!usedWatcher) await fs.promises.rm(outputPath, { force: true }).catch(() => {});
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

  return {
    compile,
    prepareFigureSet,
    close() {
      activeWatcher?.compiler.kill();
      activeWatcher = null;
    },
  };
}

module.exports = {
  createTypstRunner,
  figureRelativePath,
  pdfCacheKey,
  shortDiagnostics,
  stripTerminalControl,
};
