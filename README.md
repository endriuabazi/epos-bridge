# epos-bridge

A small translator that lets Odoo POS print to a cheap thermal printer that
isn't a real Epson.

---

## Why this exists

The printer is an **OCPP-80H** (80mm thermal, USB + LAN, `DC24V/2.5A`). Its
network module identifies itself in a browser as *"Ethernet WebSet System"* —
a bare page with only MAC / IP / subnet / gateway fields.

We proved the following on the actual hardware:

| Check | Result |
|---|---|
| Ethernet link (direct cable, PC ↔ printer) | up, 100 Mbps |
| `ping 192.168.1.100` from the wired interface | replies |
| TCP port **9100** (raw ESC/POS) | **open** |
| TCP port **80** (Epson ePOS-Print web service) | closed |
| TCP port **443** (ePOS over HTTPS) | closed |

That last pair is the whole problem. Odoo's **ePos Printer** option does not
speak "generic network printer" — it speaks Epson's proprietary *ePOS-Print*
protocol: an HTTP POST carrying SOAP/XML to
`/cgi-bin/epos/service.cgi` on the printer. A genuine Epson runs a little web
service to receive that. This printer is a clone: it never implements that
service, only the older raw-socket method on 9100.

This matters more than it sounds, because Odoo treats the two kinds of
receipt differently:

- **Customer receipts** have a fallback. With no smart printer configured,
  Odoo just opens the browser print dialog and a human clicks Print. This
  already works over USB with a Generic / Text Only driver.
- **Kitchen / preparation tickets have no fallback.** They are meant to print
  themselves the instant an order is sent, with nobody standing at the
  screen, so Odoo only offers *"Use a printer connected to the IoT Box"* or
  *"Use an Epson printer"*. Choosing neither produces:

  > Kuzhina: Please ensure the IoT box is turned on and connected to the
  > network before retrying.

Odoo's own answer is an IoT Box (hardware or the Windows virtual version),
which needs a paid IoT subscription. An IoT Box would drive this printer
happily — precisely *because* it talks to it over raw 9100, which we already
know works.

So this bridge is a free stand-in for that one translation step:

```
Odoo POS (browser)
   │  HTTP POST, ePOS-Print SOAP/XML
   ▼
epos-bridge  ← answers like an Epson, so Odoo is satisfied
   │  raw ESC/POS bytes over a TCP socket
   ▼
OCPP-80H at 192.168.1.100:9100
```

One important detail that shapes the code: Odoo does **not** send receipts as
text. It renders the whole ticket to a canvas and ships it as a single
1-bit-per-pixel bitmap inside an `<image>` element. Epson's raster format and
ESC/POS `GS v 0` use the same layout, so the bridge mostly re-bands that
bitmap and passes it through. The text commands are handled too, for printers
and payloads that use them.

---

## Requirements

- **Node.js 18 or newer** — <https://nodejs.org> (LTS installer is fine)
- The printer reachable on the network at port 9100

No `npm install`. There are no dependencies.

---

## Setup

**1. Point it at the printer.** Edit `config.json`:

```json
"printerHost": "192.168.1.100",
"printerPort": 9100
```

**2. Start it.**

```
node server.js
```

You should see:

```
  epos-bridge
  ------------------------------------------------
  listening   http://0.0.0.0:8080
  printer     192.168.1.100:9100
```

**3. Test it before involving Odoo.** Open <http://localhost:8080> and click
**Send a test receipt**. Or from a terminal:

```
node test-print.js both
```

That sends a text ticket and a raster ticket — the second one is the format
Odoo really uses, so if a framed box with diagonal stripes comes out clean,
the hard part works.

**4. Find this machine's LAN address**, since Odoo needs to reach the bridge
by IP, not `localhost`:

```
ipconfig
```

Use the Wi-Fi adapter's IPv4 address (e.g. `192.168.3.25`) — the one on the
same network as whatever runs the POS screen.

