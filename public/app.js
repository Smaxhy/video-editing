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
const isVideoFile = (f) => f.size > 0 && (f.type.startsWith('video/') || VIDEO_EXT.test(f.name));
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
  if (a.status === 'ready') return a.preview.proxy === 'failed' ? 'No browser preview' : '';
  if (a.preview.proxy === 'encoding') return `Preparing preview ${Math.round((a.preview.progress || 0) * 100)}%`;
  if (a.preview.step === 'storyboard') return 'Making storyboard…';
  return 'Processing…';
}
const assetSub = (a) => [`${a.width}×${a.height}`, fmtSize(a.size), codec(a.videoCodec), a.hasAudio ? '' : 'no audio'].filter(Boolean).join(' · ');

function assetCard(a) {
  const sel = state.selected.has(a.id);
  return `<li class="asset${sel ? ' selected' : ''}" data-id="${a.id}">
    <label class="sel"><input type="checkbox" data-select ${sel ? 'checked' : ''} aria-label="Select ${esc(a.name)}" /></label>
    ${thumbHtml(a, { previewLabel: `Preview ${a.name}`, status: assetStatus(a) })}
    <div class="info"><div class="name" title="${esc(a.name)}">${esc(a.name)}</div><div class="sub">${esc(assetSub(a))}</div></div>
  </li>`;
}

function visibleAssets(query, sort) {
  const q = query.trim().toLowerCase();
  const list = state.assets.filter((a) => !q || a.name.toLowerCase().includes(q));
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
  const list = visibleAssets($('#libSearch').value, $('#libSort').value);
  const grid = $('#assetGrid');
  const focusId = document.activeElement?.closest?.('.asset')?.dataset.id;
  const focusSel = document.activeElement?.matches?.('[data-select]') ? '[data-select]' : '[data-preview]';
  grid.innerHTML = list.map(assetCard).join('');
  if (focusId) $(`.asset[data-id="${focusId}"] ${focusSel}`, grid)?.focus();
  $('#libEmpty').classList.toggle('hidden', list.length > 0 || state.assets.length === 0);
  $('#libDrop').classList.toggle('compact', state.assets.length > 0);
  $('#libDrop strong').textContent = state.assets.length ? 'Drop more videos anywhere on this page' : 'Drop videos anywhere on this page';
  $('#libCount').textContent = state.assets.length || '';
  renderSelbar();
  renderDisk();
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
    }
  };
}

$('#libSearch').addEventListener('input', renderLibrary);
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
  const ids = visibleAssets('', $('#libSort').value).map((a) => a.id).filter((id) => state.selected.has(id));
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
  const ok = files.filter(isVideoFile);
  const skipped = files.filter((f) => !isVideoFile(f));
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
      // 64 MB per request: under Cloudflare's 100 MB cap (behind nginx set client_max_body_size 100m).
      chunkSize: 64 * 1024 * 1024,
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

function setPlayer(url, poster, waitMsg) {
  const box = $('#vPlayer');
  viewer.waiting = !url;
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
  if (first || (viewer.waiting && a.streamUrl)) {
    const wait = a.preview.proxy === 'failed'
      ? "Couldn't make a browser preview of this file. It can still be used in edits — download it to watch."
      : `Making a browser-friendly preview (${a.preview.proxyReason})… ${Math.round((a.preview.progress || 0) * 100)}%`;
    setPlayer(a.streamUrl, a.thumbnail, wait);
  } else if (viewer.waiting) {
    $('#vPlayer .wait').textContent = `Making a browser-friendly preview (${a.preview.proxyReason})… ${Math.round((a.preview.progress || 0) * 100)}%`;
  }
  $('#vFacts').innerHTML = facts([
    ['Duration', fmtTime(a.duration)],
    ['Resolution', `${a.width}×${a.height}`],
    ['File size', fmtSize(a.size)],
    ['Video', codec(a.videoCodec)],
    ['Audio', a.hasAudio ? codec(a.audioCodec) : 'None'],
    ['Added', new Date(a.createdAt).toLocaleString()],
  ]);
  if (first) renderViewerActions(a);
}

