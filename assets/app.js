/* Ashgrab — paste a link, grab the video.
   Runs entirely in the browser. Talks to cobalt-compatible backends and
   escalates through fallback strategies until something works. */

'use strict';

/* ---------------------------------------------------------------- config */

const LS = 'ashgrab.settings.v1';
const FALLBACK_SERVERS = [
  { url: 'https://co.otomir23.me/', label: 'otomir23' },
  { url: 'https://cobalt-api.kwiatekmiki.com/', label: 'kwiatekmiki' }
];

const settings = Object.assign(
  { custom: '', key: '', alwaysProxy: false, lastGood: '', history: [] },
  JSON.parse(localStorage.getItem(LS) || localStorage.getItem('snagr.settings.v1') || '{}')
);
const saveSettings = () => localStorage.setItem(LS, JSON.stringify(settings));

/** Runtime server table: { url, label, state: 'unknown'|'up'|'down'|'key', ms, custom } */
let servers = [];
/** Resolves once the list is loaded, so an early request can't run on an empty pool. */
let serversReady;

/* ------------------------------------------------------------------- dom */

const $ = (id) => document.getElementById(id);
const el = {
  form: $('form'), url: $('url'), paste: $('pasteBtn'), go: $('goBtn'),
  card: $('card'), thumb: $('thumb'), title: $('title'), source: $('source'),
  fileinfo: $('fileinfo'), quality: $('quality'), audioOnly: $('audioOnly'),
  dl: $('dlBtn'), progress: $('progress'), progressFill: $('progressFill'),
  progressTxt: $('progressTxt'),
  picker: $('picker'), pickerGrid: $('pickerGrid'), recent: $('recent'),
  statusBox: $('statusBox'), statusMsg: $('statusMsg'), spinner: $('spinner'),
  logToggle: $('logToggle'), log: $('log'), error: $('error'),
  sheet: $('sheet'), settingsBtn: $('settingsBtn'), closeSheet: $('closeSheet'),
  customInstance: $('customInstance'), apiKey: $('apiKey'),
  alwaysProxy: $('alwaysProxy'), serverList: $('serverList'), recheck: $('recheck'),
  reset: $('resetBtn')
};

/* --------------------------------------------------------------- helpers */

function timeoutFetch(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

const normalize = (u) => (u.endsWith('/') ? u : u + '/');

function log(kind, msg) {
  const li = document.createElement('li');
  li.className = kind; // try | ok | fail
  li.innerHTML = `<b>${kind === 'ok' ? '✓' : kind === 'fail' ? '✗' : '→'}</b><span></span>`;
  li.lastChild.textContent = msg;
  el.log.appendChild(li);
  el.log.scrollTop = el.log.scrollHeight;
}

function status(msg, state) {
  el.statusBox.hidden = false;
  el.statusMsg.textContent = msg;
  el.spinner.className = 'spinner' + (state ? ' ' + state : '');
}

function showError(html) {
  el.error.hidden = false;
  el.error.innerHTML = html;
}

function clearAll() {
  el.error.hidden = true;
  el.card.hidden = true;
  el.picker.hidden = true;
  el.pickerGrid.innerHTML = '';
  el.log.innerHTML = '';
  el.progress.hidden = true;
  el.progressFill.style.width = '0%';
  el.dl.disabled = true;
  el.dl.textContent = 'Download';
  el.thumb.innerHTML = '';
}

/* -------------------------------------------------------------- platform */

const PLATFORMS = [
  [/youtube\.com|youtu\.be|yt\.be/i, 'youtube'],
  [/instagram\.com|ig\.me/i, 'instagram'],
  [/tiktok\.com/i, 'tiktok'],
  [/facebook\.com|fb\.watch|fb\.com/i, 'facebook'],
  [/(^|\.)(twitter|x)\.com/i, 'x'],
  [/threads\.(net|com)/i, 'threads'],
  [/reddit\.com|redd\.it/i, 'reddit'],
  [/snapchat\.com/i, 'snapchat'],
  [/vimeo\.com/i, 'vimeo'],
  [/twitch\.tv/i, 'twitch'],
  [/pinterest\.|pin\.it/i, 'pinterest'],
  [/bsky\.app/i, 'bluesky'],
  [/soundcloud\.com/i, 'soundcloud'],
  [/dailymotion\.com|dai\.ly/i, 'dailymotion'],
  [/tumblr\.com/i, 'tumblr'],
  [/vk\.com/i, 'vk'],
  [/bilibili\.com|b23\.tv/i, 'bilibili'],
  [/rutube\.ru/i, 'rutube'],
  [/loom\.com/i, 'loom'],
  [/streamable\.com/i, 'streamable'],
  [/newgrounds\.com/i, 'newgrounds'],
  [/ok\.ru/i, 'ok']
];

function platformOf(u) {
  for (const [re, name] of PLATFORMS) if (re.test(u)) return name;
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'link'; }
}