**5. Wire it into Odoo.** Settings → Point of Sale → Preparation Printers →
open **Kuzhina**:

- **Printer Type:** `Use an Epson printer`
- **IP Address:** the bridge, e.g. `192.168.3.25:8080`

Save, close and reopen the POS session (it caches printer config), then send
an order to the kitchen.

> If Odoo rejects or strips the `:8080`, set `"listenPort": 80` in
> `config.json` and enter just `192.168.3.25`. On Windows, port 80 needs an
> administrator terminal, and IIS or Skype may already be holding it.

---

## If Odoo rewrites your address into `...omnilinkcert.epson.biz`

Recent Odoo versions changed this field. It no longer takes an IP address —
it takes the printer's **serial number**, and Odoo derives Epson's "certified
domain" from it:

    base32( sha256( serial ) ).toLowerCase() + ".omnilinkcert.epson.biz"

on port **8043**. Type `localhost:8080` and Odoo hashes that text as if it
were a serial, producing something like
`rmp5yrf5v6oww667vc2hjbsmxrlum44txzcgq4cge3v2wxr772ua.omnilinkcert.epson.biz`
— a name that has nothing to do with your machine, so nothing can connect.

Genuine Epson printers register that name with Epson's DNS so it resolves to
the printer on your LAN, and carry a certificate Epson signed for it. We
can't register with Epson. But the name depends only on the text you type, so
we can compute it ourselves, point it at this machine in the hosts file, and
issue our own trusted certificate for it.

Run in PowerShell **as administrator**:

```powershell
cd path\to\epos-bridge
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup-omnilink.ps1 -Serial FRUTZA-KUZHINA
```

That one script derives the hostname, adds the hosts entry, creates and
trusts a certificate for it, and switches the bridge to port 8043 over HTTPS.
Then restart `node server.js` and enter **`FRUTZA-KUZHINA`** — the serial, not
an IP — in Odoo's field.

The serial is arbitrary; it is only a seed for the hostname. Keep it stable,
because changing it changes the hostname and invalidates the certificate.

To see what any serial would produce without changing anything:

```
node epson-domain.js FRUTZA-KUZHINA
```

**Caveat worth knowing:** the hosts entry maps the name to `127.0.0.1`, so it
only works in a browser on this machine. If the POS runs on other tills,
each needs the same hosts entry and the certificate installed — at which
point a real IoT Box starts looking like the cheaper option.

## If your Odoo runs on HTTPS  ← read this if Odoo says "Failed to reach the printer"

If your Odoo URL starts with `https://`, Odoo asks the printer for HTTPS too.
A plain-HTTP bridge can't answer that: the connection dies during the TLS
handshake, before any request is formed, so Odoo reports *"Failed to reach
the printer. Check the configured url."* while `server.js` logs nothing at
all. That silence is the tell.

Real Epson ePOS printers hit the same wall — Odoo's own documentation walks
users through installing a certificate on the printer for exactly this
reason. Odoo's obox app fails here too. It is not a bug in the bridge.

### Windows (no OpenSSL needed)

Right-click PowerShell → **Run as administrator**, then:

```powershell
cd path\to\epos-bridge
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup-tls.ps1
```

It creates a certificate for this machine's IP, adds it to Windows' trusted
roots, exports `certs/bridge.pfx`, and flips `tls.enabled` on in
`config.json`. Then restart `node server.js`.

**One manual step remains:** open `https://<your-ip>:8080` once in the same
browser you use for Odoo, and accept the warning if one appears. Chrome will
not let Odoo talk to the bridge until it has seen that certificate accepted
at least once.

### macOS / Linux (OpenSSL)

```
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=192.168.3.25" \
  -addext "subjectAltName=IP:192.168.3.25"
```

Then in `config.json`:

```json
"tls": { "enabled": true, "keyFile": "certs/key.pem", "certFile": "certs/cert.pem" }
```

### Checking it worked

```
curl -k https://localhost:8080/health
```

