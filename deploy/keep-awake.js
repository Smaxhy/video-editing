#!/usr/bin/env node
// Keeps a GitHub codespace awake while ClipForge is working.
//
// Codespaces go to sleep after the idle timeout unless someone is typing — or a terminal keeps
// printing. ClipForge runs in the background (no terminal), so a long render, Drive import or AI
// scan doesn't count. This runs in a terminal tab (started automatically, see .vscode/tasks.json)
// and prints a line every minute while ClipForge says it is busy — and nothing while it is idle,
// so an idle codespace still goes to sleep and doesn't use up your free hours.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace', 'activity.json');
const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
let wasBusy = null;

console.log('ClipForge keep-awake: this codespace stays on while ClipForge is rendering, importing or processing.');
console.log('Leave this tab open. When ClipForge is idle, the codespace sleeps after your idle timeout as usual.\n');

function tick() {
  let busy = null;
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - a.at < 2 * 60_000) busy = a.busy; // stale file = ClipForge isn't running
  } catch {
    /* not started yet */
  }
  if (busy) console.log(`[${time()}] working — ${busy}`);
  else if (wasBusy !== false) console.log(`[${time()}] idle — the codespace may sleep after your idle timeout.`);
  wasBusy = Boolean(busy);
}
tick();
setInterval(tick, 60_000);
