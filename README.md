# Ashgrab

**Paste a link. Grab the video.**

A dead-simple web app: paste any video URL, see a small thumbnail, press Download.
One box, one button, works for most video sites — YouTube, Instagram, TikTok, Facebook,
X/Twitter, Reddit, Threads, Snapchat, Vimeo, Twitch clips, Pinterest, Bluesky, SoundCloud,
Dailymotion, Tumblr, VK, Bilibili, Loom, Streamable and more.

👉 **Live:** https://attaullahsher.github.io/Ashgrab/

No account, no ads, no tracking, nothing stored on a server. It's a static page —
everything happens in your browser.

---

## How it works

A browser tab cannot rip video out of YouTube or Instagram on its own — those sites hand
out obfuscated, region-locked, short-lived stream URLs, and browser CORS rules block a
static page from touching them. Every "universal downloader" needs a backend that does the
extraction.

Ashgrab is the front end. The extraction is done by
[**cobalt**](https://github.com/imputnet/cobalt) — an open-source, no-logs downloader
server. Ashgrab talks to a list of cobalt servers, and to **your own** if you run one.

```
you → ashgrab (github pages, static) → a cobalt server → the video file → your device
```

## The fallback engine

The interesting part. A single request failing does not mean the link is undownloadable —
usually one specific server, quality, or codec path is having a bad day. So Ashgrab never
gives up after one try. It walks a grid of **servers × strategies**:

| Strategy | What it changes | Fixes |
|---|---|---|
| standard | h264, requested quality | — |
| proxied | routes bytes through the server (`alwaysProxy`) | region blocks, dead direct links, CORS |
| lower quality | steps 1080 → 720 → 480 | "quality not available", timeouts on huge files |
| vp9 / HLS | different extraction path entirely | YouTube throttling and signature breakage |
| legacy API | old cobalt v7 request shape | older/unmaintained servers |
| audio rescue | grabs the audio track | video genuinely gone, last resort only |

On top of that it reads the failure and reacts instead of blindly retrying:

- **needs an API key / turnstile** → that whole server is skipped, immediately
- **rate limited** → stop hammering it, jump to the next server
- **unsupported / invalid link** → knob-twiddling won't help; jump straight to the legacy API, then the next server
- **timeout or network error** → next strategy, then next server

Servers are health-checked when the page loads and sorted **fastest-healthy-first**, and the
first request is **raced** across the two fastest healthy servers — whichever answers first
wins. The server that delivered last time is remembered and tried early next time. Your own
server, if configured, is always tried first.

The download itself has fallbacks too: stream into a blob with a live progress bar and a
proper filename → if that's blocked, a native `download` link → if that's blocked, open in
a new tab.

Every attempt is visible — tap the status line to expand the log and see exactly what was
tried and why it failed.

## Also handles

- **Messy input** — paste anywhere on the page (no need to click the box first), drop a
  link onto it, or paste whole sentences: the first URL is pulled out automatically.
  Tracking junk (`utm_*`, `fbclid`, `igsh`, `si`, …) is stripped and facebook/google
  redirect wrappers are unwrapped before the link is sent anywhere.
- **Direct file links** — a URL that already ends in `.mp4`/`.mp3`/`.jpg` skips the
  servers entirely and downloads straight away
- **Carousels / albums** (Instagram, Twitter, Reddit galleries) → picker grid, download items individually
- **Audio only** → Video/Music segmented control · **Quality** → best / 1080 / 720 / 480 / 360
- **Recent links** — your last 8 grabs, one tap to re-grab (stored only in your browser)
- **Installable PWA** — add to home screen on Android and Ashgrab appears in the system
  **share sheet**: share a video from any app straight into it. Works offline as a shell.
- **iPhone share sheet** — iOS has no PWA share target, so Ashgrab builds you a Shortcut
  instead: pick what it should grab, tap once, and you get a real `.shortcut` file
  (a *URL Encode* → *Open URLs* pair, typed as an `ActionExtension`). The hand-built
  four-tap recipe is still there if you'd rather not install a file.
- **Light and dark** — follows the system, or pin it in Settings
- **`?url=` / `?text=` parameters** → `https://attaullahsher.github.io/Ashgrab/?url=<link>`
  resolves immediately (bookmarklets, share targets)
- **Phones** → single-column layout, big tap targets

---

## Run your own server (recommended)

Public servers are free, shared, and rate-limited — they will fail sometimes, and YouTube
in particular is blocked on many of them. Your own instance is unlimited, private, and
fast. Any small VPS with Docker:

```bash
docker run -d --name cobalt \
  -p 9000:9000 \
  -e API_URL="https://cobalt.yourdomain.com/" \
  --restart unless-stopped \
  ghcr.io/imputnet/cobalt:11
```

Put it behind HTTPS (Caddy/nginx), then open Ashgrab → ⚙️ Settings → paste the address.
It gets pinned to the top of the list and tried first, forever (saved in your browser).

Full guide: [cobalt run-an-instance docs](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)

## The server list keeps itself alive

Public cobalt instances come and go. Once a week,
`.github/workflows/update-servers.yml` runs `scripts/update-servers.mjs`: it pulls the
community [instance tracker](https://instances.cobalt.best), keeps the healthiest
CORS-open HTTPS instances, rewrites `assets/servers.json`, commits, and redeploys the
site — no human involved. If the tracker is down, the existing list is left untouched.
The weekly commit also stops GitHub from pausing the schedule for repo inactivity, so
the loop genuinely runs indefinitely.

You can still edit `assets/servers.json` by hand (pinned entries in
`scripts/update-servers.mjs` always survive the refresh), and trigger a refresh any time
from the Actions tab.

## Deploying

Push to `master`. The workflow in `.github/workflows/pages.yml` publishes the repo root to
GitHub Pages (it enables Pages by itself on first run).

No build step, no dependencies, no framework:

```
index.html                 markup
assets/style.css           styling
assets/app.js              strategy engine + download, then the interface layer
assets/servers.json        backend list (auto-refreshed weekly)
assets/favicon.svg         app mark — every png icon is rendered from this
manifest.json + sw.js      PWA: installable, share target, offline shell
scripts/update-servers.mjs weekly server-list refresh
```

The bottom of `app.js` is presentation only — the pill controls, the appearance
switch and the Shortcut builder. The `<select>` elements are still the source of
truth the engine reads, so the two halves stay independent.

## Legal

Ashgrab is a client for a public open-source API. Download only what you have the right to
download — your own uploads, licensed material, or content whose license permits it.
Respect each platform's terms of service and creators' copyright. You are responsible for
what you download.

## Credits

Built by Asher. Extraction by [cobalt](https://github.com/imputnet/cobalt) (AGPL-3.0),
which does the genuinely hard part.
