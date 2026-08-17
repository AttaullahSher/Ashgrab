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
  form: $('form'), url: $('url'), paste: $('pasteBtn'),
  card: $('card'), thumb: $('thumb'), title: $('title'), source: $('source'),
  fileinfo: $('fileinfo'), quality: $('quality'), format: $('format'),
  dl: $('dlBtn'), progress: $('progress'), progressFill: $('progressFill'),
  progressTxt: $('progressTxt'),
  picker: $('picker'), pickerGrid: $('pickerGrid'), recent: $('recent'),
  statusBox: $('statusBox'), statusMsg: $('statusMsg'), spinner: $('spinner'),
  error: $('error'),
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

/* The engine narrates every route it tries. That is for debugging, not for
   people, so it goes nowhere — kept as a no-op so the calls stay valid. */
function log() {}

function status(msg, state) {
  el.statusBox.hidden = false;
  el.statusMsg.textContent = msg;
  el.spinner.className = 'spinner' + (state ? ' ' + state : '');
}

function showError(html) {
  el.statusBox.hidden = true;
  el.error.hidden = false;
  el.error.innerHTML = html;
}

function clearAll() {
  el.error.hidden = true;
  el.card.hidden = true;
  el.picker.hidden = true;
  el.pickerGrid.innerHTML = '';
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

  servers = list.map((s, i) => ({ url: normalize(s.url), label: s.label || hostOf(s.url), nick: 'helper ' + (i + 1), state: 'unknown', ms: null }));
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
      label: 'yours', nick: 'your server', state: 'unknown', ms: null, custom: true
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
    { name: 'normal route', body: { ...base, videoQuality: q, youtubeVideoCodec: 'h264' } },
    { name: 'relay route',  body: { ...base, videoQuality: q, youtubeVideoCodec: 'h264', alwaysProxy: true } },
    { name: `smaller size (${lower}p)`, body: { ...base, videoQuality: lower, youtubeVideoCodec: 'h264' } },
    { name: 'backup route', body: { ...base, videoQuality: q, youtubeVideoCodec: 'vp9', youtubeHLS: true } },
    { name: 'older route', body: { url, vQuality: q === 'max' ? 'max' : q, isAudioOnly: !!opts.audioOnly, aFormat: 'mp3', filenamePattern: 'pretty' }, legacy: true }
  ];

  if (settings.alwaysProxy) {
    list.unshift({ name: 'relay route (your setting)', body: { ...base, videoQuality: q, youtubeVideoCodec: 'h264', alwaysProxy: true } });
  }
  /* Retrying after an empty file: a dead direct link usually means the bytes
     must be carried by the server itself, so lead with the relay route. */
  if (opts.preferProxy) {
    list.unshift({ name: 'relay route (fresh copy)', body: { ...base, videoQuality: q, youtubeVideoCodec: 'h264', alwaysProxy: true } });
  }
  if (!opts.audioOnly) {
    // absolute last resort: at least get the audio out of it
    list.push({ name: 'audio only', body: { ...base, downloadMode: 'audio', videoQuality: lower }, rescue: true });
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

/* What went wrong, in plain words — the raw code still drives the logic. */
function friendly(msg) {
  if (AUTH_FAIL.test(msg)) return 'needs a pass';
  if (RATE_FAIL.test(msg)) return 'too busy right now';
  if (/timed out|abort/i.test(msg)) return 'took too long';
  if (HARD_FAIL.test(msg)) return "can't open this link";
  return "didn't work";
}

/* Walk servers × strategies until something returns a file.
   dudServers: servers that resolved fine but streamed an empty file — skip them. */
async function resolve(url, opts, dudServers = new Set()) {
  if (!servers.length) servers = FALLBACK_SERVERS.map((s, i) => ({ ...s, nick: 'helper ' + (i + 1), state: 'unknown', ms: null }));
  const usable = servers.filter((s) => s.state !== 'down');
  let pool = usable.length ? usable : servers;
  const nonDud = pool.filter((s) => !dudServers.has(s.url));
  if (nonDud.length) pool = nonDud;
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
    res.serverUrl = s.url;
    settings.lastGood = s.url; saveSettings();
    return res;
  };

  // fast path: race the primary strategy across the two fastest healthy servers
  const racers = pool.filter((s) => s.state === 'up').slice(0, 2);
  if (racers.length === 2) {
    const strat = plan[0];
    status('Finding your video…');
    log('try', `racing ${racers[0].nick} vs ${racers[1].nick} · ${strat.name}`);
    try {
      const win = await Promise.any(racers.map((s) =>
        askServer(s, strat)
          .then((r) => ({ r, s }))
          .catch((e) => { log('fail', `${s.nick}: ${friendly(e.code || e.message)}`); throw e; })
      ));
      log('ok', `${win.s.nick} won the race`);
      return won(win.s, win.r);
    } catch {
      racers.forEach((s) => mark(s, strat));
      log('try', 'both were slow — trying every route');
    }
  }

  for (const server of pool) {
    if (server.state === 'key' && !settings.key) {
      log('fail', `${server.nick}: needs a pass — skipped`);
      skipped.push(server.nick);
      continue;
    }
    for (const strat of plan) {
      // don't silently hand back audio unless every real option is gone
      if (strat.rescue && server !== pool[pool.length - 1]) continue;
      if (tried.has(server.url + '|' + strat.name)) continue;

      status('Still looking…');
      log('try', `${server.nick} · ${strat.name}`);
      try {
        const res = await askServer(server, strat);
        log('ok', `${server.nick} delivered · ${strat.name}`);
        if (strat.rescue) log('try', 'the video itself was unavailable — this is the sound only');
        return won(server, res, strat.rescue);
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'timed out' : (e.code || e.message);
        log('fail', `${server.nick} · ${strat.name}: ${friendly(msg)}`);

        if (AUTH_FAIL.test(msg)) { server.state = 'key'; break; }   // this server is unusable, next server
        if (RATE_FAIL.test(msg)) break;                             // don't hammer it, next server
        if (HARD_FAIL.test(msg)) {
          // the link itself is the problem: retrying the same api with different
          // knobs won't help, but an older api version sometimes still parses it
          const legacy = plan.find((p) => p.legacy);
          if (legacy && !strat.legacy) {
            status(`Trying ${server.nick} · ${legacy.name}…`);
            log('try', `${server.nick} · ${legacy.name}`);
            try {
              const res = await askServer(server, legacy);
              log('ok', `${server.nick} delivered · ${legacy.name}`);
              return won(server, res);
            } catch (e2) {
              log('fail', `${server.nick} · ${legacy.name}: ${friendly(e2.code || e2.message)}`);
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

/* Long titles make unwieldy filenames — keep them short and tidy. */
function shortName(name) {
  const m = String(name).match(/^(.*?)(\.[a-z0-9]{2,4})?$/i);
  let base = (m[1] || String(name)).trim();
  const ext = m[2] || '';
  if (base.length > 42) {
    base = (base.slice(0, 42).replace(/[\s._,-]+\S*$/, '') || base.slice(0, 42)).trim();
  }
  return base + ext;
}

/* Stream into a blob with progress, save with a real filename.
   Throws Error('empty') if the stream delivers zero bytes — never saves a dud. */
async function downloadFile(fileUrl, filename, isAudio) {
  el.progress.hidden = false;
  el.progressFill.style.width = '0%';
  el.progressTxt.textContent = 'Starting…';

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
  if (!got) throw new Error('empty');
  const blob = new Blob(chunks);
  saveBlob(blob, shortName(filename || fallbackName(isAudio)));
  el.progressFill.style.width = '100%';
  el.progressTxt.textContent = 'Saved · ' + mb(blob.size);
  log('ok', 'saved · ' + mb(blob.size));
}

/* Last resort: hand the link straight to the browser. */
function browserDownload(fileUrl, filename, isAudio) {
  log('try', 'letting your browser handle the download');
  el.progress.hidden = false;
  el.progressTxt.textContent = 'Download handed to your browser';
  const a = document.createElement('a');
  a.href = fileUrl;
  a.download = shortName(filename || fallbackName(isAudio));
  a.rel = 'noopener';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* Download `current`; if the file comes back empty (a helper pretending to
   deliver), quietly switch helper and try again before giving up. */
async function grabAndSave() {
  const opts = { quality: el.quality.value, audioOnly: el.format.value === 'audio' };
  const duds = new Set();
  const LOWER = { max: '1080', 1080: '720', 720: '480', 480: '360', 360: '240' };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await downloadFile(current.url, current.filename, current.audioOnly);
      status('Saved', 'done');
      return;
    } catch (e) {
      const msg = (e && e.message) || '';
      const recoverable = msg === 'empty' || msg.startsWith('http ');
      if (!recoverable) {                       // blocked in-page (e.g. CORS) — browser can still do it
        browserDownload(current.url, current.filename, current.audioOnly);
        return;
      }
      log('fail', 'the file came back empty — switching helper');
      if (!current.serverUrl) break;            // direct link: nothing to switch to
      duds.add(current.serverUrl);
      status('Trying another way…');
      // second empty in a row: the quality itself is probably the blocked
      // path, so step down a notch as well as switching to the relay
      if (attempt >= 1 && !opts.audioOnly && LOWER[opts.quality]) {
        opts.quality = LOWER[opts.quality];
        log('try', 'stepping down to ' + opts.quality + 'p for a fresh copy');
      }
      try {
        current = await resolve(el.url.value.trim(), { ...opts, preferProxy: true }, duds);
      } catch { break; }
    }
  }

  status("Couldn't get a working copy", 'fail');
  el.progress.hidden = true;
  const isYT = platformOf(el.url.value.trim()) === 'youtube';
  showError(
    '<b>Can\'t download this one.</b>' +
    (isYT ? '<p>YouTube is blocking it right now. The same link often works later.</p>'
          : '<p>Try again in a few minutes.</p>') +
    '<p><button id="retryBtn" class="ghost" type="button">Try again</button></p>'
  );
  const rb = $('retryBtn');
  if (rb) rb.onclick = () => run(el.url.value.trim());
}

/* Picker items download directly; an empty one just reports, never saves. */
function pickerSave(fileUrl, filename, isAudio) {
  downloadFile(fileUrl, filename, isAudio).catch((e) => {
    if ((e && e.message) === 'empty') {
      el.progressTxt.textContent = 'That one was empty — try another item';
    } else {
      browserDownload(fileUrl, filename, isAudio);
    }
  });
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
  el.card.hidden = false;
  el.title.textContent = 'Looking it up…';
  el.source.textContent = platformOf(url);
  el.fileinfo.textContent = '';
  el.thumb.textContent = platformOf(url).slice(0, 1).toUpperCase();
  status('Finding your video…');

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
    remember(url, direct.filename);
    return;
  }

  loadPreview(url); // fire and forget

  const opts = { quality: el.quality.value, audioOnly: el.format.value === 'audio' };

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
    showError(
      '<b>Can\'t download this one.</b>' +
      '<p>Check the link opens normally — private and deleted posts can\'t be saved.</p>' +
      '<p><button id="retryBtn" class="ghost" type="button">Try again</button></p>'
    );
    const rb = $('retryBtn');
    if (rb) rb.onclick = () => {
      servers.forEach((s) => { if (s.state === 'down') s.state = 'unknown'; });
      probeAll();
      run(url);
    };
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
    b.onclick = () => pickerSave(item.url, `ashgrab-${i + 1}.${item.type === 'photo' ? 'jpg' : 'mp4'}`, false);
    el.pickerGrid.appendChild(b);
  });
  if (res.audio) {
    const b = document.createElement('button');
    b.className = 'pick';
    b.type = 'button';
    b.innerHTML = NOTE_SVG + '<span>audio track</span>';
    b.onclick = () => pickerSave(res.audio, 'ashgrab-audio.mp3', true);
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

/* There is no "go" button: a link in the box is the instruction. Wait for
   typing to settle so a half-typed address never starts a lookup. */
let autoTimer = null;
let autoLast = '';
el.url.addEventListener('input', () => {
  clearTimeout(autoTimer);
  const v = el.url.value.trim();
  if (v === autoLast) return;
  if (!/^https?:\/\/[^\s.]+\.[^\s]{2,}/i.test(v)) return;
  autoTimer = setTimeout(() => {
    if (el.url.value.trim() !== v) return;
    autoLast = v;
    run(v);
  }, 650);
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

el.dl.addEventListener('click', async () => {
  if (!current) return;
  el.dl.disabled = true;
  try { await grabAndSave(); } finally { el.dl.disabled = false; }
});

// changing quality / format invalidates the resolved link
[el.quality, el.format].forEach((n) =>
  n.addEventListener('change', () => {
    if (el.url.value.trim() && current) run(el.url.value.trim());
  })
);

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

/* shortcut helper screen */
const shortcutSheet = $('shortcutSheet');
/* Reassigned by the shortcut builder below when the mode changes, so the copy
   button always hands over the address that matches what's on screen. */
let shareBase = new URL('.', location.href).href + '?url=';
$('shortcutTemplate').textContent = shareBase;
$('shortcutBtn').addEventListener('click', () => { shortcutSheet.hidden = false; });
$('closeShortcut').addEventListener('click', () => { shortcutSheet.hidden = true; });
shortcutSheet.addEventListener('click', (e) => { if (e.target === shortcutSheet) shortcutSheet.hidden = true; });
$('copyTemplate').addEventListener('click', async () => {
  // only the label changes — the button carries an icon alongside it
  const label = $('copyLabel');
  try {
    await navigator.clipboard.writeText(shareBase);
    label.textContent = 'Copied ✓';
  } catch {
    // clipboard blocked: select the text so a long-press copy works
    const range = document.createRange();
    range.selectNodeContents($('shortcutTemplate'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    label.textContent = 'Hold the link above to copy';
  }
  setTimeout(() => (label.textContent = 'Copy my link'), 2500);
});

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
  if (e.key === 'Escape') { closeSheet(); infoSheet.hidden = true; shortcutSheet.hidden = true; }
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

/* ==========================================================================
 * Interface layer
 *
 * Everything below is presentation: the pill controls that stand in front of
 * the <select> elements, the appearance switch, and the Shortcuts builder.
 * The selects remain the source of truth, so the engine above is untouched.
 * ========================================================================== */

/* ------------------------------------------------------------------ haptics */

/* Browsers reject vibration before the page has been touched, so wait for a
   real gesture rather than letting the console fill with warnings. */
let gestured = false;
['pointerdown', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, () => { gestured = true; }, { once: true, passive: true }));

function tap(ms = 8) {
  if (!gestured || !navigator.vibrate) return;
  try { navigator.vibrate(ms); } catch { /* not supported */ }
}

/* -------------------------------------------------------------------- toast */

function toast(message) {
  const host = $('toastHost');
  if (!host) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, 2400);
}

/* --------------------------------------------------------- segmented control */

/* Slides the white thumb under the selected tab and reports the new value. */
function initSegment(box, onChange) {
  if (!box) return { select() {} };
  const thumb = box.querySelector('.thumb');
  const tabs = [...box.querySelectorAll('button')];

  function place(animated = true) {
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    if (!thumb || !active || !active.offsetWidth) return;
    if (!animated) thumb.style.transition = 'none';
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + (active.offsetLeft - 2) + 'px)';
    if (!animated) requestAnimationFrame(() => { thumb.style.transition = ''; });
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    if (tab.getAttribute('aria-selected') === 'true') return;
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    place();
    tap();
    if (onChange) onChange(tab.dataset.value);
  }));

  const relayout = () => place(false);
  window.addEventListener('resize', relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
  requestAnimationFrame(relayout);

  return {
    relayout,
    select(value) {
      const target = tabs.find((t) => t.dataset.value === value);
      if (!target || target.getAttribute('aria-selected') === 'true') return;
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === target)));
      place(false);
    }
  };
}

/* Format and quality drive the hidden selects, so changing either still runs
   the existing "re-resolve on change" logic. */
initSegment($('formatSeg'), (value) => {
  el.format.value = value;
  el.format.dispatchEvent(new Event('change'));
  const audio = value === 'audio';
  $('qualityRow').hidden = audio;
});

$('qualityChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  [...$('qualityChips').children].forEach((c) =>
    c.setAttribute('aria-pressed', String(c === chip)));
  el.quality.value = chip.dataset.value;
  el.quality.dispatchEvent(new Event('change'));
  tap();
});

/* ---------------------------------------------------------------- appearance */

function applyTheme(value) {
  document.documentElement.setAttribute('data-theme', value);
  settings.theme = value;
  saveSettings();
}

const themeSeg = initSegment($('themeSeg'), (value) => {
  applyTheme(value);
  toast(value === 'auto' ? 'Appearance follows your device'
      : value === 'light' ? 'Light appearance' : 'Dark appearance');
});

applyTheme(settings.theme || 'auto');
themeSeg.select(settings.theme || 'auto');

$('themeBtn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(settings.theme || 'auto') + 1) % order.length];
  applyTheme(next);
  themeSeg.select(next);
  toast(next === 'auto' ? 'Appearance follows your device'
      : next === 'light' ? 'Light appearance' : 'Dark appearance');
  tap();
});

