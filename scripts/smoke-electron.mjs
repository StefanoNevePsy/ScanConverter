import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const electron = require('electron');

const code = await new Promise((resolve, reject) => {
  const child = spawn(electron, ['.', '--desktop-smoke'], {
    cwd: process.cwd(),
    env: { ...process.env, SCANCONVERTER_DESKTOP_SMOKE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', reject);
  child.once('exit', (exitCode) => resolve(exitCode ?? 1));
});

if (code !== 0) process.exit(code);
