import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { run, tail } from './util.js';

/**
 * Self-update for a codespace (or any git checkout started with CLIPFORGE_AUTO_UPDATE=1): every few
 * minutes fetch origin/main; when it has moved on and nothing is running, fast-forward, install new
 * packages, check the new code parses, and restart this server in place. Anything that goes wrong
 * rolls back to the version that was running. Docker images have no .git and never self-update.
 * CLIPFORGE_AUTO_UPDATE=0 turns it off.
 */
export function createUpdater({ root, isBusy, beforeRestart, branch = 'main', intervalMs = 60_000, log = console.log }) {
  const flag = process.env.CLIPFORGE_AUTO_UPDATE;
  const enabled = flag !== '0' && (flag === '1' || process.env.CODESPACES === 'true') && fs.existsSync(path.join(root, '.git'));
  const state = { enabled, status: enabled ? 'idle' : 'off', version: null, lastCheck: null, error: null };
  const git = (args) => run('git', args, { cwd: root, timeoutMs: 120_000 });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  let badCommit = null; // a version that failed to install — don't retry it every round

  async function rollback(to, why, bad) {
    await git(['reset', '--hard', to]);
    badCommit = bad;
    state.status = 'error';
    state.error = why;
    log(`  Auto-update skipped: ${why}`);
  }

  async function check() {
    if (!enabled || state.status === 'updating') return state;
    state.lastCheck = Date.now();
    const f = await git(['fetch', '--quiet', 'origin', branch]);
    if (f.code !== 0) {
      state.error = `Could not reach GitHub: ${tail(f.stderr, 2)}`;
      return state;
    }
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const remote = (await git(['rev-parse', `origin/${branch}`])).stdout.trim();
    if (!remote || head === remote || remote === badCommit) {
      if (remote === badCommit) return state;
      state.status = 'idle';
      state.error = null;
      return state;
    }
    if ((await git(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`])).code !== 0) {
      state.status = 'diverged';
      state.error = 'This copy has its own changes, so it is not updated automatically.';
      return state;
    }
    const busy = isBusy(); // a reason string while something must not be interrupted, else falsy
    if (busy) {
      state.status = 'waiting'; // try again next round
      state.error = `Update ready — waiting until ${busy} finishes.`;
      return state;
    }

    state.status = 'updating';
    const m = await git(['merge', '--ff-only', '--quiet', `origin/${branch}`]);
    if (m.code !== 0) {
      state.status = 'error';
      state.error = tail(m.stderr, 2) || 'git could not update';
      return state;
    }
    const changed = (await git(['diff', '--name-only', head, 'HEAD'])).stdout.split('\n');
    if (changed.includes('package.json') || changed.includes('package-lock.json')) {
      // --no-save: never rewrite package-lock.json, so the next update still fast-forwards.
      const r = await run(npm, ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund'], { cwd: root, timeoutMs: 15 * 60_000 });
      if (r.code !== 0) return rollback(head, 'could not install the new version’s packages — staying on the current version.', remote);
    }
    const syntax = await run(process.execPath, ['--check', path.join(root, 'src', 'app.js')]);
    if (syntax.code !== 0) return rollback(head, 'the new version failed a syntax check — staying on the current version.', remote);

    log(`\n  Updating ClipForge ${head.slice(0, 7)} → ${remote.slice(0, 7)} and restarting…`);
    await beforeRestart();
    restart();
    return state;
  }

  /** Start a fresh copy of this server (same command, same environment) and exit. */
  function restart() {
    const logFile = path.join(root, 'workspace', 'server.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    // The codespace start script stops "the previous copy" by this pid.
    try {
      fs.writeFileSync(path.join(root, 'workspace', 'server.pid'), String(child.pid));
    } catch {
      /* not fatal */
    }
    process.exit(0);
  }

  return {
    state: () => ({ ...state }),
    async start() {
      state.version = (await git(['rev-parse', '--short', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim() || null;
      if (!enabled) return;
      const every = Number(process.env.CLIPFORGE_UPDATE_EVERY_S) * 1000 || intervalMs;
      const tick = () => check().catch((err) => { state.error = err.message; });
      setTimeout(tick, Math.min(60_000, every)).unref();
      setInterval(tick, every).unref();
    },
    check,
  };
}