/* ----------------------------------------------------------- shortcut builder */

const shortcut = { mode: 'ask' };

/* The address the shortcut opens. `url` is last so the shared link is simply
   appended — which is also what makes the hand-built version a single paste. */
function shortcutBase() {
  const root = new URL('.', location.href).href;
  const parts = [];
  if (shortcut.mode !== 'ask') parts.push('mode=' + shortcut.mode);
  parts.push('url=');
  return root + '?' + parts.join('&');
}

function renderShortcut() {
  shareBase = shortcutBase();               // the copy button reads this
  $('shortcutTemplate').textContent = shareBase;
}

initSegment($('scModeSeg'), (value) => { shortcut.mode = value; renderShortcut(); });
renderShortcut();

/* iOS only imports shortcuts Apple has signed, and every signing route runs
   through an Apple account: `shortcuts sign` refuses on a Mac that isn't
   signed into iCloud (verified on a CI runner — "you must be signed into
   iCloud"), so a repo cannot sign its own shortcut. The one sanctioned path
   is the one every shortcut-sharing site uses: build it once on a real
   iPhone, share it to iCloud — Apple signs it at that moment — and publish
   the resulting icloud.com/shortcuts link here. Until then the guided build
   below carries it. */
const ICLOUD_SHORTCUT = '';

