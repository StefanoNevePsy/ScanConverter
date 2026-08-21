/*
  Il comando proposto dall'interfaccia deve essere eseguibile così com'è.
  Sbagliare le virgolette su un percorso con spazi — «C:\\Program Files», o
  un volume macOS che si chiama «Disco di lavoro» — manda l'installazione in
  una cartella diversa da quella scelta, e il download è di gigabyte.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommand, healthUrl, modelsUrl, suggestedRoot } from '../src/lib/localSetup.js';

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