/* ------------------------------------------------------- url intelligence */

/* Pull the first URL out of arbitrary text — share sheets and messenger
   copies wrap links in captions, emoji, whatever. */
function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'\])]+/);
  return m ? m[0].replace(/[.,;:!?]+$/, '') : null;
}

const JUNK_PREFIX = ['utm_', 'mc_', 'embeds_'];
const JUNK_EXACT = ['fbclid', 'gclid', 'dclid', 'igsh', 'igshid', 'si', 'feature',
  'mibextid', 'share_id', 's_kwcid', 'ref', 'ref_src', 'ref_url', 'rdt', 'cxt'];

/* Strip tracking junk and unwrap redirect shells so the backends see the
   cleanest possible link. */
function cleanUrl(raw, depth = 0) {
  let u;
  try { u = new URL(raw); } catch { return raw; }
  if (depth < 3) {
    // facebook/instagram interstitials and google result wrappers
    if (/^(l|lm)\.(facebook|instagram)\.com$/.test(u.hostname) && u.searchParams.get('u')) {
      return cleanUrl(u.searchParams.get('u'), depth + 1);
    }
    if (/(^|\.)google\.[a-z.]{2,6}$/.test(u.hostname) && u.pathname === '/url') {
      const inner = u.searchParams.get('q') || u.searchParams.get('url');
      if (inner) return cleanUrl(inner, depth + 1);
    }
  }
  for (const k of [...u.searchParams.keys()]) {
    const lk = k.toLowerCase();
    if (JUNK_PREFIX.some((p) => lk.startsWith(p)) || JUNK_EXACT.includes(lk)) {
      u.searchParams.delete(k);
    }
  }
  // on x/twitter, s= and t= are share-tracking, not content
  if (/(^|\.)(twitter|x)\.com$/.test(u.hostname)) {
    u.searchParams.delete('s');
    u.searchParams.delete('t');
  }
  return u.toString().replace(/\?$/, '');
}

/* A link that already points at a media file needs no extraction at all. */
const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'aac', 'flac'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'gif', 'jpg', 'jpeg', 'png', 'webp'];
function directFile(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-z0-9]{2,4})$/i);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    if (!AUDIO_EXT.includes(ext) && !VIDEO_EXT.includes(ext)) return null;
    return { url, filename: decodeURIComponent(p.split('/').pop()), audioOnly: AUDIO_EXT.includes(ext) };
  } catch { return null; }
}