if (ICLOUD_SHORTCUT) {
  $('scInstant').href = ICLOUD_SHORTCUT;
  $('scInstantWrap').hidden = false;
  $('scBuildHead').textContent = 'iPhone — or build it yourself';
}

/* Android and desktop can install the app properly; the browser tells us when. */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const wrap = $('installWrap');
  if (wrap) wrap.hidden = false;
});
const installBtn = $('installBtn');
if (installBtn) installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const choice = await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  if (choice && choice.outcome === 'accepted') {
    $('installWrap').hidden = true;
    toast('Installed — it\'s on your home screen');
  }
});

/* Segmented controls inside a sheet have no width until the sheet is shown,
   so re-measure the thumb whenever one opens. */
new MutationObserver(() => {
  if (!shortcutSheet.hidden || !el.sheet.hidden) {
    document.querySelectorAll('.sheet .seg').forEach((box) => {
      const thumb = box.querySelector('.thumb');
      const active = box.querySelector('button[aria-selected="true"]');
      if (!thumb || !active || !active.offsetWidth) return;
      thumb.style.transition = 'none';
      thumb.style.width = active.offsetWidth + 'px';
      thumb.style.transform = 'translateX(' + (active.offsetLeft - 2) + 'px)';
      requestAnimationFrame(() => { thumb.style.transition = ''; });
    });
  }
}).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });

/* hooks for the test suite */
window.__ashgrab = { cleanUrl, extractUrl, directFile, shortcutBase };
