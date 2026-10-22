// ClipForge entry point. Before loading the app, make sure every dependency in package.json is
// installed: after a `git pull` (e.g. a codespace updating itself on start) new packages may be
// missing, and loading the app would crash instead of installing them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const missing = Object.keys(pkg.dependencies || {}).filter((name) => !fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json')));

if (missing.length) {
  console.log(`\n  Installing new dependencies (${missing.join(', ')})…`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n  Could not install dependencies — run \`npm install\` in ${ROOT} and start ClipForge again.\n`);
    process.exit(1);
  }
}

await import('./app.js');
