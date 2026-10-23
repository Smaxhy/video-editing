/* ClipForge front end: media library (resumable tus uploads, hover-scrub previews, player)
   + projects (pick clips, describe the edit, render). Plain JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const fmtTime = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtSize = (b) => (b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB'
  : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round((b || 0) / 1e3)) + ' KB');
const fmtEta = (s) => (!isFinite(s) || s <= 0 ? '' : s < 60 ? `${Math.ceil(s)} s left` : s < 3600 ? `${Math.ceil(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const CODEC = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', prores: 'ProRes', mpeg4: 'MPEG-4', aac: 'AAC', mp3: 'MP3', opus: 'Opus', pcm_s16le: 'PCM', pcm_s24le: 'PCM' };
const codec = (c) => CODEC[c] || (c ? c.toUpperCase() : '—');
const FORMAT_LABEL = { '9x16': '9:16', '4x5': '4:5', '1x1': '1:1', '16x9': '16:9' };
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|mpg|mpeg|3gp|wmv|flv|mxf|ts)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aif|aiff)$/i;
const isMediaFile = (f) => f.size > 0 && (f.type.startsWith('video/') || f.type.startsWith('audio/') || VIDEO_EXT.test(f.name) || AUDIO_EXT.test(f.name));
const store = {
  get: (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  view: null,
  assets: [],
  storage: null,
  projects: [],
  selected: new Set(),
  scanner: null,
  cloud: { available: false, remotes: [], connect: { status: 'idle' }, jobs: [] },
  jobId: null,
  project: null,
  clips: [],
  es: null,
  running: false,
  lastState: null,
  shown: null,
  steps: {},
};

// ---------------------------------------------------------------------------
// Feedback: toasts + screen-reader announcements
// ---------------------------------------------------------------------------
function toast(msg, type = 'info', ms = type === 'error' ? 9000 : 4500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  if (type === 'error') el.setAttribute('role', 'alert');
  el.innerHTML = `<span>${esc(msg)}</span><button type="button" aria-label="Dismiss">×</button>`;
  el.querySelector('button').onclick = () => el.remove();
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}
function announce(msg) {
  const a = $('#announcer');
  a.textContent = '';
  setTimeout(() => (a.textContent = msg), 50);
}

async function api(url, { method = 'GET', body } = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (HTTP ${r.status}).`), { status: r.status, data });
  return data;
}

// ---------------------------------------------------------------------------
// Shared thumbnail with hover-scrub storyboard
// ---------------------------------------------------------------------------
function thumbHtml(item, { previewLabel = null, status = '' } = {}) {
  const tag = previewLabel ? 'button' : 'div';
  // The accessible name repeats the visible badges so speech/voice-control users can target it by what they see.
  const label = [previewLabel, item.duration ? fmtTime(item.duration) : '', status].filter(Boolean).join(', ');
  const attrs = previewLabel ? `type="button" data-preview aria-label="${esc(label)}"` : '';
  const sprite = item.sprite ? `data-sprite="${esc(JSON.stringify(item.sprite))}"` : '';
  return `<${tag} class="thumb" ${attrs} ${sprite}>
    ${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="" loading="lazy" decoding="async" />` : ''}
    <span class="scrub-layer" aria-hidden="true"></span><span class="scrub-line" aria-hidden="true"></span>
    ${previewLabel ? '<span class="play" aria-hidden="true"><svg><use href="#i-play"/></svg></span>' : ''}
    ${item.duration ? `<span class="badge-dur">${fmtTime(item.duration)}</span>` : ''}
    ${status ? `<span class="badge-st">${esc(status)}</span>` : ''}
  </${tag}>`;
}

let scrubEl = null;
function endScrub() {
  scrubEl?.classList.remove('scrubbing');
  scrubEl = null;
}
document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const t = e.target.closest?.('.thumb[data-sprite]');
  if (t !== scrubEl) endScrub();
  if (!t) return;
  scrubEl = t;
  const s = JSON.parse(t.dataset.sprite);
  const r = t.getBoundingClientRect();
  const f = Math.min(0.999, Math.max(0, (e.clientX - r.left) / r.width));
  const i = Math.floor(f * s.count);
  const col = i % s.cols, row = Math.floor(i / s.cols);
  const layer = t.querySelector('.scrub-layer');
  layer.style.backgroundImage = `url("${s.url}")`;
  layer.style.backgroundSize = `${s.cols * 100}% ${s.rows * 100}%`;
  layer.style.backgroundPosition = `${s.cols > 1 ? (col / (s.cols - 1)) * 100 : 0}% ${s.rows > 1 ? (row / (s.rows - 1)) * 100 : 0}%`;
  t.querySelector('.scrub-line').style.width = `${f * 100}%`;
  t.classList.add('scrubbing');
});
document.addEventListener('pointerout', (e) => {
  if (scrubEl && !scrubEl.contains(e.relatedTarget)) endScrub();
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
function assetStatus(a) {
  if (a.status === 'ready') {
    if (a.preview.step === 'shrinking') return `Saving space ${Math.round((a.preview.progress || 0) * 100)}%`;
    if (a.preview.proxy === 'encoding') return `Preparing preview ${Math.round((a.preview.progress || 0) * 100)}%`;
    if (a.ai.status === 'scanning') return 'Claude is looking…';
    if (a.ai.status === 'queued') return 'Waiting for AI scan';
    return a.preview.proxy === 'failed' ? 'No browser preview' : '';
  }
  if (a.preview.step === 'shrinking') return `Saving space ${Math.round((a.preview.progress || 0) * 100)}%`;
  if (a.preview.proxy === 'encoding') return `Preparing preview ${Math.round((a.preview.progress || 0) * 100)}%`;
  if (a.preview.step === 'storyboard') return 'Making storyboard…';
  return 'Processing…';
}
const assetSub = (a) => (a.kind === 'audio'
  ? [a.tags.artist, a.tags.genre, fmtSize(a.size)]
  : [`${a.width}×${a.height}`, fmtSize(a.size), codec(a.videoCodec), a.hasAudio ? '' : 'no audio']).filter(Boolean).join(' · ');
const assetTitle = (a) => (a.kind === 'audio' && a.tags.title ? a.tags.title : a.name);
/** One line of what Claude saw, plus the first few tags. */
function aiHtml(a) {
  if (a.kind === 'audio') return '<div class="tagrow"><span class="tag kind">Music</span></div>';
  if (a.ai.status === 'error') return '<div class="ai-line" style="color:var(--warn)">AI scan failed — open to retry</div>';
  const q = a.quality?.score != null
    ? `<span class="tag ${a.quality.score >= 60 ? 'q-good' : a.quality.score >= 35 ? 'q-ok' : 'q-bad'}" title="Measured quality: sharpness, exposure, shake, sound${a.quality.flags.length ? ` — ${esc(a.quality.flags.join(', '))}` : ''}">★ ${a.quality.score}${a.quality.flags.length ? ` · ${esc(a.quality.flags[0])}` : ''}</span>`
    : '';
  const sounds = (a.sounds || []).map((x) => `<span class="tag snd" title="Heard in the clip">🔊 ${esc(x)}</span>`).join('');
  if (a.ai.status !== 'done') return q || sounds ? `<div class="tagrow">${q}${sounds}</div>` : '';
  return `<div class="ai-line" title="${esc(a.ai.summary)}">${esc(a.ai.summary)}</div>
    <div class="tagrow">${q}${sounds}${a.ai.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
}

function assetCard(a) {
  const sel = state.selected.has(a.id);
  return `<li class="asset${sel ? ' selected' : ''}" data-id="${a.id}">
    <label class="sel"><input type="checkbox" data-select ${sel ? 'checked' : ''} aria-label="Select ${esc(a.name)}" /></label>
    ${thumbHtml(a, { previewLabel: `Preview ${a.name}`, status: assetStatus(a) })}
    <div class="info"><div class="name" title="${esc(a.name)}">${esc(assetTitle(a))}</div><div class="sub">${esc(assetSub(a))}</div>${aiHtml(a)}</div>
  </li>`;
}

/** Search matches the file name, Claude's description and tags, and music metadata — every word must hit. */
const haystack = (a) => [a.name, a.ai?.summary, ...(a.ai?.tags || []), ...(a.ai?.moments || []).map((m) => m.what), ...(a.sounds || []), ...(a.quality?.flags || []), ...Object.values(a.tags || {})]
  .filter(Boolean).join(' ').toLowerCase();
function visibleAssets(query, sort, filter = 'all') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const keep = {
    all: () => true,
    video: (a) => a.kind === 'video',
    audio: (a) => a.kind === 'audio',
    unscanned: (a) => a.kind === 'video' && a.ai.status !== 'done',
  }[filter] || (() => true);
  const list = state.assets.filter((a) => keep(a) && words.every((w) => haystack(a).includes(w)));
  // Search by meaning (local CLIP model): add the best visual matches and put them first.
  const sem = state.semantic?.q === query.trim() ? state.semantic.rank : null;
  if (sem) {
    for (const a of state.assets) if (keep(a) && sem.has(a.id) && !list.includes(a)) list.push(a);
    return list.sort((x, y) => (sem.has(x.id) ? sem.get(x.id) : 1e9) - (sem.has(y.id) ? sem.get(y.id) : 1e9));
  }
  const by = {
    new: (x, y) => y.createdAt - x.createdAt,
    old: (x, y) => x.createdAt - y.createdAt,
    name: (x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }),
    size: (x, y) => y.size - x.size,
    long: (x, y) => y.duration - x.duration,
  }[sort] || (() => 0);
  return list.sort(by);
}

function renderLibrary() {
  const list = visibleAssets($('#libSearch').value, $('#libSort').value, $('#libFilter').value);
  const grid = $('#assetGrid');
  const focusId = document.activeElement?.closest?.('.asset')?.dataset.id;
  const focusSel = document.activeElement?.matches?.('[data-select]') ? '[data-select]' : '[data-preview]';
  grid.innerHTML = list.map(assetCard).join('');
  if (focusId) $(`.asset[data-id="${focusId}"] ${focusSel}`, grid)?.focus();
  $('#libEmpty').classList.toggle('hidden', list.length > 0 || state.assets.length === 0);
  $('#libDrop').classList.toggle('compact', state.assets.length > 0);
  $('#libDrop strong').textContent = state.assets.length ? 'Drop more videos or music anywhere on this page' : 'Drop videos or music anywhere on this page';
  $('#libCount').textContent = state.assets.length || '';
  renderSelbar();
  renderDisk();
  renderScanBar();
  renderMusicSelect();
}

/** Patch one card in place (keeps hover/focus) — used for live preview progress. */
function updateAssetCard(a) {
  const old = $(`#assetGrid .asset[data-id="${a.id}"]`);
  if (!old) return renderLibrary();
  const hadFocus = old.contains(document.activeElement) && (document.activeElement.matches('[data-select]') ? '[data-select]' : '[data-preview]');
  const tpl = document.createElement('template');
  tpl.innerHTML = assetCard(a).trim();
  old.replaceWith(tpl.content.firstChild);
  if (hadFocus) $(`#assetGrid .asset[data-id="${a.id}"] ${hadFocus}`)?.focus();
}

function renderDisk() {
  const s = state.storage;
  if (!s) return;
  const used = s.total ? (s.total - s.free) / s.total : 0;
  const low = s.free != null && s.free < 10e9;
  $('#disk').innerHTML = `
    <div><strong style="color:var(--text)">${fmtSize(s.library)}</strong> in library · ${fmtSize(s.projects)} project files</div>
    ${s.total ? `<div class="meter${low ? ' low' : ''}" role="meter" aria-label="Disk used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used * 100)}"><div style="width:${used * 100}%"></div></div>
    <div${low ? ' class="miss"' : ''}>${fmtSize(s.free)} free of ${fmtSize(s.total)}</div>` : ''}`;
}

async function loadLibrary() {
  const data = await api('/api/library');
  state.assets = data.assets;
  state.storage = data.storage;
  renderLibrary();
}
let storageTimer = null;
const refreshStorageSoon = () => {
  clearTimeout(storageTimer);
  storageTimer = setTimeout(() => api('/api/library').then((d) => { state.storage = d.storage; renderDisk(); }).catch(() => {}), 1500);
};

