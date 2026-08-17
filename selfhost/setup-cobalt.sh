#!/usr/bin/env bash
# One-command private helper server for Ashgrab.
#
# Why: the free public helpers are shared, rate-limited and blocked by YouTube
# most of the time. Your own server is none of those things. This script was
# written for Ubuntu 22.04/24.04 on any small VPS — including an Oracle Cloud
# Always Free ARM instance — and takes a few minutes.
#
# Before running: open TCP 80 and 443 in your cloud firewall (on Oracle,
# that's an ingress rule in the VCN security list; this script handles the
# instance's own iptables by itself).
#
# Run — no arguments needed:
#   sudo bash setup-cobalt.sh
# It uses <your-ip>.sslip.io, a free name that always points at this server,
# so there is no DNS to configure. Prefer your own domain? Point an A record
# at the server first, then:
#   sudo bash setup-cobalt.sh dl.example.com you@example.com
#
# Afterwards: open Ashgrab -> Settings -> "Your own server" and paste the
# address the script prints at the end - done. It is pinned first and tried
# before any public helper, forever.

set -euo pipefail

# Both arguments are OPTIONAL.
#   No arguments  -> uses <your-ip>.sslip.io, a free name that always points
#                    at this server, so no DNS setup is needed at all.
#   With a domain -> sudo bash setup-cobalt.sh dl.example.com you@example.com
DOMAIN="${1:-}"
EMAIL="${2:-}"

if [ -z "$DOMAIN" ]; then
  PUB_IP=$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)
  [ -n "$PUB_IP" ] || { echo "could not detect the public IP — pass a domain instead" >&2; exit 1; }
  DOMAIN="${PUB_IP}.sslip.io"
  echo "==> No domain given — using ${DOMAIN} (no DNS setup needed)"
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "run me with sudo" >&2
  exit 1
fi

# --- Oracle instances from the owner's VPN project: SSH also listens on 443 -
# Caddy needs that port. Remove the alt-port drop-ins (port 22 SSH keeps
# working; make sure THIS session is on port 22 before continuing).
if [ -f /etc/systemd/system/ssh.socket.d/99-alt-port.conf ] || [ -f /etc/ssh/sshd_config.d/99-alt-port.conf ]; then
  echo "==> Freeing port 443 (it is currently a spare SSH port)"
  echo "    Your normal port-22 SSH is untouched."
  rm -f /etc/systemd/system/ssh.socket.d/99-alt-port.conf
  rm -f /etc/ssh/sshd_config.d/99-alt-port.conf
  systemctl daemon-reload
  systemctl restart ssh.socket 2>/dev/null || true
  systemctl restart ssh 2>/dev/null || true
fi

# --- Oracle's Ubuntu image ends its firewall in a blanket REJECT, so web
# ports must be ACCEPTed at the TOP of the chain; appending is not enough.
echo "==> Opening ports 80 and 443 in the instance firewall"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save 2>/dev/null || true

echo "==> Installing Docker"
apt-get update -y
apt-get install -y docker.io docker-compose-v2 curl gnupg

echo "==> Installing Caddy (terminates HTTPS in front of cobalt)"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

echo "==> Starting cobalt"
mkdir -p /opt/cobalt
# If YouTube ever challenges even this server, export your YouTube cookies
# (any "cookies.txt" browser extension, Netscape format) to
# /opt/cobalt/cookies.json following cobalt's docs, then uncomment the two
# marked lines below and run:  docker compose -f /opt/cobalt/docker-compose.yml up -d
cat > /opt/cobalt/docker-compose.yml <<COMPOSE
services:
  cobalt:
    image: ghcr.io/imputnet/cobalt:11
    restart: unless-stopped
    ports:
      - "127.0.0.1:9000:9000"
    environment:
      API_URL: "https://${DOMAIN}/"
      # COOKIE_PATH: "/cookies.json"            # <- uncomment for YouTube cookies
    # volumes:
    #   - /opt/cobalt/cookies.json:/cookies.json  # <- uncomment for YouTube cookies
COMPOSE
docker compose -f /opt/cobalt/docker-compose.yml up -d

echo "==> Pointing Caddy at it"
{
  echo "{"
  if [ -n "$EMAIL" ]; then echo "	email ${EMAIL}"; fi
  echo "}"
  echo ""
  echo "${DOMAIN} {"
  echo "	reverse_proxy 127.0.0.1:9000"
  echo "}"
} > /etc/caddy/Caddyfile
systemctl restart caddy

echo "==> Waiting for the certificate and a healthy reply"
for i in $(seq 1 30); do
  if curl -fsS "https://${DOMAIN}/" | grep -q cobalt; then
    echo
    echo "All good. Your private helper is live:"
    echo
    echo "    https://${DOMAIN}/"
    echo
    echo "Paste that into Ashgrab -> Settings -> 'Your own server'."
    exit 0
  fi
  sleep 5
done

echo "cobalt is running but https://${DOMAIN}/ isn't answering yet." >&2
echo "Usual causes: DNS not propagated, or ports 80/443 not open end-to-end." >&2
echo "Check: docker logs cobalt-cobalt-1   and   journalctl -u caddy -n 50" >&2
exit 1