`{"ok":true,...}` means TLS is live. If Odoo still fails after this, the
certificate hasn't been accepted in the browser yet — repeat the manual step
above.

---

## Keeping it running on Windows

Create `start-bridge.bat` next to `server.js`:

```bat
@echo off
cd /d "%~dp0"
node server.js
```

Then either drop a shortcut to it in
`shell:startup` (Win+R → `shell:startup`), or register it as a real service
with [NSSM](https://nssm.cc) so it survives logout and restarts itself.

---

## Troubleshooting

**"could not reach the bridge"** — `server.js` isn't running, or a firewall
is blocking the port. First time it starts, Windows may pop a firewall
prompt: allow it on **Private** networks.

**Bridge logs the job, but nothing prints** — the printer address is wrong or
unreachable. Verify with:

```
Test-NetConnection -ComputerName 192.168.1.100 -Port 9100
```

`TcpTestSucceeded : True` is what you want.

**Paper comes out solid black, or the image looks like a photo negative** —
set `"invertImage": true`.

**Long tickets get cut off or turn to garbage halfway** — the printer's
buffer is small. Lower `"rasterBandRows"` to `32` or `24`.

**The cut happens too high, slicing the last lines** — raise
`"feedLinesBeforeCut"`.

**Albanian characters (ë, ç) print as junk** — try other `codePage` values.
`16` is WPC1252; some clones want `0` (CP437), `18` (CP852) or `47`
(ISO-8859-2). This only affects plain-text jobs; Odoo's image path renders
accented characters as pixels, so it's usually unaffected.

**Odoo says "Failed to reach the printer" and `server.js` logs nothing** —
Odoo is on HTTPS and the bridge is on HTTP. See the HTTPS section above.

**Odoo still says "ensure the IoT box is turned on"** — Printer Type is still
set to *Use a printer connected to the IoT Box*. It has to be *Use an Epson
printer*. Also close and reopen the POS session after changing it.

**Nothing obvious, need to see what Odoo actually sent** — set
`"dumpPayloads": true`, reproduce, and read the XML saved under `logs/`.

---

## Handing this to Claude Code

If you want to extend it, open this folder in Claude Code and give it this
context:

> This is a zero-dependency Node bridge that impersonates an Epson ePOS-Print
> printer for Odoo POS and forwards to a clone thermal printer over raw
> ESC/POS on TCP 9100. `server.js` parses the ePOS-Print SOAP/XML Odoo posts
> to `/cgi-bin/epos/service.cgi`, translates `<text>`, `<image>`, `<feed>`,
> `<cut>` and `<pulse>` into ESC/POS bytes, sends them over a TCP socket, and
> returns an Epson-shaped SOAP response with `success="true"` so Odoo accepts
> the job. `test-print.js` simulates Odoo. Printer details and tuning live in
> `config.json`. Read the README first — it explains why the printer can't be
> used directly.

Things worth adding next:

- **Cash drawer** — `<pulse>` is already translated; test it with a real drawer.
- **Several printers** — map an incoming path or query parameter to different
  targets (kitchen / bar / cashier) so one bridge serves all of them.
- **Print queue that survives a restart** — persist pending jobs to disk and
  retry, so a ticket isn't lost if the printer is off or out of paper.
- **Status reporting** — Odoo only reads `success`; the bridge could actually
  query the printer (ESC/POS real-time status `DLE EOT`) and report paper-out
  instead of always claiming success.
- **Auto-discovery** — scan the subnet for hosts with 9100 open to fill in
  `printerHost` automatically.

---

## What's in the folder

| File | Purpose |
|---|---|
| `server.js` | The bridge. Run this. |
| `config.json` | Printer address and tuning. |
| `test-print.js` | Pretends to be Odoo; verifies the bridge without Odoo. |
| `setup-omnilink.ps1` | Windows: certificate + hosts entry for the Epson domain scheme. |
| `epson-domain.js` | Shows the hostname Odoo derives from a serial. |
| `README.md` | This file. |
# epos-bridge
