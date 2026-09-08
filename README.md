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
(Frigate) or where no integration is in play (Jellyfin, Uptime Kuma, Immich).

### The token never reaches the browser

An HA long-lived access token is full control of the house. A static SPA holding one means anyone
who loads the page — or reads the JS bundle — owns HA. So there is a small backend:

```
browser ──/api──> server (holds every API key) ──> HA :8123
                                              ├──> Frigate :5000
                                              ├──> Jellyfin :8096
                                              ├──> Uptime Kuma :3001
                                              └──> Immich :2283
```

The server also:

- fans one HA subscription out to every open tab, instead of one per browser;
- proxies camera stills and live MJPEG, so the browser needs no route to the camera island and no knowledge of
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
  src/sources/    Frigate, Jellyfin, Uptime Kuma, Immich readers
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
| `GET /api/camera/:name/stream?h=1080&fps=5` | proxied Frigate MJPEG, open-ended; the client abort tears down the upstream |
| `GET /api/camera/:name/live.m3u8` + `hls/*` | HLS (fMP4) relayed from Frigate's go2rtc — what iPhone Safari plays in a `<video>` |
| `GET /api/camera/:name/live.mp4` | endless fMP4 from go2rtc for Chrome/Edge/Android, open-ended like the MJPEG stream |

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

Everything except `HA_*` is optional; an unconfigured service shows as "not configured" rather than
breaking the page. The other keys:

| Service | Where the key comes from | Notes |
|---|---|---|
| Jellyfin | Dashboard → API Keys → **+** | sent as `X-Emby-Token` |
| Uptime Kuma | Settings → API Keys → **Add** | used as the HTTP basic password on `/metrics`; Kuma ignores the username |
| Immich | Account settings → API Keys → **New**, signed in as the **admin** | sent as `x-api-key`. Library totals and the job queue are admin-only; a non-admin key gets version and disk figures only |

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

`config/dashboard.json` — five panel types (`entities`, `controls`, `cameras`, `service`, `system`),
validated at startup so a typo fails loudly instead of rendering an empty box. Edit and restart; no
rebuild. It
is mounted read-only in the container.

`controls` panels double as the write allowlist, so there is no second list to drift out of sync.

`service` panels show one polled service in depth; `"service"` is `uptimeKuma`, `jellyfin` or
`immich`. Each needs its `*_BASE_URL` and `*_API_KEY` in `.env`, and the panel names them when they
are missing rather than rendering empty:

- **Uptime Kuma** — every monitor with its state, latency while up, what it watches, and days left
  on the certificate for HTTPS targets (red under 14). Read from Kuma's Prometheus `/metrics`
  endpoint, since Kuma has no REST API of its own.
- **Jellyfin** — library counts, what is playing (with position), and what was added recently.
  Sessions idle for more than fifteen minutes are stale clients and are not counted as viewers.
- **Immich** — photo and video totals, library size, the photo disk as a fill bar, usage per user,
  and the job queues (thumbnails, machine learning, transcodes) that are busy, failing, or paused.

The compact **Services** strip in the side column keeps one tile per service regardless, so the
detail panels can be dropped from the config without losing the up/down view.

`cameras` panels render polled stills. Clicking one goes straight into real browser fullscreen
(the viewer asks the proxy for a 1080px frame — the ceiling it allows). The viewer is driven by
gestures, not buttons: tap pauses and resumes (resume snaps back to live), double-tap rewinds
~10 s into the buffered stream where one exists, swiping left/right switches cameras, and swipe
down, the ✕, Escape or leaving browser fullscreen returns to the dashboard. Arrow keys, Space
and Escape do the same from a keyboard.

The Services panel draws the largest filesystem Frigate reports as a used/free pie. Paths that share
a filesystem report identical figures, so they are grouped rather than charted twice; the small
tmpfs mounts stay as text.

### The System panel

A `system` panel shows the host itself: uptime as the headline, then one tile per reading. Each
entry in `metrics` is an entity plus how to draw it:

| Field | Meaning |
|---|---|
| `kind` | `uptime` (the state is an instant; show time since), `percent` (a bar), `value` (figure and unit). Inferred from the entity's device class and unit when left out. |
| `warn`, `crit` | Readings at or above these turn amber, then red. Thresholds live in the config because what counts as hot or full depends on the box — the defaults are for a 16 GB, 12-core machine. |

Uptime advances on its own every 30 s; nothing else is computed in the browser. An id that is not
in HA renders as "not in HA" instead of disappearing, so a wrong guess is visible.

The readings come from two places:

- **Home Assistant's System Monitor integration** — CPU, memory, swap, load, CPU temperature,
  network throughput and boot time. HA runs with host networking and reads `/proc` and
  `/sys/class/hwmon`, so these describe the host, not the container. Add it under Settings →
  Devices & services → Add integration → *System Monitor* (it has no options). **Every sensor it
  creates is disabled by default**: open the System Monitor device, show the hidden entities and
  enable the ones `config/dashboard.json` lists.
- **The storage guard** in `home-automation` (`stacks/net/disk-guard.sh`) — NVMe temperature and
  wear, read on the host where the drive is visible, published over MQTT next to the disk sensors.

The LAN interface is `enp44s0`; `enp45s0` is the camera island, so its throughput is just the two
camera streams and is not shown.

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
- **System Monitor entity ids.** The integration was not yet added to HA when this was written,
  so the `sensor.system_monitor_*` ids in `config/dashboard.json` are derived from the
  integration's translation strings (`Memory usage` → `memory_usage`, `Load (1 min)` →
  `load_1_min`, `Network throughput in enp44s0` → `network_throughput_in_enp44s0`) rather than
  read from a live `get_states`. Any that are wrong show as "not in HA" on the panel; correct them
  from Developer tools → States. The NVMe sensors need the updated guard script deployed and
  `disk-guard.sh --discovery` re-run.
- **Uptime Kuma.** Kuma has no documented REST API; its own UI talks socket.io. This reads the
  Prometheus `/metrics` endpoint with an API key as the HTTP basic password. On 2026-09-06 the live
  instance answered `401` to an unauthenticated `/metrics`, so the endpoint is there and only the
  key is missing. Kuma also has no monitors configured yet, so an empty list is the expected result
  today.
- **Jellyfin.** No API key issued yet. The live server (10.11.11) answers `401` rather than `404`
  on `/Sessions`, `/Items/Counts` and `/Items`, so every route this reads exists on that version;
  the counts and recently-added list are still treated as optional.
- **Immich.** No API key issued yet. The live server (3.1.0 on `:2283`) answers `401` on
  `/api/server/about`, `/api/server/statistics`, `/api/server/storage` and `/api/jobs`, so the
  routes exist. Statistics and jobs are admin-only; the key must be created by the admin account.

All three readers were exercised against a local stand-in serving each service's documented
response shapes, including the 401 and not-configured paths, and the resulting panels were
screenshotted. What remains is running them against the real services once keys exist.
- **Frigate `recentEvents`** is empty because `/api/events` genuinely returns `[]` right now — no
  retained detections, not a parse failure.

Frigate reshuffles its stats payload between minor versions, so every field is read defensively and
reported as `null` when absent rather than crashing the panel.

## Next steps

- Sparklines from HA's history API (`history/history_during_period` over the WebSocket) — the
  System panel's tiles are the obvious first home for them.
- The full-screen viewer plays real video from Frigate's go2rtc (HLS on WebKit, fMP4 elsewhere)
  and drops to MJPEG when the browser lacks the camera's codec (the cameras send H.265, which
  Firefox will not decode) or the camera is missing from go2rtc — as `backyard` is today: it is
  not in the go2rtc config (`go2rtc_homekit.yml` inside the Frigate container), so it streams
  MJPEG until it is added there. The hero row stays polled stills because every live transport
  costs encoding or packaging per viewer. WebRTC would cut latency under a second, but needs
  go2rtc ICE candidates configured for LAN and the 8555 media ports reachable from the browser.
- Alert badges driven by `binary_sensor.ladybird_storage_storage_problem`.
- Issue the Jellyfin, Uptime Kuma and Immich API keys on the server and add them to
  `/opt/stacks/dash/.env`, then `docker compose up -d --force-recreate` to pick them up.