function youtubeId(u) {
  const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/* Thumbnail + title, best effort, never blocking the download path. */
async function loadPreview(url) {
  const yt = youtubeId(url);
  if (yt) {
    setThumbImage(`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`);
  }
  try {
    const r = await timeoutFetch(
      'https://noembed.com/embed?url=' + encodeURIComponent(url), {}, 8000
    );
    const d = await r.json();
    if (d && !d.error) {
      if (d.title) el.title.textContent = d.title;
      if (d.author_name) {
        el.fileinfo.textContent = 'by ' + d.author_name;
      }
      if (!yt && d.thumbnail_url) setThumbImage(d.thumbnail_url);
      return;
    }
  } catch { /* preview is optional */ }
}

function setThumbImage(src) {
  const img = new Image();
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => { el.thumb.innerHTML = ''; el.thumb.appendChild(img); };
  img.src = src;
}

const NOTE_SVG = '<svg viewBox="0 0 24 24" class="note" aria-hidden="true"><path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

/* Once we have a real media URL, use the media itself as the preview —
   works for platforms that expose no oEmbed data at all. */
function setThumbMedia(src, isAudio) {
  if (isAudio) { el.thumb.innerHTML = NOTE_SVG; return; }
  const v = document.createElement('video');
  v.src = src; v.muted = true; v.playsInline = true; v.preload = 'metadata';
  v.onloadeddata = () => { el.thumb.innerHTML = ''; el.thumb.appendChild(v); };
  v.onerror = () => { /* keep whatever placeholder is there */ };
}

/* ---------------------------------------------------- server discovery */

function loadServers() {
  serversReady = loadServersInner();
  return serversReady;
}

async function loadServersInner() {
  let list = FALLBACK_SERVERS;
  try {
    const r = await timeoutFetch('assets/servers.json', { cache: 'no-cache' }, 8000);
    const d = await r.json();
    if (Array.isArray(d.servers) && d.servers.length) list = d.servers;
  } catch { /* bundled fallback */ }

  servers = list.map((s) => ({ url: normalize(s.url), label: s.label || hostOf(s.url), state: 'unknown', ms: null }));
  applyCustom();
  renderServers();
  await probeAll();
}

function hostOf(u) { try { return new URL(u).hostname; } catch { return u; } }

function applyCustom() {
  servers = servers.filter((s) => !s.custom);
  if (settings.custom.trim()) {
    servers.unshift({
      url: normalize(settings.custom.trim()),
      label: 'yours', state: 'unknown', ms: null, custom: true
    });
  }
}

/* Probe: GET / returns cobalt's server info. Also tells us if a key is needed. */
async function probe(s) {
  const t0 = performance.now();
  try {
    const r = await timeoutFetch(s.url, { headers: { Accept: 'application/json' } }, 8000);
    const d = await r.json();
    s.ms = Math.round(performance.now() - t0);
    if (d && d.cobalt) {
      s.services = d.cobalt.services || [];
      // A turnstile-protected server can't be used from a static page without a key.
      s.state = d.cobalt.turnstileSitekey && !settings.key ? 'key' : 'up';
    } else {
      s.state = 'down';
    }
  } catch {
    s.state = 'down';
    s.ms = null;
  }
}

async function probeAll() {
  await Promise.all(servers.map(probe));
  // fastest healthy first, custom always pinned to the top
  servers.sort((a, b) => {
    if (a.custom !== b.custom) return a.custom ? -1 : 1;
    const rank = (s) => (s.state === 'up' ? 0 : s.state === 'key' ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.ms ?? 9e9) - (b.ms ?? 9e9);
  });
  renderServers();
}

function renderServers() {
  el.serverList.innerHTML = '';
  for (const s of servers) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot ' + (s.state === 'up' ? 'up' : s.state === 'down' ? 'down' : s.state === 'key' ? 'key' : '');
    const name = document.createElement('span');
    name.textContent = s.label + (s.custom ? ' · ' + hostOf(s.url) : '');
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent =
      s.state === 'up' ? s.ms + 'ms' :
      s.state === 'key' ? 'needs key' :
      s.state === 'down' ? 'offline' : 'checking…';
    li.append(dot, name, note);
    el.serverList.appendChild(li);
  }
}

/* ------------------------------------------------------ strategy engine */

/* Each strategy is a different way of asking for the same file. If one shape
   of request fails, the next one changes something meaningful — the protocol
   version, the quality, the codec, or who carries the bytes. */
function strategies(url, opts) {
  const q = opts.quality === 'max' ? 'max' : String(opts.quality);
  const lower = { max: '1080', 1080: '720', 720: '480', 480: '360', 360: '240' }[q] || '480';

  const base = {
    url,
    filenameStyle: 'pretty',
    downloadMode: opts.audioOnly ? 'audio' : 'auto',
    audioFormat: 'mp3'
  };

  const list = [
    { name: 'standard', body: { ...base, videoQuality: q, youtubeVideoCodec: 'h264' } },
    { name: 'proxied',  body: { ...base, videoQuality: q, youtubeVideoCodec: 'h264', alwaysProxy: true } },
    { name: `lower quality (${lower}p)`, body: { ...base, videoQuality: lower, youtubeVideoCodec: 'h264' } },
    { name: 'vp9 / hls path', body: { ...base, videoQuality: q, youtubeVideoCodec: 'vp9', youtubeHLS: true } },
    { name: 'legacy api', body: { url, vQuality: q === 'max' ? 'max' : q, isAudioOnly: !!opts.audioOnly, aFormat: 'mp3', filenamePattern: 'pretty' }, legacy: true }
  ];

  if (settings.alwaysProxy) {
    list.unshift({ name: 'proxied (your setting)', body: { ...base, videoQuality: q, youtubeVideoCodec: 'h264', alwaysProxy: true } });
  }
  if (!opts.audioOnly) {
    // absolute last resort: at least get the audio out of it
    list.push({ name: 'audio only rescue', body: { ...base, downloadMode: 'audio', videoQuality: lower }, rescue: true });
  }
  return list;
}

