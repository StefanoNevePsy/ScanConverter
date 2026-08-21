/*
  Il comando proposto dall'interfaccia deve essere eseguibile così com'è.
  Sbagliare le virgolette su un percorso con spazi — «C:\\Program Files», o
  un volume macOS che si chiama «Disco di lavoro» — manda l'installazione in
  una cartella diversa da quella scelta, e il download è di gigabyte.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildCommand, healthUrl, modelsUrl, suggestedRoot } from '../src/lib/localSetup.js';

const windowsScript = fileURLToPath(
  new URL('../tools/setup/Install-ScanConverter.ps1', import.meta.url),
);

test('lo script usa UTF-8 con BOM per Windows PowerShell 5.1', () => {
  const bytes = readFileSync(windowsScript);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('l’installer Ollama non aspetta il server che lascia in esecuzione', () => {
  const script = readFileSync(windowsScript, 'utf8');
  assert.doesNotMatch(script, /Start-Process\s+-FilePath[^\r\n]*-Wait/);
  assert.match(script, /\$installProcess\.WaitForExit\(\)/);
});

test('il sidecar usa Python 3.12 anche sulle nuove Ubuntu con Python 3.14', () => {
  const script = readFileSync(windowsScript, 'utf8');
  assert.match(script, /uv[^\r\n]*python install 3\.12/);
  assert.match(script, /uv[^\r\n]*venv --python 3\.12/);
  assert.doesNotMatch(script, /python3 -m venv/);
});

test('il virtualenv OCR resta nel filesystem Linux che supporta i symlink', () => {
  const script = readFileSync(windowsScript, 'utf8');
  assert.match(script, /SC_VENV=.*HOME\/\.venvs\/scanconverter-ocr/);
  assert.doesNotMatch(script, /linuxRoot\/sidecar\/\.venv/);
});

test('Nemotron usa una toolchain coerente con Ubuntu 26.04', () => {
  const script = readFileSync(windowsScript, 'utf8');
  assert.match(script, /cuda-compiler-13-2/);
  assert.match(script, /CUDA_HOME=\/usr\/local\/cuda-13\.2/);
  assert.match(script, /torch==2\.12\.1 torchvision==0\.27\.1/);
  assert.match(script, /download\.pytorch\.org\/whl\/cu132/);
  assert.doesNotMatch(script, /cuda-toolkit-(?:12-8|13-2)|\/whl\/cu128/);
  assert.match(script, /gcc-13 g\+\+-13/);
  assert.match(script, /CC=\/usr\/bin\/gcc-13/);
  assert.match(script, /CXX=\/usr\/bin\/g\+\+-13/);
  assert.match(script, /OCR_BUILD_ROOT=.*mktemp -d/);
  assert.match(script, /TORCH_CUDA_ARCH_LIST=.*compute_cap/);
  assert.match(script, /pip cache purge/);
});

test('Windows PowerShell 5.1 riesce a leggere tutto lo script', {
  skip: process.platform !== 'win32',
}, () => {
  const path = windowsScript.replaceAll("'", "''");
  const command = [
    '$parseErrors = $null',
    '$parseTokens = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$parseTokens, [ref]$parseErrors) | Out-Null`,
    'if ($parseErrors.Count) { $parseErrors | Format-List; exit 1 }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('su Windows il comando è PowerShell e cita il percorso', () => {
  const { shell, command } = buildCommand({
    root: 'D:\\ScanConverter',
    components: ['ollama', 'typst'],
    platform: 'windows',
  });
  assert.equal(shell, 'PowerShell');
  assert.match(command, /Install-ScanConverter\.ps1/);
  assert.match(command, /-Root 'D:\\ScanConverter'/);
  assert.match(command, /-Components ollama,typst/);
});

test('su macOS e Linux il comando è lo script sh', () => {
  for (const platform of ['macos', 'linux']) {
    const { command } = buildCommand({
      root: '/Volumes/Esterno/SC',
      components: ['ollama'],
      platform,
    });
    assert.match(command, /\.\/install-scanconverter\.sh/, platform);
    assert.match(command, /--root '\/Volumes\/Esterno\/SC'/, platform);
  }
});

test('un percorso con spazi resta un argomento solo', () => {
  const win = buildCommand({
    root: 'E:\\Disco di lavoro\\ScanConverter',
    components: ['typst'],
    platform: 'windows',
  }).command;
  assert.match(win, /-Root 'E:\\Disco di lavoro\\ScanConverter'/);

  const mac = buildCommand({
    root: '/Volumes/Disco di lavoro/SC',
    components: ['typst'],
    platform: 'macos',
  }).command;
  assert.match(mac, /--root '\/Volumes\/Disco di lavoro\/SC'/);
});

test('un apostrofo nel percorso non chiude la stringa', () => {
  // Su macOS un volume può chiamarsi «Backup di Stefano's Mac».
  const mac = buildCommand({
    root: "/Volumes/Stefano's Mac/SC",
    components: ['typst'],
    platform: 'macos',
  }).command;
  assert.match(mac, /'\/Volumes\/Stefano'\\''s Mac\/SC'/);

  // In PowerShell l'apostrofo si raddoppia.
  const win = buildCommand({
    root: "D:\\Stefano's\\SC",
    components: ['typst'],
    platform: 'windows',
  }).command;
  assert.match(win, /'D:\\Stefano''s\\SC'/);
});

test('il modello finisce nel comando solo se richiesto', () => {
  const senza = buildCommand({ root: '/x', components: ['ollama'], platform: 'linux' }).command;
  assert.equal(/--model/.test(senza), false);
  const con = buildCommand({
    root: '/x',
    components: ['ollama'],
    model: 'qwen3:4b',
    platform: 'linux',
  }).command;
  assert.match(con, /--model qwen3:4b/);
});

test('senza componenti scelti si ricade sui due che non richiedono WSL2', () => {
  const { command } = buildCommand({ root: '/x', components: [], platform: 'linux' });
  assert.match(command, /--components ollama,typst/);
});

test('i percorsi proposti non sono sul disco di sistema', () => {
  assert.match(suggestedRoot('windows'), /^D:/);
  assert.match(suggestedRoot('macos'), /^\/Volumes\//);
});

test('gli indirizzi di verifica derivano da quelli configurati', () => {
  assert.equal(
    modelsUrl('http://localhost:11434/v1/chat/completions'),
    'http://localhost:11434/v1/models',
  );
  assert.equal(modelsUrl('http://192.168.1.9:8080/v1/chat/completions/'), 'http://192.168.1.9:8080/v1/models');
  assert.equal(healthUrl('http://localhost:8000/ocr'), 'http://localhost:8000/health');
});
