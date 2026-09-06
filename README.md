# home-dashboard

A custom frontend for the `ladybird` home server. Home Assistant stays the backend — this repo
replaces only the UI.

Companion to [`home-automation`](../home-automation), which holds the infrastructure for the same
host. Deployment lives there; the application lives here.

---

## Why it is built this way

Home Assistant's own frontend is just a client of HA's WebSocket API. Nothing stops a second
client, so this app is one:

- `get_states` for the initial snapshot, `subscribe_events` on `state_changed` for live push, and
  `call_service` to actuate. Everything HA's UI can show or do, this can too.
- The integration layer and automation engine stay in HA. Rewriting those means reimplementing
  hundreds of device protocols; rewriting the UI is a weekend.

Non-HA services are read from their own APIs where that gives more than the HA integration does
(Frigate) or where no integration is in play (Jellyfin, Uptime Kuma).

### The token never reaches the browser

An HA long-lived access token is full control of the house. A static SPA holding one means anyone
who loads the page — or reads the JS bundle — owns HA. So there is a small backend:

```
browser ──/api──> server (holds HA + Jellyfin tokens) ──> HA :8123
                                                     ├──> Frigate :5000
                                                     ├──> Jellyfin :8096
                                                     └──> Uptime Kuma :3001
```

The server also:

- fans one HA subscription out to every open tab, instead of one per browser;
- proxies camera stills, so the browser needs no route to the camera island and no knowledge of
  Frigate's unauthenticated port;
- enforces a **write allowlist** — `/api/action` refuses any entity not listed in a `controls`
  panel in `config/dashboard.json`. A compromised page cannot call arbitrary HA services.

**The dashboard itself has no login.** Anyone who can reach it can read every panel and
toggle the allowlisted entities. That is the same trust level as Frigate's unauthenticated API
already on that LAN — but it means this must stay behind Tailscale/LAN and must never be
port-forwarded.

---

## Layout

```
server/           Fastify backend (TypeScript, ESM)
  src/ha/         Home Assistant WebSocket client
  src/sources/    Frigate, Jellyfin, Uptime Kuma readers
  src/routes/     REST endpoints + the SSE stream
  src/snapshot.ts assembles the payload the browser renders
web/              Vite + React frontend
config/           dashboard.json — which panels exist, edited without a rebuild
```

`web/src/types.ts` is a hand-written mirror of the server payload. Change one, change the other.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness plus HA connection state |
| `GET /api/dashboard` | full snapshot: panels, entity states, service summaries |
| `GET /api/stream` | SSE — `snapshot`, `state`, `ha`, `sources` events |
| `POST /api/action` | `{entity_id, action}` where action is `turn_on`/`turn_off`/`toggle` |
| `GET /api/camera/:name/snapshot?h=360` | proxied Frigate still |

Server-sent events rather than a WebSocket: data only ever flows server → browser, and
`EventSource` reconnects on its own.

---

## Setup

Requires Node 22+.

```bash
npm install
cp .env.example .env
```

Then get an HA token: Home Assistant → your profile → Security → **Long-lived access tokens** →
Create token. Paste it into `.env` as `HA_TOKEN`.

Jellyfin's key comes from Dashboard → API Keys. Both are optional except `HA_*`; an unconfigured
service shows as "not configured" rather than breaking the page.

```bash
npm run dev
```

Backend on `:8099`, frontend on `:5173` with `/api` proxied to the backend. Open
<http://localhost:5173>.

Production build, served by the backend on `:8099` alone:

```bash
npm run build && npm start
```

## Configuring panels

`config/dashboard.json` — three panel types (`entities`, `controls`, `cameras`), validated at
startup so a typo fails loudly instead of rendering an empty box. Edit and restart; no rebuild. It
is mounted read-only in the container.

`controls` panels double as the write allowlist, so there is no second list to drift out of sync.

`cameras` panels render polled stills. Clicking one opens a full-screen viewer that asks the proxy
for a 1080px frame — the ceiling it allows — with pause, manual refresh, camera switching and real
browser fullscreen. Escape closes it; the arrow keys move between cameras.

The Services panel draws the largest filesystem Frigate reports as a used/free pie. Paths that share
a filesystem report identical figures, so they are grouped rather than charted twice; the small
tmpfs mounts stay as text.

Entity ids come from HA → Developer tools → States. The defaults use the storage-guard sensors and
`switch.frontcam_white_light` — the only working white-light control on the driveway camera.

## Deploying to ladybird

**Deployed and running** at <http://ladybird/> (also <http://192.168.0.13/>) since 2026-09-05, and
published on port **80** since 2026-09-06 so the bare hostname is enough.

The root `docker-compose.yml` here is for local testing only. On the server the deployment lives in
`home-automation` under `stacks/dash/`, so every compose file for that host stays in one repo — see
that repo's `docs/operations.md` for the runbook.