function listenLibrary() {
  const es = new EventSource('/api/library/events');
  es.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    if ($('#activity').classList.contains('hidden')) kickActivity(); // idle → show new work right away
    if (evt.type === 'asset') {
      const i = state.assets.findIndex((a) => a.id === evt.asset.id);
      if (i >= 0) state.assets[i] = evt.asset;
      else state.assets.push(evt.asset);
      if (i >= 0) updateAssetCard(evt.asset);
      else renderLibrary();
      if (viewer.assetId === evt.asset.id) refreshViewer(evt.asset);
      // Project clips show the same storyboard/preview, so refresh them when it lands.
      if (state.clips.some((c) => c.assetId === evt.asset.id) && evt.asset.status === 'ready') reloadClips();
    } else if (evt.type === 'removed') {
      state.assets = state.assets.filter((a) => a.id !== evt.id);
      state.selected.delete(evt.id);
      renderLibrary();
      refreshStorageSoon();
    } else if (evt.type === 'scanner') {
      state.scanner = evt.scanner;
      renderScanBar();
    } else if (evt.type === 'import') {
      const i = state.cloud.jobs.findIndex((j) => j.id === evt.job.id);
      const was = state.cloud.jobs[i]?.state;
      if (i >= 0) state.cloud.jobs[i] = evt.job;
      else state.cloud.jobs.unshift(evt.job);
      renderJobs();
      if (was === 'running' && evt.job.state === 'done') {
        toast(`Import finished: ${plural(evt.job.done - evt.job.failed.length, 'file')} added${evt.job.failed.length ? `, ${evt.job.failed.length} failed` : ''}.`, evt.job.failed.length ? 'error' : 'ok');
        refreshStorageSoon();
      }
    } else if (evt.type === 'autopilot') {
      onAutopilot(evt.autopilot);
    } else if (evt.type === 'connect') {
      state.cloud.connect = evt.connect;
      if (evt.connect.status === 'done') loadCloud().then(() => toast('Google Drive connected.', 'ok'));
      else if ($('#importDlg').open) renderImport();
    }
  };
}

// ---------------------------------------------------------------------------
// AI scan bar
// ---------------------------------------------------------------------------
function renderScanBar() {
  const sc = state.scanner;
  if (!sc) return;
  const videos = state.assets.filter((a) => a.kind === 'video' && a.status === 'ready');
  const done = videos.filter((a) => a.ai.status === 'done').length;
  const failed = videos.filter((a) => a.ai.status === 'error').length;
  const waiting = videos.filter((a) => a.ai.status === 'none').length;
  $('#autoScan').checked = sc.autoScan;
  let text;
  if (sc.scanning || sc.queued) text = `Claude is looking at your videos — ${sc.scanning + sc.queued} to go (${done} of ${videos.length} done).`;
  else if (!videos.length) text = 'Claude looks at every video you add and notes what is in it, so you can search by content.';
  else text = `${done} of ${plural(videos.length, 'video')} scanned.${failed ? ` ${failed} failed.` : ''}`;
  if (sc.lastError && !sc.scanning) text += ` Last problem: ${sc.lastError}`;
  $('#scanStatus').textContent = text;
  const todo = waiting + failed;
  $('#scanAll').classList.toggle('hidden', !todo || Boolean(sc.scanning || sc.queued));
  $('#scanAll').textContent = `Scan ${plural(todo, 'video')} now`;
}
$('#autoScan').addEventListener('change', async () => {
  try { state.scanner = await api('/api/scanner', { method: 'PATCH', body: { autoScan: $('#autoScan').checked } }); renderScanBar(); }
  catch (err) { toast(err.message, 'error'); }
});
$('#shrinkLarge').addEventListener('change', async () => {
  try { await api('/api/library/settings', { method: 'PATCH', body: { shrinkLarge: $('#shrinkLarge').checked } }); }
  catch (err) { toast(err.message, 'error'); }
});
$('#scanAll').addEventListener('click', async () => {
  try {
    const r = await api('/api/library/scan', { method: 'POST', body: {} });
    state.scanner = r.scanner;
    renderScanBar();
    announce(`Scanning ${plural(r.queued, 'video')}.`);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------------------------------------------------------------------------
// Google Drive import (rclone on the server)
// ---------------------------------------------------------------------------
async function loadCloud() {
  try { state.cloud = await api('/api/cloud'); } catch { return; }
  renderJobs();
  if ($('#importDlg').open) renderImport();
}

function renderJobs() {
  const jobs = state.cloud.jobs.filter((j) => j.state === 'running' || Date.now() - j.startedAt < 30 * 60_000);
  $('#importJobs').innerHTML = jobs.map((j) => {
    const cur = j.current.reduce((n, c) => n + c.bytes, 0);
    const pct = j.totalBytes ? Math.floor(((j.doneBytes + cur) / j.totalBytes) * 100) : j.total ? Math.floor((j.done / j.total) * 100) : 100;
    const head = { running: 'Importing', done: 'Imported', cancelled: 'Import cancelled', error: 'Import failed' }[j.state];
    return `<li class="job" data-job="${esc(j.id)}">
      <div class="row"><strong>${head}: ${esc(j.label)}</strong>
        ${j.state === 'running' ? `<button class="btn xs ghost" type="button" data-cancel-job>Cancel</button>` : `<button class="btn xs ghost" type="button" data-dismiss-job aria-label="Dismiss">×</button>`}</div>
      <div class="pbar" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
      <div class="sub">${j.done} of ${plural(j.total, 'file')} · ${fmtSize(j.doneBytes + cur)} of ${fmtSize(j.totalBytes)}${j.skipped ? ` · ${j.skipped} already in your library` : ''}${j.current.length ? ` · now: ${esc(j.current.map((c) => c.name.split('/').pop()).join(', '))}` : ''}</div>
      ${j.failed.length ? `<div class="uperr">${j.failed.length} failed: ${esc(j.failed.slice(0, 3).map((f) => `${f.name.split('/').pop()} (${f.error})`).join('; '))}${j.failed.length > 3 ? '…' : ''}</div>` : ''}
    </li>`;
  }).join('');
}
$('#importJobs').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-job]');
  if (!li) return;
  if (e.target.closest('[data-cancel-job]')) await api(`/api/cloud/import/${li.dataset.job}`, { method: 'DELETE' }).catch(() => {});
  if (e.target.closest('[data-dismiss-job]')) { state.cloud.jobs = state.cloud.jobs.filter((j) => j.id !== li.dataset.job); renderJobs(); }
});

const imp = { remote: '', link: '', sharedWithMe: false, preview: null, busy: false, error: '' };
/** The error, plus rclone's own words under "Technical details" — screenshot-able when asking for help. */
const errorHtml = (c) => (c.error
  ? `<div class="uperr" role="alert">${esc(c.error)}</div>${c.detail ? `<details class="adv"><summary>Technical details</summary><pre>${esc(String(c.detail).split('\n').slice(-12).join('\n'))}</pre></details>` : ''}`
  : '');
function renderImport() {
  const c = state.cloud;
  const body = $('#imBody');
  const conn = c.connect || { status: 'idle' };
  if (!c.available) {
    body.innerHTML = `<p>Importing from Google Drive uses <a href="https://rclone.org" target="_blank" rel="noopener">rclone</a>, a free open-source tool, on the computer or server running ClipForge. It isn't installed yet.</p>
      <ol class="im-steps"><li>Install it: <a href="https://rclone.org/install/" target="_blank" rel="noopener">rclone.org/install</a> (Mac: <code>brew install rclone</code> · Linux: <code>sudo -v ; curl https://rclone.org/install.sh | sudo bash</code> · or run <code>scripts/setup.sh</code>).</li>
      <li>Restart ClipForge and open this again.</li></ol>`;
    return;
  }
  const drives = c.remotes.filter((r) => r.type === 'drive' && r.connected !== false && !(conn.remote === r.name && conn.status !== 'done' && conn.status !== 'idle'));
  if (['waiting-browser', 'starting', 'resolving'].includes(conn.status)) {
    if (!conn.url) {
      body.innerHTML = '<p role="status">Getting the Google sign-in ready…</p>';
      // Don't rely only on the live event stream (it can drop, e.g. right after an update): check again.
      clearTimeout(renderImport.poll);
      renderImport.poll = setTimeout(() => { if ($('#importDlg').open) loadCloud(); }, 1500);
      return;
    }
    body.innerHTML = `<p>ClipForge gets <strong>read-only</strong> access — it can copy your videos and music but never change or delete anything in your Drive.</p>
      <ol class="im-steps">
        <li><a class="btn" href="${esc(conn.url)}" target="_blank" rel="noopener">Sign in with Google</a><br />Pick your account and tap <strong>Allow</strong> (Google may say the app is “rclone” — that's the open-source tool ClipForge uses).</li>
        <li>Google then opens a page that <strong>doesn't load</strong> — “can't connect to the server”, with an address starting <code>127.0.0.1:53682</code>. That's expected.</li>
        <li>Tap that page's address bar, <strong>copy the whole address</strong>, come back to this tab and paste it here:</li>
      </ol>
      <label class="sr-only" for="redirIn">Address of the page Google opened</label>
      <textarea class="token" id="redirIn" placeholder="http://127.0.0.1:53682/?state=…&code=…" style="min-height:70px"></textarea>
      ${errorHtml(conn)}
      <p class="im-actions"><button class="btn" type="button" data-im="finish">Finish connecting</button>
        <button class="btn sm ghost" type="button" data-im="cancel-connect">Cancel</button></p>
      <p class="hint-line">Only if ClipForge runs on this very computer (not in a codespace) does it connect by itself after Allow.</p>`;
    return;
  }
  if (conn.status === 'need-token') {
    body.innerHTML = `<p><strong>Connect from any computer with a browser</strong> (Windows, Mac or Linux):</p>
      <ol class="im-steps">
        <li>Install rclone on it: <a href="https://rclone.org/downloads/" target="_blank" rel="noopener">rclone.org/downloads</a></li>
        <li>Open a terminal there and run this — it opens Google sign-in:
          <div class="codebox"><code id="authCmd">${esc(conn.command)}</code><button class="btn xs ghost" type="button" data-im="copy">Copy</button></div></li>
        <li>After you allow access, it prints a block of text starting with <code>{</code>. Paste all of it here:</li>
      </ol>
      <label class="sr-only" for="tokenIn">Result from rclone authorize</label>
      <textarea class="token" id="tokenIn" placeholder='{"access_token":"…"}'></textarea>
      ${errorHtml(conn)}
      <p class="im-actions"><button class="btn" type="button" data-im="token">Connect</button> <button class="btn sm ghost" type="button" data-im="cancel-connect">Cancel</button></p>`;
    return;
  }
  const others = c.remotes.filter((r) => r.type !== 'drive');
  if (!drives.length && !imp.useOther) {
    body.innerHTML = `<p>Connect your Google account once. ClipForge gets <strong>read-only</strong> access — it copies videos and music into your library and never changes anything in your Drive.</p>
      ${conn.status === 'error' ? errorHtml(conn) : ''}
      <div class="im-actions">
        <button class="btn" type="button" data-im="connect-local">Connect Google Drive</button>
      </div>
      <p class="hint-line">Works from a phone too. <button class="btn xs ghost" type="button" data-im="connect-remote">Other way: use a computer with rclone</button></p>
      ${others.length ? `<p class="hint-line">Other storage set up in rclone: ${others.map((r) => esc(`${r.name} (${r.type})`)).join(', ')} — <button class="btn xs ghost" type="button" data-im="use-other">import from those</button></p>` : ''}`;
    return;
  }
  const remotes = c.remotes.filter((r) => r.connected !== false);
  if (!remotes.some((r) => r.name === imp.remote)) imp.remote = drives[0]?.name || remotes[0].name;
  const isDrive = remotes.find((r) => r.name === imp.remote)?.type === 'drive';
  const p = imp.preview;
  body.innerHTML = `<div class="im-grid">
      ${remotes.length > 1 ? `<label class="f">From<select class="field" id="imRemote">${remotes.map((r) => `<option value="${esc(r.name)}"${r.name === imp.remote ? ' selected' : ''}>${esc(r.type === 'drive' ? `Google Drive (${r.name})` : `${r.name} (${r.type})`)}</option>`).join('')}</select></label>` : ''}
      <label class="f">${isDrive ? 'Folder link' : 'Folder path'}
        <small>${isDrive ? 'In Drive, right-click a folder → Share → Copy link. Leave empty to import your <strong>entire</strong> Drive.' : 'Leave empty for everything.'}</small>
        <input class="field" id="imLink" value="${esc(imp.link)}" placeholder="${isDrive ? 'https://drive.google.com/drive/folders/…' : 'Videos/2024'}" autocomplete="off" /></label>
      ${isDrive ? `<label class="tg"><input type="checkbox" id="imShared" ${imp.sharedWithMe ? 'checked' : ''} /> <span>Import “Shared with me” instead of My Drive</span></label>` : ''}
      <div class="im-actions"><button class="btn ghost" type="button" data-im="preview" ${imp.busy ? 'disabled' : ''}>${imp.busy ? 'Looking…' : 'Check what\'s there'}</button></div>
      ${imp.error ? `<p class="uperr" role="alert">${esc(imp.error)}</p>${/connect Google Drive again/i.test(imp.error) ? '<p class="im-actions"><button class="btn sm" type="button" data-im="connect-local">Reconnect Google Drive</button></p>' : ''}` : ''}
      ${p ? `<div class="im-sum" role="status">Found <strong>${plural(p.videos, 'video')}</strong> and <strong>${plural(p.music, 'music file')}</strong>${p.alreadyImported ? ` (${p.alreadyImported} already in your library)` : ''}.
          ${p.newFiles ? `<br /><strong>${plural(p.newFiles, 'new file')}, ${fmtSize(p.newBytes)}</strong> will be copied${state.storage?.free != null ? ` — ${fmtSize(state.storage.free)} free on the server` : ''}.
          <ul>${p.sample.map((x) => `<li>${esc(x)}</li>`).join('')}${p.newFiles > p.sample.length ? `<li>…and ${p.newFiles - p.sample.length} more</li>` : ''}</ul>` : '<br />Nothing new to import.'}</div>
        ${p.newFiles ? `<div class="im-actions"><button class="btn" type="button" data-im="import">Import ${plural(p.newFiles, 'file')}</button><span class="hint-line">Runs on the server — you can close this and keep working. ${$('#autoScan').checked ? 'Claude scans each video as it arrives.' : ''}</span></div>` : ''}` : ''}
      <p class="hint-line"><button class="btn xs ghost" type="button" data-im="connect-local">${drives.length ? 'Connect another Google account' : 'Connect Google Drive'}</button></p>
    </div>`;
}