/* Error codes that mean "this server will never do it" vs "try another shape". */
const HARD_FAIL = /unsupported|invalid.*link|content\.post\.private|content\.post\.age|link\.invalid/i;
const AUTH_FAIL = /auth|jwt|turnstile|api\.key/i;
const RATE_FAIL = /rate|limit|429/i;

async function askServer(server, strat) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (settings.key) headers.Authorization = 'Api-Key ' + settings.key;

  const r = await timeoutFetch(server.url, {
    method: 'POST', headers, body: JSON.stringify(strat.body)
  }, 30000);

  let d;
  try { d = await r.json(); } catch { throw new Error('server sent a non-json reply (http ' + r.status + ')'); }

  const st = d.status;
  if (st === 'error' || st === 'rate-limit') {
    const code = (d.error && d.error.code) || d.text || 'unknown error';
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  // v11: tunnel | redirect | picker ; v7: stream | redirect | picker | success
  if (st === 'tunnel' || st === 'redirect' || st === 'stream' || st === 'success') {
    return { kind: 'file', url: d.url, filename: d.filename || d.text || '' };
  }
  if (st === 'picker') {
    const items = (d.picker || []).map((p) => ({
      type: p.type || 'photo', url: p.url, thumb: p.thumb || p.thumbnail
    }));
    return { kind: 'picker', items, audio: d.audio };
  }
  throw new Error('unexpected reply: ' + JSON.stringify(st));
}

/* Walk servers × strategies until something returns a file. */
async function resolve(url, opts) {
  if (!servers.length) servers = FALLBACK_SERVERS.map((s) => ({ ...s, state: 'unknown', ms: null }));
  const usable = servers.filter((s) => s.state !== 'down');
  const pool = usable.length ? usable : servers;
  // your own server first, then whichever public one delivered last time
  pool.sort((a, b) => {
    if (!!a.custom !== !!b.custom) return a.custom ? -1 : 1;
    const ag = a.url === settings.lastGood, bg = b.url === settings.lastGood;
    if (ag !== bg) return ag ? -1 : 1;
    return 0;
  });
  const plan = strategies(url, opts);
  const skipped = [];
  const tried = new Set();
  const mark = (s, p) => tried.add(s.url + '|' + p.name);
  const won = (s, res, rescue) => {
    res.audioOnly = !!opts.audioOnly || !!rescue;
    settings.lastGood = s.url; saveSettings();
    return res;
  };

  // fast path: race the primary strategy across the two fastest healthy servers
  const racers = pool.filter((s) => s.state === 'up').slice(0, 2);
  if (racers.length === 2) {
    const strat = plan[0];
    status(`Racing ${racers[0].label} vs ${racers[1].label}…`);
    log('try', `racing ${racers[0].label} vs ${racers[1].label} · ${strat.name}`);
    try {
      const win = await Promise.any(racers.map((s) =>
        askServer(s, strat)
          .then((r) => ({ r, s }))
          .catch((e) => { log('fail', `${s.label}: ${e.code || e.message}`); throw e; })
      ));
      log('ok', `${win.s.label} won the race`);
      return won(win.s, win.r);
    } catch {
      racers.forEach((s) => mark(s, strat));
      log('try', 'both racers failed — walking the full grid');
    }
  }

  for (const server of pool) {
    if (server.state === 'key' && !settings.key) {
      log('fail', `${server.label}: needs an api key — skipped`);
      skipped.push(server.label);
      continue;
    }
    for (const strat of plan) {
      // don't silently hand back audio unless every real option is gone
      if (strat.rescue && server !== pool[pool.length - 1]) continue;
      if (tried.has(server.url + '|' + strat.name)) continue;

      status(`Trying ${server.label} · ${strat.name}…`);
      log('try', `${server.label} · ${strat.name}`);
      try {
        const res = await askServer(server, strat);
        log('ok', `${server.label} answered · ${strat.name}`);
        if (strat.rescue) log('try', 'video was unavailable everywhere — this is the audio track');
        return won(server, res, strat.rescue);
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'timed out' : (e.code || e.message);
        log('fail', `${server.label} · ${strat.name}: ${msg}`);

        if (AUTH_FAIL.test(msg)) { server.state = 'key'; break; }   // this server is unusable, next server
        if (RATE_FAIL.test(msg)) break;                             // don't hammer it, next server
        if (HARD_FAIL.test(msg)) {
          // the link itself is the problem: retrying the same api with different
          // knobs won't help, but an older api version sometimes still parses it
          const legacy = plan.find((p) => p.legacy);
          if (legacy && !strat.legacy) {
            status(`Trying ${server.label} · ${legacy.name}…`);
            log('try', `${server.label} · ${legacy.name}`);
            try {
              const res = await askServer(server, legacy);
              log('ok', `${server.label} answered · ${legacy.name}`);
              return won(server, res);
            } catch (e2) {
              log('fail', `${server.label} · ${legacy.name}: ${e2.code || e2.message}`);
            }
          }
          break;
        }
      }
    }
  }
  const err = new Error('all strategies failed');
  err.skipped = skipped;
  throw err;
}

