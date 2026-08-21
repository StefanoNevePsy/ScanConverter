import { chmod, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

const VERSION = '0.15.1';
const targets = {
  'win32-x64': 'typst-x86_64-pc-windows-msvc.zip',
  'win32-arm64': 'typst-aarch64-pc-windows-msvc.zip',
  'darwin-x64': 'typst-x86_64-apple-darwin.tar.xz',
  'darwin-arm64': 'typst-aarch64-apple-darwin.tar.xz',
  'linux-x64': 'typst-x86_64-unknown-linux-musl.tar.xz',
  'linux-arm64': 'typst-aarch64-unknown-linux-musl.tar.xz',
};

const target = `${process.platform}-${process.arch}`;
const asset = targets[target];
if (!asset) throw new Error(`Typst nativo non disponibile per ${target}.`);

const destination = path.resolve('native', 'typst', target);
const executable = path.join(destination, process.platform === 'win32' ? 'typst.exe' : 'typst');
const force = process.argv.includes('--force');

async function exists(file) {
  try {
    await chmod(file, process.platform === 'win32' ? 0o666 : 0o755);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} terminato con codice ${code}.`)));
  });
}

async function findExecutable(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutable(candidate);
      if (nested) return nested;
    } else if (entry.name === (process.platform === 'win32' ? 'typst.exe' : 'typst')) {
      return candidate;
    }
  }
  return null;
}

if (!force && await exists(executable)) {
  process.stdout.write(`Typst ${VERSION} già presente: ${executable}\n`);
  process.exit(0);
}

const temporary = await mkdtemp(path.join(tmpdir(), 'scanconverter-typst-'));
try {
  const archive = path.join(temporary, asset);
  const url = `https://github.com/typst/typst/releases/download/v${VERSION}/${asset}`;
  process.stdout.write(`Scarico ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download Typst fallito: HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const extracted = path.join(temporary, 'extracted');
  await mkdir(extracted, { recursive: true });
  await run('tar', ['-xf', archive, '-C', extracted]);
  const sourceExecutable = await findExecutable(extracted);
  if (!sourceExecutable) throw new Error('L’archivio Typst non contiene il compilatore.');
  const sourceRoot = path.dirname(sourceExecutable);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const name of ['LICENSE', 'NOTICE', 'README.md', path.basename(sourceExecutable)]) {
    await cp(path.join(sourceRoot, name), path.join(destination, name));
  }
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  process.stdout.write(`Typst ${VERSION} installato in ${destination}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