$('#openImport').addEventListener('click', async () => {
  imp.preview = null;
  imp.error = '';
  await loadCloud();
  renderImport();
  $('#importDlg').showModal();
});
$('#imBody').addEventListener('input', (e) => {
  if (e.target.id === 'imLink') { imp.link = e.target.value; imp.preview = null; }
  if (e.target.id === 'imShared') { imp.sharedWithMe = e.target.checked; imp.preview = null; renderImport(); }
  if (e.target.id === 'imRemote') { imp.remote = e.target.value; imp.preview = null; renderImport(); }
});
$('#imBody').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-im]')?.dataset.im;
  if (!act) return;
  const opts = () => ({ remote: imp.remote, link: imp.link.trim(), sharedWithMe: imp.sharedWithMe });
  try {
    if (act === 'connect-local' || act === 'connect-remote') {
      state.cloud.connect = { status: 'starting' };
      renderImport();
      state.cloud.connect = await api('/api/cloud/connect', { method: 'POST', body: { local: act === 'connect-local' } });
    } else if (act === 'finish') {
      state.cloud.connect = await api('/api/cloud/connect/finish', { method: 'POST', body: { url: $('#redirIn').value } });
      if (state.cloud.connect.status === 'done') { await loadCloud(); toast('Google Drive connected.', 'ok'); }
    } else if (act === 'cancel-connect') {
      await api('/api/cloud/connect', { method: 'DELETE' });
      state.cloud.connect = { status: 'idle' };
      await loadCloud();
    } else if (act === 'copy') {
      await navigator.clipboard?.writeText($('#authCmd').textContent).catch(() => {});
      toast('Copied.', 'ok', 1500);
    } else if (act === 'token') {
      state.cloud.connect = await api('/api/cloud/connect/token', { method: 'POST', body: { token: $('#tokenIn').value } });
      await loadCloud();
    } else if (act === 'use-other') {
      imp.remote = state.cloud.remotes.find((r) => r.type !== 'drive').name;
      imp.useOther = true;
    } else if (act === 'preview') {
      imp.busy = true; imp.error = ''; renderImport();
      try { imp.preview = await api('/api/cloud/preview', { method: 'POST', body: opts() }); }
      catch (err) { imp.error = err.data?.hint ? `${err.message} ${err.data.hint}` : err.message; imp.preview = null; }
      imp.busy = false;
    } else if (act === 'import') {
      const { job } = await api('/api/cloud/import', { method: 'POST', body: opts() });
      state.cloud.jobs.unshift(job);
      renderJobs();
      $('#importDlg').close();
      toast('Import started — files appear in your library as they arrive.', 'ok');
      return;
    }
  } catch (err) {
    state.cloud.connect = {
      ...state.cloud.connect,
      status: state.cloud.connect.status === 'starting' ? 'error' : state.cloud.connect.status,
      error: err.message,
      detail: err.data?.detail || null,
    };
    toast(err.message, 'error');
  }
  renderImport();
});

$('#libSearch').addEventListener('input', () => {
  renderLibrary();
  clearTimeout(state.semanticTimer);
  const q = $('#libSearch').value.trim();
  if (q.length < 3) return;
  state.semanticTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/library/search?q=${encodeURIComponent(q)}`);
      if ($('#libSearch').value.trim() !== q || !r.results.length) return;
      // Keep the clear matches: the top 24, and nothing far below the best score.
      const best = r.results[0].score;
      const top = r.results.filter((x, i) => i < 24 && x.score >= best - 0.06);
      state.semantic = { q, rank: new Map(top.map((x, i) => [x.id, i])) };
      renderLibrary();
      announce(`${top.length} clips match by meaning.`);
    } catch {}
  }, 500);
});
$('#libFilter').addEventListener('change', renderLibrary);
$('#libSort').addEventListener('change', () => { store.set('clipforge:sort', $('#libSort').value); renderLibrary(); });

$('#assetGrid').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-select]');
  if (!cb) return;
  const id = cb.closest('.asset').dataset.id;
  cb.checked ? state.selected.add(id) : state.selected.delete(id);
  cb.closest('.asset').classList.toggle('selected', cb.checked);
  renderSelbar();
});
$('#assetGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preview]');
  if (b) openAsset(b.closest('.asset').dataset.id, b);
});

function projectOptions(selectedId) {
  return state.projects.map((p) => `<option value="${esc(p.id)}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}</option>`).join('') +
    '<option value="__new">+ New project</option>';
}
function renderSelbar() {
  const n = state.selected.size;
  $('#selbar').classList.toggle('hidden', n === 0);
  if (!n) return;
  $('#selCount').textContent = `${plural(n, 'video')} selected`;
  $('#selProject').innerHTML = projectOptions(state.jobId || store.get('clipforge:last'));
}
$('#selClear').addEventListener('click', () => { state.selected.clear(); renderLibrary(); });
$('#selAdd').addEventListener('click', async () => {
  const ids = visibleAssets('', $('#libSort').value, 'video').map((a) => a.id).filter((id) => state.selected.has(id));
  if (!ids.length) return toast('Music goes in a project\'s Music option (under Output), not in its clips.', 'error');
  try {
    const projectId = await resolveProject($('#selProject').value);
    await api(`/api/projects/${projectId}/clips`, { method: 'POST', body: { assetIds: ids } });
    state.selected.clear();
    renderLibrary();
    toast(`Added ${plural(ids.length, 'video')} to the project.`, 'ok');
    location.hash = `#/project/${projectId}`;
  } catch (err) { toast(err.message, 'error'); }
});
$('#selDelete').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (!confirm(`Permanently delete ${plural(ids.length, 'video')} from the library? They'll also be removed from any project using them.`)) return;
  for (const id of ids) {
    try { await api(`/api/library/${id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, 'error'); }
  }
  state.selected.clear();
  await Promise.all([loadLibrary(), loadProjects()]);
  if (state.jobId) reloadClips();
  announce(`Deleted ${plural(ids.length, 'video')}.`);
});

async function resolveProject(value) {
  if (value && value !== '__new') return value;
  const { project } = await api('/api/projects', { method: 'POST', body: {} });
  await loadProjects();
  return project.id;
}

// ---------------------------------------------------------------------------
// Uploads — tus resumable protocol (https://github.com/tus/tus-js-client)
// ---------------------------------------------------------------------------
const uploads = [];
let uploadSeq = 0;
const MAX_PARALLEL = 2;
// Each upload request carries one piece. Proxies in front of ClipForge cap request size — GitHub
// Codespaces answers 413 above ~16 MB, Cloudflare at 100 MB, nginx at 1 MB by default — so pieces
// start at 8 MB and halve whenever a 413 comes back. The size that works is remembered per device.
const MIN_CHUNK = 256 * 1024;
let chunkSize = Number(store.get('clipforge:chunk')) || 8 * 1024 * 1024;

// Keep a phone's screen on while uploading — a locked screen pauses the browser.
let wakeLock = null;
async function holdWakeLock(on) {
  try {
    if (on && !wakeLock) wakeLock = await navigator.wakeLock?.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && uploads.some((u) => u.status === 'uploading')) { wakeLock = null; holdWakeLock(true); }
});

async function filesFromDrop(dt) {
  // Folders: walk them for videos. webkitGetAsEntry must be read synchronously in the drop event.
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((e) => e.isDirectory)) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) return out.push(await new Promise((res, rej) => entry.file(res, rej)));
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await walk(e);
    } while (batch.length);
  };
  for (const e of entries) await walk(e);
  return out;
}

function addFiles(fileList, projectId = null) {
  const files = [...fileList];
  const ok = files.filter(isMediaFile);
  const skipped = files.filter((f) => !isMediaFile(f));
  if (skipped.length) toast(`Skipped ${plural(skipped.length, 'file')} that aren't videos: ${skipped.slice(0, 5).map((f) => f.name).join(', ')}${skipped.length > 5 ? '…' : ''}`, 'error');
  if (!ok.length) return;
  for (const file of ok) {
    const u = { key: `u${++uploadSeq}`, file, projectId, status: 'queued', sent: 0, rate: 0, poster: null, error: null, tus: null };
    uploads.push(u);
    makePoster(u);
  }
  renderUploads();
  pump();
  announce(`Uploading ${plural(ok.length, 'video')}.`);
}

function pump() {
  holdWakeLock(uploads.some((u) => ['queued', 'uploading', 'finishing'].includes(u.status)));
  while (uploads.filter((u) => u.status === 'uploading' || u.status === 'finishing').length < MAX_PARALLEL) {
    const next = uploads.find((u) => u.status === 'queued');
    if (!next) break;
    startUpload(next);
  }
}

function startUpload(u) {
  u.status = 'uploading';
  u.error = null;
  u.lastTick = { t: performance.now(), b: u.sent };
  if (!u.tus) {
    u.tus = new tus.Upload(u.file, {
      endpoint: `${location.origin}/api/uploads`,
      chunkSize,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000, 120000],
      metadata: { filename: u.file.name, filetype: u.file.type || '' },
      removeFingerprintOnSuccess: true,
      onShouldRetry: (err) => {
        const s = err.originalResponse?.getStatus?.();
        return !s || s === 409 || s === 423 || (s >= 500 && s !== 507);
      },
      onProgress: (sent, total) => {
        u.sent = sent;
        const now = performance.now();
        const dt = (now - u.lastTick.t) / 1000;
        if (dt > 0.7) {
          const r = (sent - u.lastTick.b) / dt;
          u.rate = u.rate ? u.rate * 0.7 + r * 0.3 : r;
          u.lastTick = { t: now, b: sent };
        }
        if (sent >= total) u.status = 'finishing';
        updateUploadCard(u);
      },
      onSuccess: ({ lastResponse }) => {
        let asset = null;
        try { asset = JSON.parse(lastResponse.getBody()).asset; } catch {}
        finishUpload(u, asset);
      },
      onError: (err) => {
        const s = err.originalResponse?.getStatus?.();
        if (s === 413 && chunkSize > MIN_CHUNK) {
          // The proxy refused the piece size — retry this file (it resumes) with smaller pieces.
          chunkSize = Math.max(MIN_CHUNK, Math.floor(chunkSize / 2));
          store.set('clipforge:chunk', chunkSize);
          u.tus = null;
          u.status = 'queued';
          renderUploads();
          return pump();
        }
        if (s === 401) $('#login').classList.remove('hidden');
        const body = err.originalResponse?.getBody?.()?.trim();
        u.status = 'error';
        // 4xx/507 bodies are our own messages ("not a video", "not enough disk space"); anything else is the network.
        u.error = body && s && (s < 500 || s === 507) ? body : 'Upload interrupted — the connection dropped. Retry to continue where it stopped.';
        renderUploads();
        pump();
      },
    });
    u.tus.findPreviousUploads().then((prev) => {
      if (prev.length) {
        u.tus.resumeFromPreviousUpload(prev[0]);
        toast(`Resuming ${u.file.name} where it left off.`, 'ok');
      }
      if (u.status === 'uploading') u.tus.start();
    });
  } else {
    u.tus.start();
  }
  renderUploads();
}

async function finishUpload(u, asset) {
  uploads.splice(uploads.indexOf(u), 1);
  if (asset && !state.assets.some((a) => a.id === asset.id)) state.assets.push(asset);
  renderLibrary();
  renderUploads();
  pump();
  refreshStorageSoon();
  announce(`${u.file.name} uploaded.`);
  if (asset && u.projectId) {
    try {
      await api(`/api/projects/${u.projectId}/clips`, { method: 'POST', body: { assetIds: [asset.id] } });
      if (u.projectId === state.jobId) reloadClips();
      loadProjects();
    } catch (err) {
      toast(`${u.file.name} is in your library, but couldn't be added to the project: ${err.message}`, 'error');
    }
  }
  if (!uploads.length) toast('All uploads finished.', 'ok');
}

function uploadCard(u) {
  const pct = u.file.size ? Math.floor((u.sent / u.file.size) * 100) : 0;
  const status = { queued: 'Waiting…', uploading: `Uploading ${pct}%`, paused: 'Paused', finishing: 'Checking video…', error: 'Failed' }[u.status];
  return `<li class="asset uploading" data-key="${u.key}">
    ${thumbHtml({ thumbnail: u.poster }, { status })}
    <div class="info">
      <div class="name" title="${esc(u.file.name)}">${esc(u.file.name)}</div>
      <div class="pbar" role="progressbar" aria-label="Upload progress for ${esc(u.file.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
      <div class="sub" data-prog>${esc(progressText(u))}</div>
      ${u.error ? `<div class="uperr">${esc(u.error)}</div>` : ''}
      <div class="uprow">
        ${u.status === 'uploading' ? `<button class="btn xs ghost" type="button" data-act="pause">Pause</button>` : ''}
        ${u.status === 'paused' || u.status === 'error' ? `<button class="btn xs" type="button" data-act="resume">${u.status === 'error' ? 'Retry' : 'Resume'}</button>` : ''}
        ${u.status !== 'finishing' ? `<button class="btn xs ghost" type="button" data-act="cancel" aria-label="Cancel upload of ${esc(u.file.name)}">Cancel</button>` : ''}
      </div>
    </div>
  </li>`;
}
function progressText(u) {
  if (u.status === 'finishing') return `${fmtSize(u.file.size)} · reading video info…`;
  const base = `${fmtSize(u.sent)} of ${fmtSize(u.file.size)}`;
  if (u.status !== 'uploading' || !u.rate) return base;
  return `${base} · ${fmtSize(u.rate)}/s · ${fmtEta((u.file.size - u.sent) / u.rate)}`;
}
function renderUploads() {
  $('#uploadGrid').innerHTML = uploads.map(uploadCard).join('');
  $('#projUploads').innerHTML = uploads.filter((u) => u.projectId && u.projectId === state.jobId).map(uploadCard).join('');
}
function updateUploadCard(u) {
  for (const card of $$(`[data-key="${u.key}"]`)) {
    const pct = Math.floor((u.sent / u.file.size) * 100);
    const bar = $('.pbar', card);
    bar.setAttribute('aria-valuenow', pct);
    bar.firstElementChild.style.width = `${pct}%`;
    $('[data-prog]', card).textContent = progressText(u);
    const st = $('.badge-st', card);
    if (st) st.textContent = u.status === 'finishing' ? 'Checking video…' : `Uploading ${pct}%`;
    if (u.status === 'finishing' && $('[data-act]', card)) renderUploads();
  }
}
function onUploadAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const u = uploads.find((x) => x.key === b.closest('[data-key]').dataset.key);
  if (!u) return;
  if (b.dataset.act === 'pause') { u.status = 'paused'; u.tus?.abort(); renderUploads(); pump(); }
  if (b.dataset.act === 'resume') { u.status = 'queued'; renderUploads(); pump(); }
  if (b.dataset.act === 'cancel') {
    u.tus?.abort(true).catch(() => {});
    uploads.splice(uploads.indexOf(u), 1);
    renderUploads();
    pump();
    announce(`Cancelled ${u.file.name}.`);
  }
}
$('#uploadGrid').addEventListener('click', onUploadAction);
$('#projUploads').addEventListener('click', onUploadAction);

// A poster frame straight from the local file, so the card has a picture while it uploads.
let posterChain = Promise.resolve();
function makePoster(u) {
  posterChain = posterChain.then(() => new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(u.file);
    const done = () => { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(); };
    const timer = setTimeout(done, 4000);
    v.muted = true;
    v.preload = 'metadata';
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 3); };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = Math.round((320 * v.videoHeight) / v.videoWidth) || 180;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        u.poster = c.toDataURL('image/jpeg', 0.7);
        if (uploads.includes(u)) renderUploads();
      } catch {}
      clearTimeout(timer);
      done();
    };
    v.onerror = () => { clearTimeout(timer); done(); };
    v.src = url;
  }));
}