/* ------------------------------------------------------------- download */

let current = null; // last resolved result

async function download(fileUrl, filename, isAudio) {
  el.dl.disabled = true;
  el.progress.hidden = false;
  el.progressFill.style.width = '0%';
  el.progressTxt.textContent = 'Starting…';

  // strategy 1: stream it into a blob so the browser saves it with a real name
  try {
    const r = await timeoutFetch(fileUrl, {}, 600000);
    if (!r.ok) throw new Error('http ' + r.status);
    const total = +r.headers.get('content-length') || 0;
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total) {
        const pct = Math.round((got / total) * 100);
        el.progressFill.style.width = pct + '%';
        el.progressTxt.textContent = pct + '% · ' + mb(got) + ' / ' + mb(total);
      } else {
        el.progressTxt.textContent = mb(got) + ' downloaded';
      }
    }
    const blob = new Blob(chunks);
    saveBlob(blob, filename || fallbackName(isAudio));
    el.progressFill.style.width = '100%';
    el.progressTxt.textContent = 'Saved · ' + mb(blob.size);
    log('ok', 'saved ' + mb(blob.size));
  } catch (e) {
    // strategy 2: let the browser handle it directly
    log('fail', 'in-page save failed (' + (e.message || e.name) + ') — handing it to the browser');
    el.progressTxt.textContent = 'Opening download…';
    const a = document.createElement('a');
    a.href = fileUrl;
    a.download = filename || fallbackName(isAudio);
    a.rel = 'noopener';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
    el.progressTxt.textContent = 'Download handed to your browser';
  } finally {
    el.dl.disabled = false;
  }
}

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const fallbackName = (isAudio) => 'ashgrab-' + Date.now() + (isAudio ? '.mp3' : '.mp4');

function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

/* ------------------------------------------------------------ main flow */

