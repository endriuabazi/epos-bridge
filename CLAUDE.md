# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**epos-bridge** — a zero-dependency Node service that impersonates an Epson ePOS-Print
printer so Odoo POS will send it kitchen tickets, then forwards them as raw ESC/POS bytes
to a clone thermal printer (OCPP-80H) on TCP 9100.

It exists because of a hardware constraint: the printer has port 9100 open but 80/443
closed, so Odoo's *Use an Epson printer* mode (HTTP POST of SOAP/XML to
`/cgi-bin/epos/service.cgi`) cannot reach it. Kitchen tickets have no browser-print
fallback in Odoo, so something has to do this translation. Read `README.md` for the full
hardware findings and the Odoo-side setup.

## Commands

There is no build, lint, or test tooling, and no `package.json` — the zero-dependency,
no-`npm install` property is deliberate. Node 18+ (22.x present).

```bash
node server.js                       # start the bridge (reads config.json)
node test-print.js text              # send a text ticket   (the "single test")
node test-print.js image             # send a raster ticket (the format Odoo really uses)
node test-print.js both
BRIDGE=http://192.168.3.25:8080 node test-print.js both   # target another host
curl http://localhost:8080/health    # liveness + configured printer
```

`test-print.js` is the closest thing to a test suite: it posts real ePOS-Print envelopes
to `/cgi-bin/epos/service.cgi` and passes if the reply contains `success="true"`. The
`image` mode is the meaningful one — it exercises the path Odoo actually uses.

Env overrides (no config edit needed): `PRINTER_HOST`, `PRINTER_PORT`, `LISTEN_PORT`,
`EPOS_BRIDGE_CONFIG`.

Verify the printer leg independently (Windows):
`Test-NetConnection -ComputerName 192.168.1.100 -Port 9100` → `TcpTestSucceeded : True`.

## Architecture

Two legs, both in `server.js`:

```
Odoo (browser)  --HTTP POST, ePOS-Print SOAP/XML-->  bridge  --raw ESC/POS over TCP-->  printer:9100
```

Request path: `requestHandler` → `readBody` → `handlePrint` → `translate` →
`enqueuePrint` → `sendToPrinter`, replying with `soapResponse`.

Load-bearing decisions, none of them obvious from a single function:

- **Every POST is a print job.** The URL path is ignored except `/test-print` (`?kind=image`
  for the raster test, reusing `imageTicket` exported by `test-print.js`) and `/admin/*`;
  the bridge answers on whatever path the client uses. Don't add routing that rejects
  unknown paths.
- **`/admin/*` (control page backend) is locked to this laptop's own page** by
  `isLocalAdmin`. All of these must hold:
  - the remote address is loopback;
  - the `X-Bridge-Admin: 1` header is present. It is deliberately absent from
    `Access-Control-Allow-Headers`, so cross-origin preflights fail;
  - `Host` is local (defeats DNS rebinding);
  - `Origin`, if present, matches `Host`.

  The bridge listens on the LAN and sends permissive CORS for Odoo, so dropping any
  check lets other devices or web pages change settings. Admin responses carry no CORS
  headers. Only `EDITABLE` keys can be written; `saveSettings` does tmp + rename.
  The page inserts bridge data with `textContent` only, because job sources come from
  request paths.
- **Config reloads itself.** `currentConfig()` re-reads `config.json` when its mtime
  changes (called per job and per page/status request). A broken file keeps the previous
  config rather than `DEFAULTS`. `STARTUP_KEYS` (ports, TLS, log file) keep their
  startup values until a restart. Use `currentConfig()`, not the startup `config`, in
  request paths.
- The "Check connection" probe is `enqueuePrint([], cfg)` (connect, grace, close). It must
  stay in the queue: the printer gets one connection at a time.
- **Always HTTP 200.** Odoo reads the SOAP `success` attribute, not the status code. A
  failed print returns 200 with `success="false"`. Do not "fix" this into a 4xx/5xx.
- **The raster path is the one that matters.** Odoo renders the whole ticket (customer
  *and* kitchen) to a canvas and ships one 1-bit-per-pixel `<image>`. `<text>` handling is
  secondary, used by `test-print.js` and other clients. `buildRaster` relies on ePOS image
  data and ESC/POS `GS v 0` sharing the same layout — it re-bands raw bytes rather than
  decoding pixels. Keep it that way; per-pixel work would be far slower for no gain.
- **XML parsing is regex-based on purpose.** `extractPrintBody` / `parseElements` /
  `parseAttrs` handle shallow machine-generated payloads only, and strip namespace
  prefixes. Adding a real XML parser would break the zero-dependency rule.
- **ESC/POS bytes come only from the `CMD` table.** Add new commands there rather than
  inlining byte arrays at the call site.
- **Jobs are serialized.** `printQueue` is a promise chain — one TCP connection at a time,
  and it continues after a failed job. Anything new that writes to the printer must go
  through `enqueuePrint`, never `sendToPrinter` directly.
- **The cut is held back on purpose.** The OCPP-80H executes `GS V` the moment it reads
  it, even while image rows it already received are still printing, so a long bill used to
  be cut above its QR code. `translate` therefore returns `segments`: content + feed go out
  at once, and only the cut follows after `cutDelayMs()` (image rows + feed dots, scaled by
  `cutDelayMsPer100Rows`, floor `cutDelayMinMs`). `sendToPrinter` writes the segments in
  order and suspends the socket idle timeout during the wait. Don't merge the cut back
  into one write, and don't treat the feed as a fix — extra feed never moved the cut.
- The timer is a guess because the printer cannot report print completion: `DLE EOT`,
  `GS r 1` and `GS ( H` are all answered on receipt (~0.8 s into a ~1 s bill), and `GS ( H`
  makes it reset the TCP connection. Don't retry a status-based cut.
- `translate` appends a feed + cut when the payload contained no `<cut>` (`sawCut`).
- **Config layering:** `DEFAULTS` in `server.js` is authoritative; `config.json` is a
  partial overlay (`tls` merged one level deep), then env vars. A new option needs a
  `DEFAULTS` entry or it won't exist when `config.json` omits it.

## Deployment realities

- CORS headers are on every response — Odoo calls from a browser origin, so this is
  required, not decoration.
- An HTTPS Odoo needs `tls.enabled` plus a self-signed cert the browser has been made to
  trust once (mixed content blocks `http://` otherwise). See README.
- `"dumpPayloads": true` writes each received XML body to `logs/` — the way to see what
  Odoo actually sent.
- Tuning knobs map to physical symptoms: `invertImage` (solid black / negative output),
  `rasterBandRows` (long tickets truncated or garbled — small printer buffer),
  `feedLinesBeforeCut` (footer not pushed past the cutter, or too much blank paper),
  `cutDelayMsPer100Rows` (cut lands above the QR/footer → raise it; long pause before the
  cut → lower it; deployed at 100, default 400), `cutDelayMinMs` (same, for short/text
  jobs), `codePage` (ë/ç garbled; affects plain-text jobs only, since Odoo's images render
  accents as pixels).
- The bridge runs as the `epos-bridge` scheduled task. Code changes (and `STARTUP_KEYS`)
  only apply after a restart: `restart-bridge.ps1` (self-elevates; `-CreateShortcuts` puts
  "Restart printer bridge" and "Printer bridge status" on the desktop), or `Stop-/Start-
  ScheduledTask -TaskName epos-bridge`. Confirm a new `started:` line in `logs/bridge.log`.
  The job log line shows the applied `cutDelay:`.
