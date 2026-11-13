# Ladybird TV contract

What home automation may rely on. Anything not written here is an
implementation detail and may change.

## Provisioning intent

```
adb shell am start -n com.thomas.ladybird/.MainActivity \
  --es dashboard_url <url> --es room <name> \
  --es ntfy_url <url> --es ntfy_topics <a,b,c> --es ntfy_token <token>
```

| extra           | meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `dashboard_url` | Dashboard origin, e.g. `http://192.168.0.13`. The app loads `<dashboard_url>/tv?room=<room>`. |
| `room`          | `/tv` room preset name (see below). Empty/unset = the full house view. |
| `ntfy_url`      | ntfy server origin. The service streams `<ntfy_url>/<topics>/json`.  |
| `ntfy_topics`   | Comma-separated topic list, subscribed as one stream.                |
| `ntfy_token`    | Optional; sent as `Authorization: Bearer <token>`.                   |

Merge semantics: every extra **present** on the intent overwrites the stored
value; every extra **absent** keeps the old one. Values persist across
reboots (SharedPreferences). The effective config is logged under tag
`Ladybird` with the token redacted. Secrets are never written to disk outside
the app's private prefs and never committed anywhere.

## /tv page parameters

`GET <dashboard_url>/tv?room=<name>` — `name` must match a key under
`tv.rooms` in the dashboard's `config/dashboard.json`. Resolution order:
named room → room literally named `default` → everything (all cameras, all
look-only panels). Unknown names are not an error.

## Topic naming

House-wide alerts ride `ladybird-house`; per-TV alerts ride
`ladybird-tv-<room>` (e.g. `ladybird-tv-living`). A TV subscribes to both via
`ntfy_topics`. Nothing enforces this shape — it is the convention the
automation side should publish to.

## ntfy message handling

Only `message` events are shown; `open`/`keepalive` are ignored. Fields used:
`id`, `topic`, `title` (falls back to the topic), `message`, `priority`
(default 3), `attachment.url` (rendered in the banner when present — e.g. a
Frigate snapshot). The newest seen `id` is persisted and reconnects use
`since=<id>`, so messages sent while the TV slept or the network blinked are
shown on reconnect. Reconnect backoff is 2 s doubling to a 60 s ceiling, cut
short when connectivity returns.

## Priority → banner behavior

| priority | behavior                                                        |
| -------- | ---------------------------------------------------------------- |
| 1–3      | normal banner, auto-dismiss after 5 s                            |
| 4        | normal banner, auto-dismiss after 10 s                           |
| 5        | red banner; stays until a newer message arrives, 60 s at most    |

Banners stack newest-on-top, at most 3; the oldest drops off. They sit in the
top-right corner at ~30% screen width, never take focus and never block input.
"Suppress priority ≤ 2 while video plays" is **not implemented** (cross-app
playback detection isn't worth the complexity); every message ≥ priority 1
shows.

Banners require the overlay permission, granted once per TV:

```
adb shell appops set com.thomas.ladybird SYSTEM_ALERT_WINDOW allow
```

Without it messages are received but dropped, with a clear logcat warning.