How it is laid out on the host:

| Path | What it is |
|---|---|
| `~thomas/src/home-dashboard` | build input only — plain source Docker reads to bake the image |
| `home-dashboard:local` | the built image; Node and both builds live inside it |
| `/opt/stacks/dash/docker-compose.yml` | the deployed stack definition |
| `/opt/stacks/dash/.env` | `HA_TOKEN` and friends, mode 600, gitignored |

There is no registry image and no git remote, so the source is copied over and built on the host:

```bash
# from a workstation, in this repo
git archive --format=tar HEAD > /tmp/hd.tar && scp /tmp/hd.tar thomas@192.168.0.13:/tmp/

# on the server
rm -rf ~/src/home-dashboard && mkdir -p ~/src/home-dashboard
tar -xf /tmp/hd.tar -C ~/src/home-dashboard
cd /opt/stacks/dash && docker compose up -d --build
```

Nothing runs from the source directory — the host has no Node installed at all. Deleting the
checkout does not stop the container; it only prevents the next rebuild.

`docker compose restart` does **not** reload `.env`. After changing a token use
`docker compose up -d --force-recreate`.

### Ports

Inside the container the server listens on `8099` (`PORT` in `.env.example`) and runs as the
non-root `node` user, which cannot bind ports below 1024. The host publishes that as port **80** —
the `"80:8099"` mapping in the compose file — so `http://ladybird/` needs no port number. Nothing
else on the host listens on 80. The name resolves through Tailscale MagicDNS on tailnet devices;
on the LAN without Tailscale use `http://ladybird.local/` (mDNS) or the IP.

---

## Verified in the container on ladybird (2026-09-05)

The image built clean on the host (Docker 29.7.2) and the container came up `healthy` on its own
`HEALTHCHECK`, running as the non-root `node` user with `restart: unless-stopped`. Docker is
enabled at boot, so it survives a reboot. Checked against the deployed container on `:8099`:

- **Frontend** served from the image at `/app/web/dist` — the page renders, and both camera panels
  show live stills.
- **Camera proxy** returned a real 45 KB `image/jpeg` (704×480) from `driveway`.
- **Frigate** reported both cameras and four storage mounts; the storage panel shows 97.7 GB used
  of 331.2 GB free.
- **Allowlists** still rejected an unlisted camera (404) and an unlisted entity (403) — this time
  through the published port.
- **SSE** delivered its opening `snapshot` frame.
- **Reachable** from the LAN and over Tailscale (`100.69.144.83:8099`).
- **Home Assistant connected** once a real token replaced the placeholder: `connected: true`,
  version **2026.8.3**, `authFailed: false`.
- **`get_states`** resolved all six configured entities with live values — none came back `unknown`
  or `unavailable`, so the entity ids taken from the `home-automation` notes were all correct.
- **`subscribe_events`** is pushing: the storage sensors carry `just now` timestamps that advance
  without a reload, which is state arriving over the subscription rather than the opening snapshot.

---

## Verified against the live server (2026-09-04)

Run against ladybird with a deliberately invalid HA token:

- **Frigate 0.17.2** — `/api/stats` parsed correctly: both cameras at 5 fps, detector `ov` at 10 ms,
  four storage mounts. The camera proxy returned a real 16 KB JPEG from `driveway`.
- **HA auth failure** surfaced as `authFailed: true` with HA's own message, and backed off instead
  of hammering the socket.
- **Allowlists** rejected an unlisted camera (404) and an unlisted entity (403).
- **SSE** delivered its opening `snapshot` frame.

Not yet verified, and why:

- **`call_service`.** The one HA path still unexercised. The only allowlisted control is
  `switch.frontcam_white_light`, so testing it means physically switching on the driveway
  floodlight — left for a deliberate click rather than a test run.
- **Uptime Kuma.** Kuma has no documented REST API; its own UI talks socket.io. This reads the
  Prometheus `/metrics` endpoint with an API key as the HTTP basic password, which is **unconfirmed
  on this instance**. Kuma also has no monitors configured yet, so an empty list is the expected
  result today.
- **Jellyfin.** No API key issued yet. `/Items/Counts` has come and gone across versions and is
  treated as optional.
- **Frigate `recentEvents`** is empty because `/api/events` genuinely returns `[]` right now — no
  retained detections, not a parse failure.

Frigate reshuffles its stats payload between minor versions, so every field is read defensively and
reported as `null` when absent rather than crashing the panel.

## Next steps

- Sparklines from HA's history API (`history/history_during_period` over the WebSocket).
- Live video via go2rtc/WebRTC instead of polled stills — that only changes `CamerasPanel`.
- Alert badges driven by `binary_sensor.ladybird_storage_storage_problem`.
- Immich once that stack is deployed.