window.addEventListener('beforeunload', (e) => {
  if (uploads.some((u) => u.status === 'uploading' || u.status === 'queued' || u.status === 'finishing')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/** Uploads interrupted by a closed tab/crash: tus remembers them, so dropping the same file resumes it. */
async function showInterrupted() {
  const list = await (window.tus?.defaultOptions?.urlStorage?.findAllUploads?.() || Promise.resolve([])).catch(() => []);
  const fresh = list.filter((x) => Date.now() - new Date(x.creationTime).getTime() < 7 * 24 * 3600_000);
  const names = [...new Set(fresh.map((x) => x.metadata?.filename).filter(Boolean))];
  const note = $('#resumeNote');
  note.classList.toggle('hidden', !names.length);
  if (!names.length) return;
  note.innerHTML = `<strong>${plural(names.length, 'upload')} didn't finish:</strong> ${names.map(esc).join(', ')}.<br />
    <span style="color:var(--muted)">Drop or pick the same file${names.length > 1 ? 's' : ''} again and ${names.length > 1 ? 'they' : 'it'} will continue from where ${names.length > 1 ? 'they' : 'it'} stopped.</span>
    <button class="btn xs ghost" type="button" id="forgetUploads" style="margin-left:8px">Forget</button>`;
  $('#forgetUploads').onclick = async () => {
    for (const x of list) await tus.defaultOptions.urlStorage.removeUpload(x.urlStorageKey);
    note.classList.add('hidden');
  };
}

// ---- file pickers + drag & drop anywhere ---------------------------------------
let pickTarget = null;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick-files]');
  if (!b) return;
  pickTarget = b.hasAttribute('data-to-project') ? state.jobId : null;
  $('#fileInput').click();
});
$('#fileInput').addEventListener('change', () => {
  addFiles($('#fileInput').files, pickTarget);
  $('#fileInput').value = '';
});

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#dropHint').textContent = state.view === 'project' ? `Saved to your library and added to “${state.project?.name || 'this project'}”` : 'Videos go to your library — any size';
  $('#dropveil').classList.add('on');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('#dropveil').classList.remove('on'); }
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropveil').classList.remove('on');
  const target = state.view === 'project' ? state.jobId : null;
  addFiles(await filesFromDrop(e.dataTransfer), target);
});

// ---------------------------------------------------------------------------
// Preview player
// ---------------------------------------------------------------------------
const viewer = { assetId: null, clip: null, opener: null, waiting: false };
const dlg = $('#viewer');

function openAsset(id, opener) {
  const a = state.assets.find((x) => x.id === id);
  if (!a) return;
  Object.assign(viewer, { assetId: id, clip: null, opener });
  refreshViewer(a, true);
  dlg.showModal();
}
function openClip(clip, opener) {
  const a = clip.assetId && state.assets.find((x) => x.id === clip.assetId);
  if (a) {
    openAsset(a.id, opener);
    viewer.clip = clip;
    renderViewerActions(a);
    return;
  }
  Object.assign(viewer, { assetId: null, clip, opener });
  $('#vTitle').textContent = clip.name;
  setPlayer(clip.streamUrl, clip.thumbnail);
  $('#vFacts').innerHTML = facts([['Duration', fmtTime(clip.duration)], ['Resolution', `${clip.width}×${clip.height}`], ['Size', fmtSize(clip.size)]]);
  renderViewerActions(null);
  dlg.showModal();
}
const facts = (rows) => rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

function setPlayer(url, poster, waitMsg, audio = false) {
  const box = $('#vPlayer');
  viewer.waiting = !url;
  if (audio && url) {
    box.innerHTML = `<div style="width:100%"><img src="${esc(poster)}" alt="" style="width:100%;max-height:220px;object-fit:contain" /><audio controls preload="metadata" src="${esc(url)}" style="width:100%;margin-top:8px"></audio></div>`;
    return;
  }
  if (!url) {
    box.innerHTML = `<div class="wait" role="status">${esc(waitMsg || 'Preview not available.')}</div>`;
    return;
  }
  box.innerHTML = `<video controls playsinline preload="metadata" ${poster ? `poster="${esc(poster)}"` : ''}></video>`;
  const v = $('video', box);
  v.onerror = () => {
    box.innerHTML = '<div class="wait" role="status">This browser can\'t play this video. Download it to watch, or open ClipForge in Chrome, Safari or Edge.</div>';
  };
  v.src = url;
}

function refreshViewer(a, first = false) {
  $('#vTitle').textContent = a.name;
  if (a.kind === 'audio') {
    if (first) setPlayer(a.streamUrl, a.thumbnail, '', true);
  } else if (first || (viewer.waiting && a.streamUrl)) {
    const wait = a.preview.proxy === 'failed'
      ? "Couldn't make a browser preview of this file. It can still be used in edits — download it to watch."
      : `Making a browser-friendly preview (${a.preview.proxyReason})… ${Math.round((a.preview.progress || 0) * 100)}%`;
    setPlayer(a.streamUrl, a.thumbnail, wait);
  } else if (viewer.waiting) {
    $('#vPlayer .wait').textContent = `Making a browser-friendly preview (${a.preview.proxyReason})… ${Math.round((a.preview.progress || 0) * 100)}%`;
  }
  $('#vFacts').innerHTML = facts(a.kind === 'audio'
    ? [['Duration', fmtTime(a.duration)], ['Title', a.tags.title || '—'], ['Artist', a.tags.artist || '—'], ['Genre', a.tags.genre || '—'], ['File size', fmtSize(a.size)], ['Added', new Date(a.createdAt).toLocaleString()]]
    : [
      ['Duration', fmtTime(a.duration)],
      ['Resolution', `${a.width}×${a.height}`],
      ['File size', fmtSize(a.size)],
      ['Video', codec(a.videoCodec)],
      ['Audio', a.hasAudio ? codec(a.audioCodec) : 'None'],
      ['Added', new Date(a.createdAt).toLocaleString()],
      ...(a.source ? [['Imported from', a.source.path.split('/').slice(-2).join('/')]] : []),
      ...(a.shrunk ? [['Original', `${a.shrunk.width}×${a.shrunk.height}, ${fmtSize(a.shrunk.size)} — shrunk to save space`]] : []),
    ]);
  renderViewerAI(a);
  if (first) renderViewerActions(a);
}

