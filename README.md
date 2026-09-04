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

**The dashboard itself has no login.** Anyone who can reach port 8099 can read every panel and
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

Entity ids come from HA → Developer tools → States. The defaults use the storage-guard sensors and
`switch.frontcam_white_light` — the only working white-light control on the driveway camera.

## Deploying to ladybird

```bash
docker compose up -d --build
```

That compose file is for local testing. On the server the deployment belongs in `home-automation`
under `stacks/dash/`, so every compose file for that host stays in one repo:

- `stacks/dash/docker-compose.yml` pointing at the built image
- a row in that repo's README services table
- an image digest in its `VERSIONS.txt`
- a note in `docs/operations.md`

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

- **Live HA data.** No long-lived token exists yet, so `get_states`, `subscribe_events` and
  `call_service` are written to the documented protocol but unexercised. The entity ids in
  `config/dashboard.json` come from the `home-automation` notes, not from a live `get_states` — expect
  to correct a couple.
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
