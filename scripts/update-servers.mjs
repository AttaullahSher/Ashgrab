/* Refreshes assets/servers.json from the public cobalt instance tracker
   (instances.cobalt.best). Run weekly by .github/workflows/update-servers.yml
   so the app keeps working even when individual public servers die.

   Fail-safe by design: any fetch/parse problem leaves the existing list
   untouched and exits 0 — a bad week must never break the deployed list. */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'assets/servers.json';
const TRACKER = 'https://instances.cobalt.best/api/instances.json';

// Always kept, always first: known-good CORS-open instances.
const PINNED = [
  { url: 'https://co.otomir23.me/', label: 'otomir23' },
  { url: 'https://cobalt-api.kwiatekmiki.com/', label: 'kwiatekmiki' }
];

const MAX_SERVERS = 10;

function normalize(u) {
  return u.endsWith('/') ? u : u + '/';
}

let existing = { servers: [] };
try {
  existing = JSON.parse(readFileSync(FILE, 'utf8'));
} catch { /* first run */ }

let tracked = [];
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch(TRACKER, {
    signal: ctrl.signal,
    headers: { 'User-Agent': 'ashgrab-server-refresh (github.com/AttaullahSher/Ashgrab)' }
  });
  clearTimeout(timer);
  if (!res.ok) throw new Error('http ' + res.status);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : data.instances || [];

  // The tracker's schema has shifted over time — read every field defensively.
  tracked = rows
    .map((e) => {
      const api = e.api || e.api_url || '';
      if (!api) return null;
      const url = api.startsWith('http') ? normalize(api) : `https://${api}/`;
      if (!url.startsWith('https://')) return null;
      const online = e.online && typeof e.online === 'object' ? e.online.api !== false
        : e.api_online !== undefined ? !!e.api_online
        : true;
      if (!online) return null;
      if ('cors' in e && !(e.cors === 1 || e.cors === true)) return null;
      if (e.turnstile === true) return null; // unusable from a static page without a key
      const score = Number(e.score ?? e.trust ?? 0) || 0;
      const services = e.services && typeof e.services === 'object'
        ? Object.values(e.services).filter(Boolean).length : 0;
      const label = (e.name || new URL(url).hostname.split('.')[0]).slice(0, 24);
      return { url, label, score, services };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.services - a.services);
} catch (err) {
  console.log(`tracker unavailable (${err.message}) — keeping the existing list`);
  process.exit(0);
}

const seen = new Set();
const merged = [];
for (const s of [...PINNED, ...tracked.map(({ url, label }) => ({ url, label }))]) {
  const key = normalize(s.url);
  if (seen.has(key)) continue;
  seen.add(key);
  merged.push({ url: key, label: s.label });
  if (merged.length >= MAX_SERVERS) break;
}

if (merged.length < 2) {
  console.log('tracker returned too little — keeping the existing list');
  process.exit(0);
}

const out = {
  note: 'Cobalt-compatible backends, tried top to bottom; the app re-sorts by live health. Refreshed weekly from instances.cobalt.best by .github/workflows/update-servers.yml. Add your own in the app settings, or edit here and redeploy.',
  updated: new Date().toISOString().slice(0, 10),
  servers: merged
};

writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${merged.length} servers:`);
for (const s of merged) console.log(`  ${s.label.padEnd(24)} ${s.url}`);