function renderViewerAI(a) {
  const box = $('#vAI');
  if (!a || a.kind === 'audio') { box.innerHTML = ''; return; }
  const ai = a.ai;
  const head = '<h3><svg aria-hidden="true"><use href="#i-spark"/></svg>What Claude sees</h3>';
  if (ai.status === 'done') {
    box.innerHTML = `${head}<p style="margin:0">${esc(ai.summary)}</p>
      <div class="tagrow">${ai.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${ai.shot && ai.shot !== 'other' && !ai.tags.includes(ai.shot) ? `<span class="tag kind">${esc(ai.shot)}</span>` : ''}</div>
      ${ai.moments.length ? `<ul class="moments" aria-label="Best moments — jump to">${ai.moments.map((m) => `<li><button type="button" data-seek="${m.start}"><b>${fmtTime(m.start)}</b>${esc(m.what)}</button></li>`).join('')}</ul>` : ''}
      <div class="im-actions">${ai.quality ? `<span class="hint-line">Quality: ${esc(ai.quality)}</span>` : ''}<button class="btn xs ghost" type="button" data-rescan>Rescan</button></div>`;
  } else if (ai.status === 'queued' || ai.status === 'scanning') {
    box.innerHTML = `${head}<p class="hint-line" role="status" style="margin:0">${ai.status === 'scanning' ? 'Claude is looking at this video now…' : 'Waiting in line for Claude to look at it…'}</p>`;
  } else {
    box.innerHTML = `${head}<div class="im-actions"><span class="hint-line">${ai.status === 'error' ? esc(ai.error || 'Scan failed.') : 'Not scanned yet.'}</span><button class="btn xs" type="button" data-rescan>${ai.status === 'error' ? 'Try again' : 'Scan with Claude'}</button></div>`;
  }
}
$('#vAI').addEventListener('click', async (e) => {
  const seek = e.target.closest('[data-seek]');
  if (seek) {
    const v = $('#vPlayer video');
    if (v) { v.currentTime = Number(seek.dataset.seek); v.play().catch(() => {}); v.focus(); }
    return;
  }
  if (e.target.closest('[data-rescan]') && viewer.assetId) {
    try { await api('/api/library/scan', { method: 'POST', body: { ids: [viewer.assetId] } }); }
    catch (err) { toast(err.message, 'error'); }
  }
});

function renderViewerActions(a) {
  const box = $('#vActions');
  const inProject = viewer.clip && state.view === 'project';
  box.innerHTML = `
    ${a ? `<label class="sr-only" for="vName">Video name</label><input class="field" id="vName" value="${esc(a.name)}" maxlength="200" style="flex:1 1 220px" />
      <button class="btn sm ghost" type="button" data-v="rename">Rename</button>` : ''}
    <span class="spacer"></span>
    ${a && a.kind !== 'audio' && !inProject ? `<label class="sr-only" for="vProject">Project</label><select class="field" id="vProject">${projectOptions(state.jobId || store.get('clipforge:last'))}</select>
      <button class="btn sm" type="button" data-v="add">Add to project</button>` : ''}
    ${a ? `<a class="btn sm ghost" href="${esc(a.downloadUrl)}" download>Download original</a>` : ''}
    ${inProject ? `<button class="btn sm danger" type="button" data-v="unclip">Remove from project</button>` : ''}
    ${a && !inProject ? `<button class="btn sm danger" type="button" data-v="delete">Delete</button>` : ''}`;
}

$('#vActions').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-v]')?.dataset.v;
  if (!act) return;
  const a = state.assets.find((x) => x.id === viewer.assetId);
  try {
    if (act === 'rename') {
      const name = $('#vName').value.trim();
      if (!name || name === a.name) return;
      const { asset } = await api(`/api/library/${a.id}`, { method: 'PATCH', body: { name } });
      Object.assign(a, asset);
      $('#vTitle').textContent = asset.name;
      renderLibrary();
      if (state.clips.some((c) => c.assetId === a.id)) reloadClips();
      announce('Renamed.');
    } else if (act === 'add') {
      const projectId = await resolveProject($('#vProject').value);
      await api(`/api/projects/${projectId}/clips`, { method: 'POST', body: { assetIds: [a.id] } });
      dlg.close();
      toast(`Added ${a.name} to the project.`, 'ok');
      location.hash = `#/project/${projectId}`;
    } else if (act === 'delete') {
      if (!confirm(`Permanently delete ${a.name}? It will also be removed from any project using it.`)) return;
      await api(`/api/library/${a.id}`, { method: 'DELETE' });
      dlg.close();
      state.assets = state.assets.filter((x) => x.id !== a.id);
      renderLibrary();
      loadProjects();
      announce('Deleted.');
    } else if (act === 'unclip') {
      dlg.close();
      await removeClip(viewer.clip.id);
    }
  } catch (err) { toast(err.message, 'error'); }
});

for (const d of [dlg, $('#picker'), $('#importDlg')]) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
}
dlg.addEventListener('close', () => {
  const v = $('#vPlayer video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); } // stop streaming a huge file in the background
  viewer.assetId = null;
  viewer.clip = null;
  viewer.opener?.isConnected && viewer.opener.focus();
});

// ---------------------------------------------------------------------------
// Library picker (from a project)
// ---------------------------------------------------------------------------
const pickSel = new Set();
function renderPicker() {
  const list = visibleAssets($('#pkSearch').value, 'new', 'video');
  $('#pkGrid').innerHTML = list.length ? list.map((a) => `
    <li class="asset${pickSel.has(a.id) ? ' selected' : ''}" data-id="${a.id}">
      <label style="cursor:pointer;display:block">
        ${thumbHtml(a, { status: assetStatus(a) })}
        <span class="info" style="display:flex;gap:8px;align-items:flex-start">
          <input type="checkbox" ${pickSel.has(a.id) ? 'checked' : ''} style="margin-top:3px;accent-color:var(--accent)" />
          <span style="min-width:0"><span class="name" style="display:block">${esc(a.name)}</span><span class="sub" style="display:block">${esc(assetSub(a))}</span>${aiHtml(a)}</span>
        </span>
      </label>
    </li>`).join('')
    : `<li class="empty" style="grid-column:1/-1">${state.assets.length ? 'No videos match.' : 'Your library is empty — upload some videos first.'}</li>`;
  $('#pkCount').textContent = pickSel.size ? `${plural(pickSel.size, 'video')} selected` : 'Pick one or more videos.';
  $('#pkAdd').disabled = !pickSel.size;
  $('#pkAdd').textContent = pickSel.size > 1 ? `Add ${pickSel.size} clips` : 'Add clip';
}
$('#addFromLib').addEventListener('click', () => {
  pickSel.clear();
  $('#pkSearch').value = '';
  renderPicker();
  $('#picker').showModal();
});
$('#pkSearch').addEventListener('input', renderPicker);
$('#pkGrid').addEventListener('change', (e) => {
  const id = e.target.closest('.asset')?.dataset.id;
  if (!id) return;
  e.target.checked ? pickSel.add(id) : pickSel.delete(id);
  e.target.closest('.asset').classList.toggle('selected', e.target.checked);
  $('#pkCount').textContent = pickSel.size ? `${plural(pickSel.size, 'video')} selected` : 'Pick one or more videos.';
  $('#pkAdd').disabled = !pickSel.size;
  $('#pkAdd').textContent = pickSel.size > 1 ? `Add ${pickSel.size} clips` : 'Add clip';
});
$('#pkAdd').addEventListener('click', async () => {
  const ids = visibleAssets('', 'new').map((a) => a.id).filter((id) => pickSel.has(id)).reverse(); // oldest first
  try {
    const data = await api(`/api/projects/${state.jobId}/clips`, { method: 'POST', body: { assetIds: ids } });
    $('#picker').close();
    state.clips = data.clips;
    renderClips();
    loadProjects();
    announce(`Added ${plural(ids.length, 'clip')}.`);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------------------------------------------------------------------------
// Projects + routing
// ---------------------------------------------------------------------------
async function loadProjects() {
  try {
    state.projects = (await api('/api/projects')).projects;
  } catch { return; }
  renderProjects();
}
function renderProjects() {
  const ul = $('#projectList');
  ul.innerHTML = state.projects.length ? state.projects.map((p) => `
    <li><a class="proj-link" href="#/project/${esc(p.id)}" ${p.id === state.jobId && state.view === 'project' ? 'aria-current="page"' : ''}>
      <span class="pt" aria-hidden="true" ${p.thumbnail ? `style="background-image:url('${esc(p.thumbnail)}')"` : ''}></span>
      <span style="min-width:0"><span class="pn" style="display:block">${esc(p.name)}</span>
        <span class="pm">${p.state === 'running' ? '<span class="live" aria-hidden="true"></span>Rendering' : `${plural(p.clips, 'clip')}${p.videos ? ` · ${plural(p.videos, 'video')}` : ''}`}</span></span>
    </a></li>`).join('') : '<li class="empty-note">No projects yet.</li>';
  if (state.selected.size) renderSelbar();
}

$('#newProject').addEventListener('click', async () => {
  try {
    const { project } = await api('/api/projects', { method: 'POST', body: {} });
    await loadProjects();
    location.hash = `#/project/${project.id}`;
    setTimeout(() => $('#projName').focus(), 50);
  } catch (err) { toast(err.message, 'error'); }
});

function setView(view) {
  state.view = view;
  $('#libraryView').classList.toggle('hidden', view !== 'library');
  $('#projectView').classList.toggle('hidden', view !== 'project');
  $('#autoView').classList.toggle('hidden', view !== 'autopilot');
  for (const [id, v] of [['#navLibrary', 'library'], ['#navAuto', 'autopilot']]) {
    if (view === v) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  document.body.classList.remove('nav-open');
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  renderProjects();
}

let firstRoute = true;
async function route() {
  const m = location.hash.match(/^#\/project\/([\w-]+)$/);
  if (m) {
    await openProject(m[1]);
  } else if (location.hash === '#/autopilot') {
    state.es?.close();
    state.jobId = null;
    setView('autopilot');
    document.title = 'Autopilot · ClipForge';
    store.set('clipforge:route', 'autopilot');
    loadAutopilot();
  } else {
    state.es?.close();
    state.jobId = null;
    setView('library');
    document.title = 'Library · ClipForge';
    store.set('clipforge:route', 'library');
  }
  if (!firstRoute) $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
  firstRoute = false;
}
window.addEventListener('hashchange', route);

$('#menuBtn').addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  $('#menuBtn').setAttribute('aria-expanded', String(open));
  if (open) $('#sidebar a, #sidebar button')?.focus();
});
$('#scrim').addEventListener('click', () => { document.body.classList.remove('nav-open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); $('#menuBtn').focus(); }
});

// ---------------------------------------------------------------------------
// Project view
// ---------------------------------------------------------------------------
async function openProject(id) {
  let data;
  try {
    data = await api(`/api/clips/${id}`);
  } catch (err) {
    if (err.status === 404) toast('That project no longer exists.', 'error');
    location.hash = '#/library';
    return;
  }
  const switching = state.jobId !== id;
  state.jobId = id;
  state.project = data.project;
  state.clips = data.clips;
  store.set('clipforge:last', id);
  store.set('clipforge:route', 'project');
  setView('project');
  document.title = `${data.project.name} · ClipForge`;
  $('#projH1').textContent = `Project: ${data.project.name}`;
  $('#projName').value = data.project.name === 'Untitled project' ? '' : data.project.name;
  if (switching) {
    state.shown = null;
    state.lastState = null;
    ['#progressCard', '#resultCard', '#checkCard'].forEach((c) => $(c).classList.add('hidden'));
    applySaved(store.get(`clipforge:proj:${id}`) || { settings: store.get('clipforge:defaults') || {} });
  }
  renderClips();
  renderUploads();
  showLogo(data.logo);
  showStatus(data.state);
  subscribe();
  loadStorage();
}

async function reloadClips() {
  if (!state.jobId) return;
  try {
    const data = await api(`/api/clips/${state.jobId}`);
    state.clips = data.clips;
    state.project = data.project;
    renderClips();
  } catch {}
}

$('#projName').addEventListener('change', async () => {
  try {
    const { project } = await api(`/api/projects/${state.jobId}`, { method: 'PATCH', body: { name: $('#projName').value } });
    state.project = project;
    document.title = `${project.name} · ClipForge`;
    $('#projH1').textContent = `Project: ${project.name}`;
    loadProjects();
    announce('Project renamed.');
  } catch (err) { toast(err.message, 'error'); }
});
$('#projName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

function renderClips() {
  const total = state.clips.reduce((s, c) => s + (c.duration || 0), 0);
  $('#clipMeta').textContent = state.clips.length ? `${plural(state.clips.length, 'clip')} · ${fmtTime(total)} total` : '';
  const n = state.clips.length;
  $('#clipStrip').innerHTML = state.clips.map((c, i) => `
    <li draggable="true" data-id="${esc(c.id)}">
      <span class="num" aria-hidden="true" title="Drag to reorder">${i + 1}</span>
      ${thumbHtml(c, { previewLabel: `Preview ${c.name}` })}
      <div style="min-width:0"><div class="name" title="${esc(c.name)}">${esc(c.name)}</div>
        <div class="sub">${fmtTime(c.duration)} · ${c.width}×${c.height}${c.hasAudio ? '' : ' · no audio'}</div>
        ${c.auto ? `<div class="why">✦ Picked by Claude${c.why ? `: ${esc(c.why)}` : ''}</div>` : ''}</div>
      <div class="acts">
        <button class="icon-btn" type="button" data-move="-1" aria-label="Move ${esc(c.name)} earlier" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-up"/></svg></button>
        <button class="icon-btn" type="button" data-move="1" aria-label="Move ${esc(c.name)} later" ${i === n - 1 ? 'disabled' : ''}><svg><use href="#i-down"/></svg></button>
        <button class="icon-btn" type="button" data-remove aria-label="Remove ${esc(c.name)} from project"><svg><use href="#i-x"/></svg></button>
      </div>
    </li>`).join('');
  if (!n) $('#clipStrip').innerHTML = `<li style="display:block;text-align:center;color:var(--muted);padding:18px">${$('#autoFind').checked ? 'Claude will pick clips from your library when you hit Forge.' : 'No clips yet — upload videos, add some from your library, or let Claude find them.'}</li>`;
  updateGo();
}

function renderClipsEmpty() {
  const li = $('#clipStrip li:not([data-id])');
  if (li) li.textContent = $('#autoFind').checked ? 'Claude will pick clips from your library when you hit Forge.' : 'No clips yet — upload videos, add some from your library, or let Claude find them.';
}

async function saveOrder(ids, focusSel) {
  const before = state.clips;
  state.clips = ids.map((id) => before.find((c) => c.id === id));
  renderClips();
  if (focusSel) $(focusSel)?.focus();
  try {
    state.clips = (await api(`/api/projects/${state.jobId}/order`, { method: 'PUT', body: { clipIds: ids } })).clips;
  } catch (err) {
    state.clips = before;
    renderClips();
    toast(err.message, 'error');
  }
}

async function removeClip(id) {
  try {
    const data = await api(`/api/clips/${state.jobId}/${id}`, { method: 'DELETE' });
    state.clips = data.clips;
    renderClips();
    loadProjects();
    announce('Clip removed from the project. It is still in your library.');
  } catch (err) { toast(err.message, 'error'); }
}

$('#clipStrip').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('[data-preview]')) return openClip(state.clips.find((c) => c.id === id), e.target.closest('[data-preview]'));
  if (e.target.closest('[data-remove]')) return removeClip(id);
  const mv = e.target.closest('[data-move]');
  if (mv) {
    const ids = state.clips.map((c) => c.id);
    const i = ids.indexOf(id), j = i + Number(mv.dataset.move);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    // Keep focus on the same button of the moved clip (or its other arrow at the ends).
    const dir = mv.dataset.move;
    const sel = `#clipStrip li[data-id="${id}"] [data-move="${(j === 0 && dir === '-1') || (j === ids.length - 1 && dir === '1') ? -dir : dir}"]`;
    saveOrder(ids, sel);
    announce(`Moved to position ${j + 1} of ${ids.length}.`);
  }
});

// Drag to reorder
let dragId = null;
$('#clipStrip').addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  dragId = li.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  li.classList.add('dragging');
});
$('#clipStrip').addEventListener('dragend', () => {
  dragId = null;
  $$('#clipStrip li').forEach((l) => l.classList.remove('dragging', 'drop-before'));
});
$('#clipStrip').addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  $$('#clipStrip li').forEach((l) => l.classList.remove('drop-before'));
  e.target.closest('li[data-id]')?.classList.add('drop-before');
});
$('#clipStrip').addEventListener('drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.stopPropagation();
  const target = e.target.closest('li[data-id]')?.dataset.id;
  const ids = state.clips.map((c) => c.id).filter((x) => x !== dragId);
  const at = target && target !== dragId ? ids.indexOf(target) : ids.length;
  ids.splice(at, 0, dragId);
  saveOrder(ids);
});