async function run(rawUrl) {
  const url = cleanUrl(extractUrl(rawUrl) || rawUrl);
  el.url.value = url;
  clearAll();
  el.go.disabled = true;
  el.card.hidden = false;
  el.title.textContent = 'Looking it up…';
  el.source.textContent = platformOf(url);
  el.fileinfo.textContent = '';
  el.thumb.textContent = platformOf(url).slice(0, 1).toUpperCase();
  status('Working…');

  // link already points at a file — no extraction needed
  const direct = directFile(url);
  if (direct) {
    current = direct;
    log('ok', 'direct media link — no server needed');
    setThumbMedia(url, direct.audioOnly);
    el.title.textContent = direct.filename;
    el.fileinfo.textContent = direct.audioOnly ? 'audio file' : 'media file';
    el.dl.disabled = false;
    el.dl.textContent = direct.audioOnly ? 'Download audio' : 'Download';
    status('Ready', 'done');
    el.go.disabled = false;
    remember(url, direct.filename);
    return;
  }

  loadPreview(url); // fire and forget

  const opts = { quality: el.quality.value, audioOnly: el.audioOnly.checked };

  try {
    await serversReady;               // a ?url= link can land before the list is ready
    const res = await resolve(url, opts);

    if (res.kind === 'picker') {
      status('Found ' + res.items.length + ' items', 'done');
      renderPicker(res);
      el.card.hidden = true;
      remember(url, 'album · ' + platformOf(url));
      return;
    }

    current = res;
    setThumbMedia(res.url, res.audioOnly);
    if (res.filename) {
      el.title.textContent = res.filename.replace(/\.[a-z0-9]{2,4}$/i, '');
      el.fileinfo.textContent = res.audioOnly ? 'audio · mp3' : 'video · mp4';
    } else if (el.title.textContent === 'Looking it up…') {
      el.title.textContent = 'Ready to download';
    }
    el.dl.disabled = false;
    el.dl.textContent = res.audioOnly ? 'Download audio' : 'Download video';
    status('Ready', 'done');
    remember(url, el.title.textContent);
  } catch (e) {
    status("Couldn't get that one", 'fail');
    el.card.hidden = true;
    el.logToggle.setAttribute('aria-expanded', 'true');
    el.log.hidden = false;
    showError(
      '<b>That one didn\'t work — sorry.</b>' +
      '<ul>' +
      '<li>Make sure the link opens normally in your browser. Private or deleted posts can\'t be saved.</li>' +
      '<li>The free helpers get busy sometimes. Wait a minute and try again — it usually works.</li>' +
      '</ul>' +
      '<p><button id="retryBtn" class="ghost" type="button">Try again</button></p>'
    );
    const rb = $('retryBtn');
    if (rb) rb.onclick = () => {
      servers.forEach((s) => { if (s.state === 'down') s.state = 'unknown'; });
      probeAll();
      run(url);
    };
  } finally {
    el.go.disabled = false;
  }
}

/* -------------------------------------------------------------- history */

function remember(u, title) {
  const h = (settings.history || []).filter((i) => i.u !== u);
  h.unshift({ u, title: (title || '').slice(0, 60) });
  settings.history = h.slice(0, 8);
  saveSettings();
  renderHistory();
}

function renderHistory() {
  const h = settings.history || [];
  el.recent.hidden = !h.length;
  el.recent.innerHTML = '';
  if (!h.length) return;
  const lbl = document.createElement('span');
  lbl.className = 'recent-label';
  lbl.textContent = 'Recent:';
  el.recent.appendChild(lbl);
  for (const it of h) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = it.title || hostOf(it.u);
    b.title = it.u;
    b.onclick = () => run(it.u);
    el.recent.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'chip clear';
  x.textContent = 'clear';
  x.onclick = () => { settings.history = []; saveSettings(); renderHistory(); };
  el.recent.appendChild(x);
}

function renderPicker(res) {
  el.picker.hidden = false;
  el.pickerGrid.innerHTML = '';
  res.items.forEach((item, i) => {
    const b = document.createElement('button');
    b.className = 'pick';
    b.type = 'button';
    if (item.thumb) {
      const img = new Image();
      img.src = item.thumb; img.alt = ''; img.referrerPolicy = 'no-referrer';
      b.appendChild(img);
    } else if (item.type === 'video') {
      const v = document.createElement('video');
      v.src = item.url; v.muted = true; v.preload = 'metadata'; v.playsInline = true;
      b.appendChild(v);
    }
    const s = document.createElement('span');
    s.textContent = (item.type || 'file') + ' ' + (i + 1);
    b.appendChild(s);
    b.onclick = () => download(item.url, `ashgrab-${i + 1}.${item.type === 'photo' ? 'jpg' : 'mp4'}`, false);
    el.pickerGrid.appendChild(b);
  });
  if (res.audio) {
    const b = document.createElement('button');
    b.className = 'pick';
    b.type = 'button';
    b.innerHTML = NOTE_SVG + '<span>audio track</span>';
    b.onclick = () => download(res.audio, 'ashgrab-audio.mp3', true);
    el.pickerGrid.appendChild(b);
  }
}

