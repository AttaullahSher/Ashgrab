# Get your own download engine

Ashgrab is a web page. It cannot pull video out of YouTube by itself — no web
page can. It asks a small server (an "engine") to do that part.

Right now it asks free public engines that thousands of people share. YouTube
blocks them constantly. That is the whole reason downloads fail. Sites like
ytdown.to work because they run their **own** engine. This gives you yours.

Two ways. Pick one.

---

## Way 1 — No terminal, ~5 minutes (recommended)

You click buttons on a website. Nothing is installed on your computer.

**1. Make a free Render account**

Go to **https://dashboard.render.com/register** and sign up with GitHub
(fastest — one button).

**2. Create the engine from this repository**

Go to **https://dashboard.render.com/select-repo?type=blueprint**

- Find and pick **AttaullahSher/Ashgrab** in the list
- (If it isn't listed, click *Configure account* / *Connect GitHub* and allow
  Render to see your repositories, then come back)
- Name it anything, e.g. `ashgrab`
- Click **Apply** / **Create new resources**

Render reads [`render.yaml`](../render.yaml) from the repo and builds
everything itself. Wait 2–5 minutes for the status to go green.

**3. Copy your engine's address**

At the top of the service page Render shows an address like:

```
https://ashgrab-engine.onrender.com
```

Copy it.

**4. Check the name matches**

Click **Environment** in the left sidebar. Look at `API_URL`.
It must be exactly the address from step 3, **with a slash on the end**:

```
https://ashgrab-engine.onrender.com/
```

If it differs (Render sometimes adds characters to make the name unique), fix
it, click **Save changes**, and let it redeploy.

**5. Tell Ashgrab**

Open Ashgrab → **Settings** → paste the address into **Your own server** →
close. That's it. It is tried first, before any public engine, forever.

**Worth knowing:** the free plan sleeps after 15 minutes idle, so the first
download after a break takes ~50 seconds to wake up. Every one after that is
instant. Upgrading to Render's paid Starter plan removes the sleeping.

---

## Way 2 — Your own VPS (Oracle, or any Ubuntu server)

If you already have a server and can SSH into it:

```bash
curl -fsSL https://attaullahsher.github.io/Ashgrab/selfhost/setup-cobalt.sh -o setup.sh
sudo bash setup.sh
```

No domain needed — it gives itself a free address and an HTTPS certificate,
then prints the address to paste into Settings.

On Oracle Cloud, first add one ingress rule so the internet can reach it:
Console → *Networking* → *Virtual Cloud Networks* → your VCN → *Security
Lists* → *Default* → **Add Ingress Rule** → Source `0.0.0.0/0`, Protocol
`TCP`, Destination Port `80`. (443 is already open if you set up the VPN.)

---

## If YouTube still blocks your own engine

Datacenter addresses — Render's, Oracle's, anyone's — sometimes get blocked
too. The cure is to let your engine sign in to YouTube, which is exactly what
the commercial downloader sites do:

1. Install a "cookies.txt" extension in your browser
2. Sign in to YouTube, export cookies for `youtube.com`
3. Convert to cobalt's format and give it to your engine:
   - **Render:** add a Secret File named `cookies.json`, then set the
     environment variable `COOKIE_PATH` to `/etc/secrets/cookies.json`
   - **VPS:** put the file at `/opt/cobalt/cookies.json` and uncomment the two
     marked lines in `/opt/cobalt/docker-compose.yml`, then
     `docker compose -f /opt/cobalt/docker-compose.yml up -d`

Full details: https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md

---

## Nothing to set up at all?

If you don't want an engine: TikTok, Instagram, X, Reddit and most other sites
work fine on the free public engines. It is specifically YouTube that fights
back. For a stubborn YouTube link, the **Open cobalt.tools** button on the
error message opens the official site, which can show YouTube's bot check to
you directly — something a page like Ashgrab can never do on its own.