// ---- prompt + settings ------------------------------------------------------------
$$('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (seg.hasAttribute('data-single')) {
      $$('button', seg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    } else {
      const on = b.getAttribute('aria-pressed') !== 'true';
      if (!on && $$('button[aria-pressed="true"]', seg).length === 1) return; // keep at least one
      b.setAttribute('aria-pressed', String(on));
    }
    onOptionsChange();
  });
});
$$('.seg button').forEach((b) => b.hasAttribute('aria-pressed') || b.setAttribute('aria-pressed', 'false'));
const segValue = (name) => $$(`.seg[data-name="${name}"] button[aria-pressed="true"]`).map((b) => b.dataset.v);
const setSeg = (name, values) => {
  const vals = [].concat(values);
  const btns = $$(`.seg[data-name="${name}"] button`);
  if (!btns.some((b) => vals.includes(b.dataset.v))) return;
  btns.forEach((b) => b.setAttribute('aria-pressed', String(vals.includes(b.dataset.v))));
};

function readSettings() {
  return {
    goal: segValue('goal')[0],
    formats: segValue('formats'),
    lengths: segValue('lengths'),
    captions: segValue('captions')[0],
    framing: segValue('framing')[0],
    size: segValue('size')[0],
    brand: $('#brand').value.trim(),
    cta: $('#cta').value.trim(),
    accent: $('#accent').value,
    whisperModel: $('#whisperModel').value,
    engine: $('#engine').value,
    plannerModel: $('#plannerModel').value,
    silence: $('#silence').checked,
    shots: $('#shots').checked,
    cleanVoice: $('#cleanVoice').checked,
    ...Object.fromEntries(PRO_TOGGLES.map((k) => [k, $('#' + k).checked])),
    watermark: $('#watermark').checked,
    useLogo: true,
    autoFind: $('#autoFind').checked,
    music: $('#music').value || 'auto',
    voiceover: $('#voiceover').value,
    voice: $('#voice').value,
    musicLevel: segValue('musicLevel')[0],
  };
}
/** "Pro finishing" switches (all on by default); each maps 1:1 to a server setting. */
const PRO_TOGGLES = $$('#proToggles input[type=checkbox]').map((el) => el.id);
function applySaved(saved) {
  $('#prompt').value = saved.prompt || '';
  const s = saved.settings || {};
  for (const k of ['goal', 'formats', 'lengths', 'captions', 'framing', 'size', 'musicLevel']) if (s[k]) setSeg(k, s[k]);
  $('#autoFind').checked = s.autoFind === true;
  state.musicWanted = s.music || 'auto';
  renderMusicSelect();
  for (const k of ['brand', 'cta', 'accent', 'whisperModel', 'engine', 'plannerModel', 'voiceover', 'voice']) if (s[k]) $('#' + k).value = s[k];
  for (const k of ['silence', 'shots', 'cleanVoice', 'watermark', ...PRO_TOGGLES]) {
    const el = $('#' + k);
    if (typeof s[k] === 'boolean' && !el.disabled) el.checked = s[k];
  }
  onOptionsChange();
}
function remember() {
  if (!state.jobId) return;
  const settings = readSettings();
  store.set(`clipforge:proj:${state.jobId}`, { prompt: $('#prompt').value, settings });
  store.set('clipforge:defaults', settings);
}

function onOptionsChange() {
  const s = readSettings();
  const n = s.formats.length * s.lengths.length;
  $('#outMeta').textContent = plural(n, 'video');
  $('#outMeta').style.color = n > 8 ? 'var(--err)' : '';
  $('#cta').placeholder = s.goal === 'social' ? 'Call to action (optional)' : 'Call to action, e.g. Shop now';
  updateGo();
  remember();
}
['#brand', '#cta', '#accent', '#whisperModel', '#engine', '#plannerModel', '#voiceover', '#voice', '#silence', '#shots', '#cleanVoice', '#watermark', '#logoCutout', ...PRO_TOGGLES.map((k) => '#' + k)]
  .forEach((sel) => $(sel).addEventListener('input', remember));
$('#autoFind').addEventListener('change', () => { updateGo(); remember(); });
$('#music').addEventListener('change', () => { state.musicWanted = $('#music').value; renderMusicSelect(); remember(); });

/** Music choices: off, let Claude pick, or a specific track from the library. */
function renderMusicSelect() {
  const sel = $('#music');
  if (!sel) return;
  const tracks = state.assets.filter((a) => a.kind === 'audio' && a.status === 'ready');
  const want = state.musicWanted || sel.value || 'auto';
  sel.innerHTML = `<option value="auto">Claude picks from my music (${tracks.length})</option><option value="off">No music</option>` +
    (tracks.length ? `<optgroup label="Use this track">${tracks.map((a) => `<option value="${a.id}">${esc(assetTitle(a))}${a.tags.artist ? ` — ${esc(a.tags.artist)}` : ''} (${fmtTime(a.duration)})</option>`).join('')}</optgroup>` : '');
  sel.value = [...sel.options].some((o) => o.value === want) ? want : 'auto';
  $('#musicHint').textContent = sel.value === 'auto' && !tracks.length
    ? 'Your library has no music yet — drop MP3/WAV files on the Library page (or import a Drive folder with music).'
    : sel.value !== 'off' ? 'Music is lowered automatically whenever someone speaks.' : '';
}

$('#chips').addEventListener('click', (e) => {
  if (!e.target.classList.contains('chip')) return;
  const p = $('#prompt');
  p.value = p.value.trim() ? `${p.value.trim()}\n${e.target.textContent}` : e.target.textContent;
  updateGo();
  remember();
  announce('Added to the prompt.');
});
$('#prompt').addEventListener('input', () => { updateGo(); remember(); });

function updateGo() {
  const s = readSettings();
  const n = s.formats.length * s.lengths.length;
  const pending = uploads.some((u) => u.projectId === state.jobId);
  const hasFootage = state.clips.length > 0 || s.autoFind;
  const ready = hasFootage && $('#prompt').value.trim().length > 0 && n <= 8;
  $('#go').disabled = !ready || state.running;
  $('#go').textContent = n > 1 ? `Forge ${n} videos` : 'Forge video';
  $('#rerender').classList.toggle('hidden', !state.shown || state.running);
  if (!state.clips.length) renderClipsEmpty();
  $('#rerender').disabled = n > 8;
  $('#goHint').textContent = state.running ? 'Working — you can leave this page and come back later.'
    : n > 8 ? 'Pick at most 8 format × length combinations.'
    : !hasFootage ? (pending ? 'Waiting for uploads to finish…' : 'Add a clip, or let Claude find them.')
    : !ready ? 'Describe the edit you want.' : '';
}

// ---- run ---------------------------------------------------------------------------
async function start(reusePlan) {
  $('#go').disabled = true;
  try {
    await api('/api/edit', {
      method: 'POST',
      body: { jobId: state.jobId, prompt: $('#prompt').value, clips: state.clips.map((c) => c.id), settings: readSettings(), reusePlan },
    });
    subscribe();
    loadProjects();
    announce('Started.');
  } catch (err) {
    toast(err.message, 'error');
    updateGo();
  }
}
$('#go').addEventListener('click', () => start(false));
$('#rerender').addEventListener('click', () => start(true));
$('#cancel').addEventListener('click', () => fetch(`/api/cancel/${state.jobId}`, { method: 'POST' }));

function subscribe() {
  state.es?.close();
  if (!state.jobId) return;
  const id = state.jobId;
  state.es = new EventSource(`/api/status/${id}`);
  state.es.onmessage = (e) => { if (state.jobId === id) showStatus(JSON.parse(e.data)); };
}

const STEP_NAMES = { find: 'Footage search', transcribe: 'Transcription', plan: 'Planning', render: 'Rendering' };
function showStatus(s) {
  const prev = state.lastState;
  state.lastState = s.state;
  state.running = s.state === 'running';
  if (prev && prev !== s.state) {
    loadProjects();
    if (s.state === 'done') announce(`Finished — ${plural(s.result?.variants?.length || 0, 'video')} ready.`);
  }
  updateGo();
  $('#cancel').classList.toggle('hidden', !state.running);
  $('#idleCard').classList.toggle('hidden', s.state !== 'idle');
  $('#progressCard').classList.toggle('hidden', s.state !== 'running' && s.state !== 'error');
  const badge = $('#stateBadge');
  badge.className = `state-badge ${s.state}`;
  badge.textContent = { idle: 'Not rendered yet', running: `Rendering ${Math.round((s.progress || 0) * 100)}%`, done: 'Rendered', error: 'Failed' }[s.state] || s.state;
  if (s.state === 'idle') return;

  for (const [name, st] of Object.entries(s.steps)) {
    const el = $(`.step[data-step="${name}"]`);
    if (!el) continue;
    el.className = `step ${st.status}${st.status === 'skipped' ? ' hidden' : ''}`;
    if (name === 'find' && st.status === 'done' && state.steps.find && state.steps.find !== 'done') reloadClips(); // show what Claude picked
    $('.m', el).textContent = st.message || '';
    if (state.running && state.steps[name] && state.steps[name] !== st.status && st.status === 'done') announce(`${STEP_NAMES[name]} done.`);
    state.steps[name] = st.status;
  }
  const pct = Math.round((s.progress || 0) * 100);
  $('#bar').style.width = `${pct}%`;
  $('#barWrap').setAttribute('aria-valuenow', pct);

  $('#error').classList.toggle('hidden', s.state !== 'error');
  if (s.state === 'error' && s.error) {
    $('#errMsg').textContent = s.error.message;
    $('#errHint').textContent = s.error.hint || '';
    $('#errDetailWrap').classList.toggle('hidden', !s.error.detail);
    $('#errDetail').textContent = s.error.detail || '';
  }
  if (state.running) {
    ['#resultCard', '#checkCard'].forEach((c) => $(c).classList.add('hidden'));
    state.shown = null;
  }
  if (s.state === 'done' && s.result) showResult(s.result);
}

