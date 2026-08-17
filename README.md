# Snagr

**Paste a link. Get the video.**

A dead-simple web app: paste any video URL, see a small thumbnail, press Download.
One box, one button, works for most video sites — YouTube, Instagram, TikTok, Facebook,
X/Twitter, Reddit, Threads, Snapchat, Vimeo, Twitch clips, Pinterest, Bluesky, SoundCloud,
Dailymotion, Tumblr, VK, Bilibili, Loom, Streamable and more.

👉 **Live:** https://attaullahsher.github.io/snagr/

No account, no ads, no tracking, nothing stored on a server. It's a static page —
everything happens in your browser.

---

## How it works

A browser tab cannot rip video out of YouTube or Instagram on its own — those sites hand
out obfuscated, region-locked, short-lived stream URLs, and browser CORS rules block a
static page from touching them. Every "universal downloader" needs a backend that does the
extraction.

Snagr is the front end. The extraction is done by
[**cobalt**](https://github.com/imputnet/cobalt) — an open-source, no-logs downloader
server. Snagr talks to a list of cobalt servers, and to **your own** if you run one.

```
you → snagr (github pages, static) → a cobalt server → the video file → your device
```

## The fallback engine

The interesting part. A single request failing does not mean the link is undownloadable —
usually one specific server, quality, or codec path is having a bad day. So Snagr never
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

Servers are health-checked when the page loads and sorted **fastest-healthy-first**, so the
usual case is a single fast request. Your own server, if configured, is always tried first.

The download itself has fallbacks too: stream into a blob with a live progress bar and a
proper filename → if that's blocked, a native `download` link → if that's blocked, open in
a new tab.

Every attempt is visible — tap the status line to expand the log and see exactly what was
tried and why it failed.

## Also handles

- **Carousels / albums** (Instagram, Twitter, Reddit galleries) → picker grid, download items individually
- **Audio only** → mp3 checkbox
- **Quality choice** → best / 1080 / 720 / 480 / 360
- **`?url=` parameter** → `https://attaullahsher.github.io/snagr/?url=<link>` resolves immediately, so it works as a bookmarklet or Android share target
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

Put it behind HTTPS (Caddy/nginx), then open Snagr → ⚙️ Settings → paste the address.
It gets pinned to the top of the list and tried first, forever (saved in your browser).

Full guide: [cobalt run-an-instance docs](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)

## Editing the server list

`assets/servers.json` — top to bottom is the starting order, re-sorted at runtime by health
and latency. Add or remove entries and redeploy; no code changes needed.

## Deploying

Push to `main`. The workflow in `.github/workflows/pages.yml` publishes the repo root to
GitHub Pages. One-time setup: **Settings → Pages → Source: GitHub Actions**.

No build step, no dependencies, no framework. Three files do the work:

```
index.html          markup
assets/style.css    styling
assets/app.js       strategy engine + download
assets/servers.json backend list
```

## Legal

Snagr is a client for a public open-source API. Download only what you have the right to
download — your own uploads, licensed material, or content whose license permits it.
Respect each platform's terms of service and creators' copyright. You are responsible for
what you download.

## Credits

Built by Asher. Extraction by [cobalt](https://github.com/imputnet/cobalt) (AGPL-3.0),
which does the genuinely hard part.