function renderViewerActions(a) {
  const box = $('#vActions');
  const inProject = viewer.clip && state.view === 'project';
  box.innerHTML = `
    ${a ? `<label class="sr-only" for="vName">Video name</label><input class="field" id="vName" value="${esc(a.name)}" maxlength="200" style="flex:1 1 220px" />
      <button class="btn sm ghost" type="button" data-v="rename">Rename</button>` : ''}
    <span class="spacer"></span>
    ${a && !inProject ? `<label class="sr-only" for="vProject">Project</label><select class="field" id="vProject">${projectOptions(state.jobId || store.get('clipforge:last'))}</select>
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

for (const d of [dlg, $('#picker')]) {
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
  const list = visibleAssets($('#pkSearch').value, 'new');
  $('#pkGrid').innerHTML = list.length ? list.map((a) => `
    <li class="asset${pickSel.has(a.id) ? ' selected' : ''}" data-id="${a.id}">
      <label style="cursor:pointer;display:block">
        ${thumbHtml(a, { status: assetStatus(a) })}
        <span class="info" style="display:flex;gap:8px;align-items:flex-start">
          <input type="checkbox" ${pickSel.has(a.id) ? 'checked' : ''} style="margin-top:3px;accent-color:var(--accent)" />
          <span style="min-width:0"><span class="name" style="display:block">${esc(a.name)}</span><span class="sub" style="display:block">${esc(assetSub(a))}</span></span>
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
  if (view === 'library') $('#navLibrary').setAttribute('aria-current', 'page');
  else $('#navLibrary').removeAttribute('aria-current');
  document.body.classList.remove('nav-open');
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  renderProjects();
}

let firstRoute = true;
async function route() {
  const m = location.hash.match(/^#\/project\/([\w-]+)$/);
  if (m) {
    await openProject(m[1]);
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
        <div class="sub">${fmtTime(c.duration)} · ${c.width}×${c.height}${c.hasAudio ? '' : ' · no audio'}</div></div>
      <div class="acts">
        <button class="icon-btn" type="button" data-move="-1" aria-label="Move ${esc(c.name)} earlier" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-up"/></svg></button>
        <button class="icon-btn" type="button" data-move="1" aria-label="Move ${esc(c.name)} later" ${i === n - 1 ? 'disabled' : ''}><svg><use href="#i-down"/></svg></button>
        <button class="icon-btn" type="button" data-remove aria-label="Remove ${esc(c.name)} from project"><svg><use href="#i-x"/></svg></button>
      </div>
    </li>`).join('');
  if (!n) $('#clipStrip').innerHTML = '<li style="display:block;text-align:center;color:var(--muted);padding:18px">No clips yet — upload videos or add some from your library.</li>';
  updateGo();
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
    silence: $('#silence').checked,
    shots: $('#shots').checked,
    cleanVoice: $('#cleanVoice').checked,
    watermark: $('#watermark').checked,
    useLogo: true,
  };
}
function applySaved(saved) {
  $('#prompt').value = saved.prompt || '';
  const s = saved.settings || {};
  for (const k of ['goal', 'formats', 'lengths', 'captions', 'framing', 'size']) if (s[k]) setSeg(k, s[k]);
  for (const k of ['brand', 'cta', 'accent', 'whisperModel', 'engine']) if (s[k]) $('#' + k).value = s[k];
  for (const k of ['silence', 'shots', 'cleanVoice', 'watermark']) {
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
['#brand', '#cta', '#accent', '#whisperModel', '#engine', '#silence', '#shots', '#cleanVoice', '#watermark', '#logoCutout']
  .forEach((sel) => $(sel).addEventListener('input', remember));

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
  const ready = state.clips.length > 0 && $('#prompt').value.trim().length > 0 && n <= 8;
  $('#go').disabled = !ready || state.running;
  $('#go').textContent = n > 1 ? `Forge ${n} videos` : 'Forge video';
  $('#rerender').classList.toggle('hidden', !state.shown || state.running);
  $('#rerender').disabled = n > 8;
  $('#goHint').textContent = state.running ? 'Working — you can leave this page and come back later.'
    : n > 8 ? 'Pick at most 8 format × length combinations.'
    : !state.clips.length ? (pending ? 'Waiting for uploads to finish…' : 'Add at least one clip.')
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

const STEP_NAMES = { transcribe: 'Transcription', plan: 'Planning', render: 'Rendering' };
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
    el.className = `step ${st.status}`;
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
  $('#resultMeta').textContent = `${plural(r.variants.length, 'video')} · ${fmtSize(r.totalSize)}`;
  $('#variants').innerHTML = r.variants.map((v) => {
    const label = `${v.length === 'full' ? 'Full' : v.length + 's'} · ${FORMAT_LABEL[v.format] || v.format}`;
    return `<div class="variant">
      <div class="frame"><video src="${v.previewUrl}" poster="${v.posterUrl || ''}" controls playsinline preload="none" style="aspect-ratio:${v.width}/${v.height}" aria-label="${esc(label)} preview"></video></div>
      <div class="vm">
        <div><div class="vl">${esc(label)}</div><div class="vs">${fmtTime(v.duration)} · ${fmtSize(v.size)}</div></div>
        ${canShareFiles ? `<button class="btn sm ghost share" type="button" data-url="${v.downloadUrl}" data-name="${esc(v.file)}">Share</button>` : ''}
        <a class="btn sm" href="${v.downloadUrl}" download aria-label="Download ${esc(label)}">↓</a>
      </div>
    </div>`;
  }).join('');
  $('#warns').innerHTML = (r.warnings || []).map((w) => `⚠ ${esc(w)}`).join('<br>');
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
async function init() {
  const a = await nativeFetch('/api/auth').then((r) => r.json()).catch(() => ({}));
  if (a.enabled && !a.authed) { $('#login').classList.remove('hidden'); $('#pw').focus(); return; }
  migrate();
  $('#libSort').value = store.get('clipforge:sort') || 'new';
  loadHealth();
  await Promise.all([loadLibrary().catch((err) => toast(err.message, 'error')), loadProjects()]);
  if (!booted) { listenLibrary(); booted = true; }
  showInterrupted();
  if (!location.hash) {
    const last = store.get('clipforge:last');
    const wantProject = store.get('clipforge:route') === 'project' && state.projects.some((p) => p.id === last);
    history.replaceState(null, '', wantProject ? `#/project/${last}` : '#/library');
  }
  route();
}
init();
