# Working agreements for this repository

## Ship immediately

The maintainer's standing instruction is **merge and deploy always**: once a
change is verified, merge it to `master` and let it deploy — do not leave PRs
open waiting for approval. Pushing to `master` deploys the site via
`.github/workflows/pages.yml`, so a merge *is* a deploy; after merging, confirm
the change is actually live on https://attaullahsher.github.io/Ashgrab/ before
calling it done.

Verified means driven in a real browser (the engine can be pointed at a mock
Cobalt backend via the custom-server setting), not eyeballed. Measure layout
claims with getBBox/getBoundingClientRect rather than judging screenshots.

## What this app is

A static front end for Cobalt-compatible backends. `assets/app.js` is two
layers: the resolver/strategy engine at the top (servers × strategies grid,
empty-file rescue, picker, history) and the presentation layer at the bottom
(pill controls, appearance switch, Shortcut helper). The `<select>` elements
(`#format`, `#quality`) are the engine's source of truth — UI controls drive
them and dispatch `change`; never bypass them.

## Hard-won facts — do not relearn these

- iOS refuses unsigned `.shortcut` files, and `shortcuts sign` requires an
  iCloud-signed-in Mac (proven on a macOS CI runner: "you must be signed into
  iCloud"). A repo cannot sign its own shortcut. The only one-tap route is an
  iCloud link shared from a real iPhone, pasted into `ICLOUD_SHORTCUT` at the
  bottom of `assets/app.js`.
- YouTube blocks most public Cobalt instances' addresses: resolves succeed but
  the stream is empty. The relay route (`alwaysProxy`) rescues some; the real
  fix is a self-hosted instance.
- YouTube also blocks **per-video**: verified 2026-08-17 with youtu.be/4IfRgovQGtk
  against the one live helper — tunnel accepted, zero bytes on every route
  (all qualities, direct, relay, even audio-only), while an older video
  delivered fine through the same helper minutes earlier. No client-side
  retry ladder can fix that class of block; do not try. If a self-hosted
  instance still hits it, cobalt supports feeding it YouTube cookies/session
  tokens — that is the lever, server-side.
- `assets/servers.json` is rewritten weekly by `update-servers.yml` — keep
  pinned entries in `scripts/update-servers.mjs`, not in the JSON.
- Bump the `sw.js` cache name whenever the shell files change, or returning
  visitors keep the old version.
