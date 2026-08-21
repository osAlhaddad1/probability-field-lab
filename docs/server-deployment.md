# Deploying to the OVH VPS

This app is the second tenant on the VPS: its own port, its own `sslip.io`
hostname, its own directory under `/srv/apps/`, its own GHCR image. Nothing is
shared with iTenderExpert.

| Setting | Value |
| --- | --- |
| Port (loopback only) | `127.0.0.1:8774` |
| Hostname | `lab.92.222.82.179.sslip.io` |
| App directory | `/srv/apps/probability-field-lab` |
| Data directory | `/srv/apps/probability-field-lab/data` (bind mount, uid 10001) |
| Container | `probability-field-lab` |
| Image | `ghcr.io/<owner>/probability-field-lab:<commit-sha>` |

Claim 8774 in `infra/PORTS.md` in the iTenderExpert repo in the same change that
lands this one — that file is the port registry for the whole box.

## Flow

Push to `main` → GitHub builds the JAR, smoke-tests it, builds the image and
pushes it to GHCR → the `production` environment gates the deploy → SSH to the
VPS, `docker compose pull && up -d` with `IMAGE` pinned to the commit SHA → wait
for the container healthcheck; if it never goes green, the previous image is put
back and the job fails. Nothing is ever built on the server.

## One-time server setup

From Git Bash on the desktop, with the agent loaded:

```bash
ssh-agent -a /tmp/itender-agent.sock; SSH_AUTH_SOCK=/tmp/itender-agent.sock ssh-add ~/.ssh/ovh_personal
```

Create the directories as `ubuntu` (full sudo), then hand them to `deploy`. The
data directory must be owned by uid 10001 — the uid the container runs as —
or the app dies writing to `/data`:

```bash
SSH_AUTH_SOCK=/tmp/itender-agent.sock ssh itender-ubuntu '
  sudo mkdir -p /srv/apps/probability-field-lab/data
  sudo chown deploy:deploy /srv/apps/probability-field-lab
  sudo chown -R 10001:10001 /srv/apps/probability-field-lab/data
'
```

Add the site to `/srv/proxy/Caddyfile`. That directory is not a git checkout —
it holds the Caddyfile, `docker-compose.yml` and `.env` and is edited on the box
— so this is the one place the no-manual-edits rule does not apply. Match the
house style of the `monitor.` and `metrics.` blocks:

```
# Probability Field Lab.
lab.92.222.82.179.sslip.io {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		-Server
	}

	reverse_proxy 127.0.0.1:8774
}
```

Validate before reloading — a bad Caddyfile would affect every app on the box,
though Caddy keeps the running config if the new one does not parse:

```bash
SSH_AUTH_SOCK=/tmp/itender-agent.sock ssh itender 'docker compose -f /srv/proxy/docker-compose.yml exec caddy caddy validate --config /etc/caddy/Caddyfile'
SSH_AUTH_SOCK=/tmp/itender-agent.sock ssh itender 'docker compose -f /srv/proxy/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile'
```

`sslip.io` resolves the hostname to the IP with no DNS work, so Let's Encrypt
issues the certificate on first request.

## GitHub configuration

Environment `production` (Settings → Environments), with required reviewers if
you want a manual gate:

| Secret | Value |
| --- | --- |
| `VPS_HOST` | `92.222.82.179` |
| `VPS_USER` | `deploy` |
| `VPS_APP_DIR` | `/srv/apps/probability-field-lab` |
| `VPS_SSH_KEY` | Private half of `~/.ssh/itender_deploy` (already authorized for `deploy`) |
| `GHCR_TOKEN` | PAT with `read:packages`, used by the server to pull |
| `VPS_KNOWN_HOSTS` | Optional. `ssh-keyscan 92.222.82.179`. Without it the workflow keyscans at deploy time, which trusts on first use. |

The image itself is pushed with the built-in `GITHUB_TOKEN`, so no extra write
credential is needed. The deploy job checks all five secrets are non-empty
before touching the server — empty secrets otherwise expand to nothing and fail
with a message that names nobody.

## Notes for this stack

- The container publishes on `127.0.0.1:8774` only. Docker bypasses UFW for
  published ports, so never drop the loopback bind.
- `./data:/data` is a bind mount on purpose: `docker compose down -v` cannot
  destroy it. It holds `runs/`, `sweeps/`, and `trash/` JSON.
- `.env` on the server is written by the deploy script and holds nothing but
  `IMAGE=`. If you ever add a secret with a `$` in it, double it to `$$` —
  Compose eats single `$` silently.
- `mem_limit: 512m` with `-XX:MaxRAMPercentage=75` keeps the JVM inside its
  share of the 4 GB box.

## Operating

```bash
SSH_AUTH_SOCK=/tmp/itender-agent.sock ssh itender 'docker compose -f /srv/apps/probability-field-lab/compose.yml logs -f --tail 100'
```

Roll back manually by editing `IMAGE=` in
`/srv/apps/probability-field-lab/.env` to an older SHA tag and running
`docker compose up -d` — or just re-run the workflow on the good commit.