const canShareFiles = (() => {
  try { return Boolean(navigator.canShare?.({ files: [new File([''], 'x.mp4', { type: 'video/mp4' })] })); } catch { return false; }
})();

async function showResult(r) {
  const key = r.variants.map((v) => v.previewUrl).join('|');
  if (state.shown === key) return;
  state.shown = key;
  $('#resultCard').classList.remove('hidden');
  $('#resultTitle').textContent = r.title || 'Videos';
  $('#resultMeta').textContent = `${plural(r.variants.length, 'video')} · ${fmtSize(r.totalSize)}${r.music ? ` · ♪ ${r.music.name}` : ''}`;
  $('#variants').innerHTML = r.variants.map((v) => {
    const label = `${v.length === 'full' ? 'Full' : v.length + 's'} · ${FORMAT_LABEL[v.format] || v.format}`;
    return `<div class="variant">
      <div class="frame"><video src="${v.previewUrl}" poster="${v.posterUrl || ''}" controls playsinline preload="none" style="aspect-ratio:${v.width}/${v.height}" aria-label="${esc(label)} preview"></video></div>
      <div class="vm">
        <div><div class="vl">${esc(label)}</div><div class="vs">${fmtTime(v.duration)} · ${fmtSize(v.size)}</div></div>
        ${canShareFiles ? `<button class="btn sm ghost share" type="button" data-url="${v.downloadUrl}" data-name="${esc(v.file)}">Share</button>` : ''}
        ${v.srtUrl ? `<a class="btn sm ghost" href="${v.srtUrl}" download title="Closed captions (.srt) — upload them on YouTube/TikTok/Facebook" aria-label="Download subtitles for ${esc(label)}">CC</a>` : ''}
        <a class="btn sm" href="${v.downloadUrl}" download aria-label="Download ${esc(label)}">↓</a>
      </div>
    </div>`;
  }).join('');
  $('#warns').innerHTML = (r.warnings || []).map((w) => `⚠ ${esc(w)}`).join('<br>');
  const rv = r.review;
  $('#review').classList.toggle('hidden', !rv);
  if (rv) {
    const cls = rv.score >= 8 ? 'good' : rv.score >= 6 ? 'ok' : 'bad';
    $('#review').innerHTML = `<div class="score ${cls}">Claude's review: <b>${rv.score}/10</b> <span>${esc(rv.summary)}</span></div>
      <div class="bars">${['hook', 'clarity', 'visuals', 'pacing', 'brief'].map((k) => `<span>${k} ${rv[k]}/10</span>`).join('')}${rv.measures?.lufs != null ? `<span>loudness ${rv.measures.lufs} LUFS</span>` : ''}</div>
      ${rv.issues?.length ? `<ul>${rv.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`;
  }
  $('#checkCard').classList.toggle('hidden', !r.checklist?.length);
  $('#checklist').innerHTML = (r.checklist || []).map((c) =>
    `<li><div><div class="rq">${esc(c.request)}</div><div class="dn">${esc(c.done)}</div></div></li>`).join('');
  updateGo();
  try { $('#planJson').textContent = JSON.stringify(await (await fetch(`/api/plan/${state.jobId}`)).json(), null, 2); } catch {}
  loadStorage();
}

$('#variants').addEventListener('click', async (e) => {
  const b = e.target.closest('.share');
  if (!b) return;
  const old = b.textContent;
  b.textContent = '…';
  try {
    const blob = await (await fetch(b.dataset.url)).blob();
    await navigator.share({ files: [new File([blob], b.dataset.name, { type: 'video/mp4' })] });
  } catch (err) {
    if (err.name !== 'AbortError') toast('Sharing failed — use the download button instead.', 'error');
  } finally { b.textContent = old; }
});

// ---- logo ------------------------------------------------------------------------
function showLogo(logo) {
  $('#logoPrev').classList.toggle('hidden', !logo);
  $('#logoRm').classList.toggle('hidden', !logo);
  if (logo) $('#logoPrev').src = logo.url;
  $('#logoBtn').textContent = logo ? 'Replace logo' : 'Upload logo / product image';
  $('#logoNote').textContent = logo?.note || (logo?.cutout ? 'Background removed with rembg.' : '');
}
$('#logoBtn').addEventListener('click', () => $('#logoFile').click());
$('#logoFile').addEventListener('change', async () => {
  const f = $('#logoFile').files[0];
  $('#logoFile').value = '';
  if (!f) return;
  const fd = new FormData();
  fd.append('logo', f, f.name);
  const q = new URLSearchParams({ cutout: $('#logoCutout').checked ? '1' : '0', jobId: state.jobId });
  $('#logoBtn').disabled = true;
  $('#logoBtn').textContent = $('#logoCutout').checked ? 'Removing background…' : 'Uploading…';
  try {
    const r = await fetch('/api/logo?' + q, { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    showLogo(data.logo);
  } catch (err) { toast(err.message || 'Logo upload failed.', 'error'); showLogo(null); }
  finally { $('#logoBtn').disabled = false; }
});
$('#logoRm').addEventListener('click', async () => {
  await fetch(`/api/logo/${state.jobId}`, { method: 'DELETE' });
  showLogo(null);
});

// ---- storage + delete --------------------------------------------------------------
async function loadStorage() {
  if (!state.jobId) return;
  try {
    const s = await api(`/api/storage?jobId=${state.jobId}`);
    $('#storageText').textContent = `Project files: ${fmtSize(s.project || 0)}. Deleting the project keeps its videos in your library.`;
  } catch {}
}
$('#deleteProject').addEventListener('click', async () => {
  const name = state.project?.name || 'this project';
  if (!confirm(`Delete “${name}”? Its transcripts and rendered videos are removed — download anything you want to keep. Library videos stay.`)) return;
  try {
    await api(`/api/jobs/${state.jobId}`, { method: 'DELETE' });
    store.del(`clipforge:proj:${state.jobId}`);
    if (store.get('clipforge:last') === state.jobId) store.del('clipforge:last');
    state.es?.close();
    state.jobId = null;
    await loadProjects();
    toast(`Deleted “${name}”.`, 'ok');
    location.hash = '#/library';
    refreshStorageSoon();
  } catch (err) { toast(err.message, 'error'); }
});

// ---------------------------------------------------------------------------
// Health / tools
// ---------------------------------------------------------------------------
async function loadHealth() {
  try {
    const h = await api('/api/health');
    const tools = [['ffmpeg', 'FFmpeg'], ['whisper', 'Whisper'], ['claude', 'Claude'], ['hyperframes', 'HyperFrames']];
    $('#health').innerHTML = tools.map(([k, label]) =>
      `<span role="listitem" class="pill ${h[k] ? '' : 'bad'}" title="${h[k] ? 'ready' : 'not found — run scripts/setup.sh'}">${label}<span class="sr-only">: ${h[k] ? 'ready' : 'not installed'}</span></span>`).join('');
    const t = h.tools || {};
    $('#tools').innerHTML = Object.values(t).map((x) =>
      `<li><span aria-hidden="true" style="color:${x.installed ? 'var(--ok)' : 'var(--muted)'}">${x.installed ? '●' : '○'}</span>
       <span><a href="${x.url}" target="_blank" rel="noopener">${esc(x.name)}</a>${x.installed ? '' : ' <span class="d">(not installed)</span>'}<br><span class="d">${esc(x.does)}</span></span></li>`).join('');
    for (const el of $$('.tg[data-tool]')) {
      const tool = t[el.dataset.tool];
      if (!tool || tool.installed) continue;
      const small = $('small', el);
      if (el.dataset.tool === 'autoEditor') { small.textContent += ' — auto-editor not installed, using FFmpeg'; continue; }
      el.classList.add('off');
      $('input', el).checked = false;
      $('input', el).disabled = true;
      small.innerHTML += ' — <span class="miss">not installed</span>';
    }
    $('#rembgMiss').classList.toggle('hidden', Boolean(t.rembg?.installed));
  } catch { /* server down — the next action will say so */ }
}

// ---------------------------------------------------------------------------
// Login (only when the server has CLIPFORGE_PASSWORD set)
// ---------------------------------------------------------------------------
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await nativeFetch(...args);
  if (r.status === 401) {
    const body = await r.clone().json().catch(() => ({}));
    if (body.auth) { $('#login').classList.remove('hidden'); $('#pw').focus(); }
  }
  return r;
};
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await nativeFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('#loginErr').textContent = data.error || 'Login failed.'; return; }
  $('#login').classList.add('hidden');
  $('#pw').value = '';
  init();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (matchMedia('(pointer: coarse)').matches) {
  $('#libDrop span').textContent = 'Tap to pick videos from your camera roll or files — any size. Uploads resume if the connection drops.';
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------------------------------------------------------------------------
// Version: show it, and pick up a self-update — reload once nothing is in progress.
// ---------------------------------------------------------------------------
let runningVersion = null;
let reloadPending = false;
async function checkVersion() {
  let v;
  try { v = await api('/api/version'); } catch { return; } // server restarting — try again next time
  $('#version').innerHTML = v.version
    ? `Version ${esc(v.version)}${v.enabled ? ` · updates automatically <button class="btn xs ghost" type="button" id="updateNow">Update now</button>` : ''}${v.error ? `<br>${esc(v.error)}` : ''}`
    : '';
  if (!v.version) return;
  if (!runningVersion) { runningVersion = v.version; return; }
  if (v.version === runningVersion || reloadPending) return;
  const busy = uploads.length > 0 || state.running || $('dialog[open]') || document.activeElement?.matches?.('textarea, input');
  if (!busy) return location.reload();
  reloadPending = true;
  toast('ClipForge was updated — reload the page when you’re ready to get the new version.', 'ok', 15000);
}
setInterval(checkVersion, 60_000);
document.addEventListener('click', async (e) => {
  const b = e.target.closest('#updateNow');
  if (!b) return;
  b.disabled = true;
  b.textContent = 'Checking…';
  try {
    const s = await api('/api/update', { method: 'POST', body: {} });
    if (s.status === 'idle' && !s.error) toast('You’re on the newest version.', 'ok');
    else if (s.error) toast(s.error, s.status === 'waiting' ? 'info' : 'error');
  } catch {
    toast('Updating — the page reloads in a moment.', 'ok'); // the server restarts mid-request
  }
  setTimeout(checkVersion, 4000);
});

/** One-time move of the old single-project localStorage entry. */
function migrate() {
  const old = store.get('clipforge');
  if (!old) return;
  if (old.jobId) {
    store.set(`clipforge:proj:${old.jobId}`, { prompt: old.prompt || '', settings: old.settings || {} });
    store.set('clipforge:last', old.jobId);
  }
  if (old.settings) store.set('clipforge:defaults', old.settings);
  store.del('clipforge');
}

let booted = false;
// ---------------------------------------------------------------------------
// Autopilot: batches of ready-to-post videos, planned and made every few days
// ---------------------------------------------------------------------------
const auto = { data: null, editing: false, shownKey: null };

async function loadAutopilot() {
  try { onAutopilot(await api('/api/autopilot')); } catch {}
}

function onAutopilot(d) {
  const prev = auto.data;
  auto.data = d;
  // A video that just finished → tell the user once.
  if (prev) {
    const before = new Map(prev.batches.flatMap((b) => b.ideas).map((i) => [i.id, i.status]));
    for (const i of d.batches.flatMap((b) => b.ideas)) {
      if (i.status === 'done' && before.has(i.id) && before.get(i.id) !== 'done') toast(`Autopilot made “${i.title}”.`, 'ok');
    }
  }
  const working = d.batches.some((b) => b.status === 'running');
  $('#autoBadge').textContent = working ? '●' : '';
  if (!auto.editing) fillAutoForm(d.settings);
  renderAutopilot();
}

function fillAutoForm(s) {
  $('#autoOn').checked = s.enabled;
  $('#autoEvery').value = String(s.everyDays);
  if (!$('#autoEvery').value) {
    $('#autoEvery').append(new Option(`${s.everyDays} days`, String(s.everyDays)));
    $('#autoEvery').value = String(s.everyDays);
  }
  $('#autoPer').value = String(s.perBatch);
  for (const c of $$('[name=autoLen]')) c.checked = s.lengths.includes(c.value);
  if (document.activeElement !== $('#autoDir')) $('#autoDir').value = s.direction;
  if (document.activeElement !== $('#autoBrand')) $('#autoBrand').value = s.brand;
  if (document.activeElement !== $('#autoCta')) $('#autoCta').value = s.cta;
  if (!$('#autoVoice').options.length) $('#autoVoice').innerHTML = $('#voice').innerHTML;
  $('#autoVoiceover').value = s.voiceover || 'auto';
  $('#autoVoice').value = s.voice || 'am_michael';
}

const whenText = (t) => {
  const d = new Date(t);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return days === 0 ? `today ${time}` : days === 1 ? `tomorrow ${time}` : days === -1 ? `yesterday ${time}` : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ` ${time}`;
};

function renderAutopilot() {
  const d = auto.data;
  if (!d) return;
  const s = d.settings;
  $('#autoRun').disabled = d.running;
  $('#autoCancel').classList.toggle('hidden', !d.running);
  $('#autoNext').textContent = d.running ? 'Making a batch right now — you can leave this page.'
    : !s.enabled ? 'Autopilot is off — use “Make a batch now”, or switch it on to get new videos every few days.'
      : d.nextRun ? `Next batch: ${d.nextRun <= Date.now() ? 'as soon as possible' : whenText(d.nextRun)}. It only runs while this codespace is switched on — if it was asleep, the batch starts as soon as it wakes up.`
        : 'First batch starts in a moment.';
  $('#autoProgress').classList.toggle('hidden', !d.running);
  if (d.running) {
    const ideas = d.batches.find((b) => b.status === 'running')?.ideas || [];
    const r = ideas.find((i) => i.status === 'rendering');
    const done = ideas.filter((i) => i.status === 'done' || i.status === 'error').length;
    const pct = ideas.length ? (done + (r?.progress || 0)) / ideas.length : 0.03;
    $('#autoProgress').innerHTML = `<strong>${esc(d.message || 'Working…')}</strong>
      ${r?.message ? `<div class="hint-line">${esc(r.message)}</div>` : ''}
      <div class="bar" role="progressbar" aria-label="Autopilot progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"><div style="width:${Math.max(3, pct * 100)}%"></div></div>`;
  }
  $('#autoEmpty').classList.toggle('hidden', d.batches.length > 0);

  // Re-render the batch list only when something visible changed (keeps playing videos playing).
  const key = JSON.stringify(d.batches.map((b) => [b.id, b.status, b.plan, b.error, b.ideas.map((i) => [i.id, i.status, i.file, i.error])]));
  if (key === auto.shownKey) return;
  auto.shownKey = key;
  $('#autoBatches').innerHTML = d.batches.map((b) => {
    const done = b.ideas.filter((i) => i.status === 'done').length;
    return `<section class="card batch" aria-labelledby="bh-${b.id}">
      <div class="card-h"><span id="bh-${b.id}">${esc(whenText(b.createdAt))}${b.auto ? '' : ' · made by hand'}</span>
        <span class="meta">${b.status === 'running' ? 'in progress' : `${plural(done, 'video')}`}</span>
        ${b.zipUrl ? `<a class="btn xs" href="${b.zipUrl}" download>↓ All (.zip)</a>` : ''}
        ${b.status !== 'running' ? `<button class="btn xs ghost" type="button" data-del-batch="${b.id}" aria-label="Delete this batch">Delete</button>` : ''}
      </div>
      ${b.plan ? `<p class="plan"><strong>Plan:</strong> ${esc(b.plan)}</p>` : ''}
      ${b.error ? `<p class="err">⚠ ${esc(b.error.message)}${b.error.hint ? ` — ${esc(b.error.hint)}` : ''}</p>` : ''}
      <div class="variants">${b.ideas.map((i) => ideaHtml(b, i)).join('')}</div>
    </section>`;
  }).join('');
}

function ideaHtml(b, i) {
  const media = i.videoUrl
    ? `<div class="frame"><video src="${i.videoUrl}" poster="${i.posterUrl || ''}" controls playsinline preload="none" style="aspect-ratio:${i.width || 9}/${i.height || 16}" aria-label="${esc(i.title)} preview"></video></div>`
    : `<div class="wait">${i.status === 'rendering' ? 'Making this video…<div class="bar"><div style="width:30%"></div></div>'
      : i.status === 'queued' ? 'Up next' : i.status === 'cancelled' ? 'Cancelled'
        : `⚠ ${esc(i.error?.message || 'Failed')}${i.error?.hint ? `<br>${esc(i.error.hint)}` : ''}`}</div>`;
  const label = `${i.length}s`;
  return `<article class="variant idea" aria-label="${esc(i.title)}">
    ${media}
    <div class="vm"><div><div class="vl">${esc(i.title)}${i.review ? `<span class="stars" title="${esc(i.review.summary)}">★ ${i.review.score}/10</span>` : ''}</div><div class="vs">${label}${i.size ? ` · ${fmtSize(i.size)}` : ''}${i.vibe ? ` · <span class="vibe">${esc(i.vibe)}</span>` : ''}</div></div></div>
    <div class="cap">${esc(i.caption)}${i.hashtags.length ? `\n<span class="tags">${esc(i.hashtags.join(' '))}</span>` : ''}</div>
    <div class="acts">
      <button class="btn sm ghost" type="button" data-copy="${esc(i.captionText)}">Copy caption</button>
      ${i.downloadUrl && canShareFiles ? `<button class="btn sm ghost share" type="button" data-url="${i.downloadUrl}" data-name="${esc(i.file)}">Save / Share</button>` : ''}
      ${i.downloadUrl ? `<a class="btn sm" href="${i.downloadUrl}" download aria-label="Download ${esc(i.title)}">↓ Download</a>` : ''}
      ${i.jobId && i.status !== 'rendering' ? `<a class="btn sm ghost" href="#/project/${i.jobId}" aria-label="Edit ${esc(i.title)} as a project">Edit</a>` : ''}
    </div>
  </article>`;
}

$('#autoBatches').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Caption and hashtags copied.', 'ok'); }
    catch { toast('Could not copy — press and hold the caption to select it.', 'error'); }
    return;
  }
  const share = e.target.closest('.share');
  if (share) {
    const old = share.textContent;
    share.textContent = '…';
    try {
      const blob = await (await fetch(share.dataset.url)).blob();
      await navigator.share({ files: [new File([blob], share.dataset.name, { type: 'video/mp4' })] });
    } catch (err) {
      if (err.name !== 'AbortError') toast('Sharing failed — use Download instead.', 'error');
    } finally { share.textContent = old; }
    return;
  }
  const del = e.target.closest('[data-del-batch]');
  if (del && confirm('Delete this batch and its video files? (The projects stay.)')) {
    try { onAutopilot(await api(`/api/autopilot/batches/${del.dataset.delBatch}`, { method: 'DELETE' })); }
    catch (err) { toast(err.message, 'error'); }
  }
});

let autoSaveTimer;
async function saveAutopilot() {
  clearTimeout(autoSaveTimer);
  auto.editing = false;
  const lengths = $$('[name=autoLen]').filter((c) => c.checked).map((c) => c.value);
  try {
    onAutopilot(await api('/api/autopilot', {
      method: 'PATCH',
      body: {
        enabled: $('#autoOn').checked,
        everyDays: Number($('#autoEvery').value),
        perBatch: Number($('#autoPer').value),
        lengths: lengths.length ? lengths : undefined,
        direction: $('#autoDir').value,
        brand: $('#autoBrand').value,
        cta: $('#autoCta').value,
        voiceover: $('#autoVoiceover').value,
        voice: $('#autoVoice').value,
      },
    }));
  } catch (err) { toast(err.message, 'error'); }
}
$('#autoForm').addEventListener('submit', (e) => e.preventDefault());
$('#autoForm').addEventListener('change', (e) => {
  if (e.target.name === 'autoLen' && !$$('[name=autoLen]').some((c) => c.checked)) e.target.checked = true; // keep at least one
  if (e.target === $('#autoOn') && e.target.checked) toast('Autopilot is on — the first batch starts now.', 'ok');
  saveAutopilot();
});
$('#autoForm').addEventListener('input', (e) => {
  if (e.target.tagName !== 'TEXTAREA' && e.target.type !== 'text') return;
  auto.editing = true;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => { auto.editing = false; saveAutopilot(); }, 900);
});
$('#autoRun').addEventListener('click', async () => {
  await saveAutopilot();
  try { onAutopilot(await api('/api/autopilot/run', { method: 'POST' })); announce('Autopilot started a batch.'); }
  catch (err) { toast(err.message, 'error'); }
});
$('#autoCancel').addEventListener('click', async () => {
  try { await api('/api/autopilot/cancel', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
});

// ---------------------------------------------------------------------------
// "Working on…" — what the server is busy with, so slow ≠ stuck
// ---------------------------------------------------------------------------
let activityTimer;
let activityKicked = false;
const kickActivity = () => {
  if (activityKicked) return;
  activityKicked = true;
  clearTimeout(activityTimer);
  activityTimer = setTimeout(pollActivity, 400);
};
async function pollActivity() {
  clearTimeout(activityTimer);
  activityKicked = false;
  let a;
  try { a = await api('/api/activity'); } catch { a = null; }
  const el = $('#activity');
  const lines = [];
  if (a) {
    for (const r of a.renders) lines.push(`Rendering “${esc(r.name)}” — ${Math.round((r.progress || 0) * 100)}%${r.message ? `<br><span>${esc(r.message)}</span>` : ''}`);
    if (a.autopilot && !a.renders.length) lines.push(`Autopilot: ${esc(a.autopilot)}`);
    if (a.previews) lines.push(`Making previews: ${plural(a.previews, 'video')} left`);
    if (a.scanning) lines.push(`AI scan: ${plural(a.scanning, 'video')} left`);
    if (a.imports) lines.push(`Importing from Google Drive (${a.imports})`);
    if (a.heavy) lines.push(`Quality check / shrinking / preview copies: ${a.heavy} left${a.paused ? ' (paused while rendering)' : ''}`);
    if (a.indexing) lines.push(`Search-by-meaning index: ${plural(a.indexing, 'video')} left`);
  }
  el.classList.toggle('hidden', !lines.length);
  if (lines.length) {
    const maxed = a.load > a.cpus * 1.5;
    el.innerHTML = `<strong>Working</strong>${lines.map((l) => `<div>${l}</div>`).join('')}${maxed
      ? `<div class="warn">This codespace's ${a.cpus} CPUs are maxed out, so things are slow, not stuck. A bigger machine (github.com/codespaces → ⋯ → Change machine type) is faster.</div>` : ''}`;
  }
  activityTimer = setTimeout(pollActivity, document.hidden ? 20_000 : lines.length ? 3000 : 15_000);
}

async function init() {
  const a = await nativeFetch('/api/auth').then((r) => r.json()).catch(() => ({}));
  if (a.enabled && !a.authed) { $('#login').classList.remove('hidden'); $('#pw').focus(); return; }
  migrate();
  $('#libSort').value = store.get('clipforge:sort') || 'new';
  loadHealth();
  loadCloud();
  checkVersion();
  loadAutopilot();
  pollActivity();
  api('/api/scanner').then((sc) => { state.scanner = sc; renderScanBar(); }).catch(() => {});
  api('/api/library/settings').then((ls) => { $('#shrinkLarge').checked = ls.shrinkLarge; }).catch(() => {});
  await Promise.all([loadLibrary().catch((err) => toast(err.message, 'error')), loadProjects()]);
  if (!booted) { listenLibrary(); booted = true; }
  showInterrupted();
  if (!location.hash) {
    const last = store.get('clipforge:last');
    const saved = store.get('clipforge:route');
    const wantProject = saved === 'project' && state.projects.some((p) => p.id === last);
    history.replaceState(null, '', wantProject ? `#/project/${last}` : saved === 'autopilot' ? '#/autopilot' : '#/library');
  }
  route();
}
init();