/* ---------------------------------------------------------------- wiring */

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const u = el.url.value.trim();
  if (!u) return;
  run(u);
});

el.paste.addEventListener('click', async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) run(t);
  } catch {
    el.url.focus();
    el.paste.textContent = 'Ctrl+V';
    setTimeout(() => (el.paste.textContent = 'Paste'), 2000);
  }
});

/* paste anywhere on the page — no need to hit the box first */
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    if (t === el.url) setTimeout(() => { if (extractUrl(el.url.value)) run(el.url.value); }, 0);
    return;
  }
  const u = extractUrl(e.clipboardData && e.clipboardData.getData('text'));
  if (!u) return;
  e.preventDefault();
  run(u);
});

/* drop a link onto the page */
['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
document.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const u = extractUrl((dt && (dt.getData('text/uri-list') || dt.getData('text'))) || '');
  if (u) run(u);
});

/* "/" focuses the box, like every search page */
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault();
    el.url.focus();
  }
});

el.dl.addEventListener('click', () => {
  if (current) download(current.url, current.filename, current.audioOnly);
});

// changing quality / format invalidates the resolved link
[el.quality, el.audioOnly].forEach((n) =>
  n.addEventListener('change', () => {
    if (el.url.value.trim() && current) run(el.url.value.trim());
  })
);

el.logToggle.addEventListener('click', () => {
  const open = el.logToggle.getAttribute('aria-expanded') === 'true';
  el.logToggle.setAttribute('aria-expanded', String(!open));
  el.log.hidden = open;
});

/* settings sheet */
const infoSheet = $('infoSheet');
const openSheet = (e) => {
  if (e) e.preventDefault();
  infoSheet.hidden = true;
  el.customInstance.value = settings.custom;
  el.apiKey.value = settings.key;
  el.alwaysProxy.checked = settings.alwaysProxy;
  el.sheet.hidden = false;
};
const closeSheet = () => { el.sheet.hidden = true; };

el.settingsBtn.addEventListener('click', openSheet);
$('settingsLink').addEventListener('click', openSheet);
$('selfhostLink').addEventListener('click', (e) => {
  openSheet(e);
  document.querySelector('.selfhost').scrollIntoView({ behavior: 'smooth' });
});
el.closeSheet.addEventListener('click', closeSheet);
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });

/* info screen — footer links open it at the matching section */
document.querySelectorAll('[data-info]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    infoSheet.hidden = false;
    const target = $(a.dataset.info);
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  })
);
$('closeInfo').addEventListener('click', () => { infoSheet.hidden = true; });
infoSheet.addEventListener('click', (e) => { if (e.target === infoSheet) infoSheet.hidden = true; });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); infoSheet.hidden = true; }
});

el.customInstance.addEventListener('change', () => {
  settings.custom = el.customInstance.value.trim();
  saveSettings();
  applyCustom();
  renderServers();
  probeAll();
});
el.apiKey.addEventListener('change', () => {
  settings.key = el.apiKey.value.trim();
  saveSettings();
  probeAll();
});
el.alwaysProxy.addEventListener('change', () => {
  settings.alwaysProxy = el.alwaysProxy.checked;
  saveSettings();
});
el.recheck.addEventListener('click', () => {
  servers.forEach((s) => { s.state = 'unknown'; s.ms = null; });
  renderServers();
  probeAll();
});
el.reset.addEventListener('click', () => {
  localStorage.removeItem(LS);
  settings.custom = ''; settings.key = ''; settings.alwaysProxy = false;
  openSheet();
  loadServers();
});

/* start: accept ?url= / ?text= so the page works as a share target and bookmarklet */
loadServers();
renderHistory();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
const qp = new URLSearchParams(location.search);
const shared = qp.get('url') || extractUrl(qp.get('text')) || extractUrl(qp.get('title'));
if (shared) run(shared);

/* hooks for the test suite */
window.__ashgrab = { cleanUrl, extractUrl, directFile };
