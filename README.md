# Garmin inReach Lightning Monitor

A Cloudflare Worker that monitors nearby lightning with Xweather and sends short alerts to a Garmin inReach through Garmin's consumer web-reply flow.

> **Important:** This is an unofficial hobby project. It is not affiliated with Garmin, Xweather, Cloudflare, or the National Weather Service. Do not rely on it as your only source of lightning or severe-weather safety information. The Garmin consumer web-reply interface used here is undocumented and may change without notice.

## What it does

1. You send `START`, `STOP`, or `STATUS` from your Garmin inReach to an email address routed to the Worker.
2. The Worker reads the Garmin message, stores the location included in that message, and captures Garmin's public reply link.
3. While tracking is on, a Cloudflare Cron trigger wakes the Worker every minute.
4. The Worker checks Xweather only when due:
   - about every 5 minutes when no lightning is detected;
   - about every 2 minutes while lightning exists within the configured radius;
   - never while tracking is off.
5. The Worker deduplicates strikes, groups nearby strikes into storm clusters, and decides whether a Garmin alert is warranted.
6. If needed, it posts a short reply through Garmin's public web-reply page.

No lightning means no Garmin alert.

## Default alert behavior

The default search radius is 60 miles. The code uses four **messaging/cadence bands**, not official safety thresholds:

- 0–10 miles: critical
- 11–20 miles: close
- 21–40 miles: nearby
- 41–60 miles: distant

The nearest individual strike is prioritized. Nearby strikes are also grouped into clusters using a 12-mile clustering threshold.

Example alert:

```text
LIGHTNING CLOSE - 8/5m. Nearest 17.2mi WNW, 1m ago. 5 WNW 17-25mi; 3 W 31-36mi Reply STOP to stop.
```

## Privacy and secrets

Do **not** commit any of the following to GitHub:

- Xweather client ID or client secret
- your Cloudflare account IDs or KV namespace IDs
- your personal email address or domain if you do not want it public
- Garmin reply links or tokens
- GPS coordinates copied from live Worker state
- screenshots or logs containing any of the above

The source code in this repository contains no user-specific values.

The deployed Worker does need to store the latest Garmin location and Garmin reply link in its private KV namespace at runtime. The public `/` endpoint returns only a small non-identifying health summary and never returns the stored coordinates or reply link.

## What you need

- Garmin inReach with messaging
- Cloudflare account
- a domain using Cloudflare DNS for Email Routing
- Xweather Weather API credentials
- Cloudflare KV namespace

## 1. Create the Cloudflare Worker

Create a Worker in Cloudflare and replace its code with [`src/index.js`](src/index.js).

The Worker needs this KV binding:

```text
Binding name: LIGHTNING_STATE
```

Create a KV namespace with any name you like, then bind it to the Worker using that exact binding name.

## 2. Add Xweather secrets

In your Worker settings, add these as **Secrets**, not plain-text variables:

```text
XWEATHER_CLIENT_ID
XWEATHER_CLIENT_SECRET
```

Paste the corresponding values from your Xweather account.

Never place the actual values in this repository.

## 3. Configure Cloudflare Email Routing

Enable Email Routing for a domain using Cloudflare DNS.

Create a custom address such as:

```text
garmin@example.com
```

Choose:

```text
Action: Send to a Worker
Worker: your lightning-monitor Worker
```

The code accepts inbound SMTP envelope senders from `garmin.com` and its subdomains.

## 4. Configure the Cron trigger

Add a Cron Trigger that runs every minute:

```cron
* * * * *
```

The Worker wakes every minute but does **not** call Xweather every minute. The internal `next_check_at` value controls the actual API cadence.

## 5. First Garmin test

From your Garmin, send:

```text
STATUS
```

The Worker should receive the email, extract the GPS coordinates and Garmin reply link, and send a confirmation back to the inReach.

Then try:

```text
START
```

Expected reply:

```text
Tracking started. Lightning monitoring active. Reply STOP to stop tracking.
```

To stop monitoring:

```text
STOP
```

Expected reply:

```text
Tracking has stopped. Reply START to restart tracking.
```

While tracking is off, the scheduled Worker exits before contacting Xweather.

## 6. Check Worker health

Open your Worker's public URL in a browser.

The `/` endpoint intentionally returns only a safe health summary, for example:

```json
{
  "ok": true,
  "service": "garmin-inreach-lightning-monitor",
  "tracking_enabled": true,
  "location_available": true,
  "garmin_reply_link_available": true,
  "last_command": "START",
  "last_lightning_check_at": "2026-01-01T12:00:00.000Z",
  "last_xweather_status": 200,
  "last_lightning_count": 0,
  "last_lightning_alert_decision": "no_lightning",
  "next_check_at": "2026-01-01T12:05:00.000Z"
}
```

It does not expose latitude, longitude, email metadata, or the Garmin reply URL.

## Location limitation

The monitor uses the most recent coordinates contained in an inbound Garmin message. It does **not** independently fetch a continuously moving inReach track.

Sending `START`, `STATUS`, or another Garmin message that includes location information refreshes the stored position.

## Garmin reply implementation

Consumer inReach messages contain a public Garmin reply link. This project follows that link, loads the Garmin reply page, discovers the current Next.js `sendReplyAction` identifier from Garmin's JavaScript bundles, and submits the reply.

The action identifier is cached in KV. If Garmin changes it and the cached action fails, the Worker attempts one live rediscovery and retry.

This is intentionally treated as fragile because the consumer reply page is not a documented public API.

## Xweather behavior and cost

The code uses Xweather's standard lightning endpoint with a 60-mile radius and up to 1,000 recent strikes.

Because lightning requests can have a higher access multiplier than ordinary Weather API requests, check Xweather's current pricing before leaving monitoring enabled continuously.

The adaptive cadence is intended to reduce unnecessary requests:

```text
Tracking OFF: 0 Xweather calls
Quiet:        ~1 call / 5 minutes
Active:       ~1 call / 2 minutes
```

## Files

```text
src/index.js       Cloudflare Worker
wrangler.jsonc     Example configuration with placeholders only
.gitignore         Prevents common local secret files from being committed
LICENSE            MIT license
```

## Security notes

This repository intentionally omits the old development-only `/run-monitor`, `/test-lightning`, and `/update` endpoints. Public unauthenticated endpoints that can trigger paid API calls or mutate monitor state are a bad default.

The inbound email handler also rejects SMTP envelope senders that are not from `garmin.com` or one of its subdomains.

For stronger protection, consider adding authenticated administrative endpoints rather than restoring public test routes.

## License

MIT. See [LICENSE](LICENSE).
