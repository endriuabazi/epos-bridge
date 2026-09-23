#!/usr/bin/env node
/**
 * epos-bridge
 * -----------
 * Pretends to be an Epson ePOS-Print printer so Odoo POS will talk to it,
 * then translates what Odoo sends into plain ESC/POS bytes and forwards them
 * to a cheap network thermal printer on TCP port 9100.
 *
 * Zero npm dependencies on purpose: node server.js and it runs.
 */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.EPOS_BRIDGE_CONFIG
  || path.join(__dirname, 'config.json');

const DEFAULTS = {
  listenPort: 8080,
  listenHost: '0.0.0.0',
  printerHost: '192.168.1.100',
  printerPort: 9100,
  connectTimeoutMs: 5000,
  // Some printers expect inverted raster bits. Flip this if images print
  // as a black block / photo negative.
  invertImage: false,
  // Rows of dots sent per GS v 0 band. Lower this if long receipts get
  // truncated or garbled (small printer buffers).
  rasterBandRows: 64,
  // Blank lines fed before the cut, so the cut lands below the last text.
  feedLinesBeforeCut: 4,
  cutType: 'partial',            // 'partial' | 'full'
  // The printer runs a cut as soon as it reads it, even while image rows it
  // already received are still printing. So the feed+cut is held back for a
  // time scaled to the image rows before it. Raise this if long tickets still
  // cut early (above the QR/footer).
  cutDelayMsPer100Rows: 400,
  cutDelayMinMs: 500,
  // ESC t code page for plain-text jobs. 16 = WPC1252 (has ë, ç, é...).
  codePage: 16,
  textEncoding: 'latin1',
  // Fake Epson identity reported to Odoo.
  deviceId: 'local_printer',
  tls: {
    enabled: false,
    // Either a PEM pair (OpenSSL) ...
    keyFile: 'certs/key.pem',
    certFile: 'certs/cert.pem',
    // ... or a PFX/PKCS#12 bundle, which is what Windows exports natively.
    // If pfxFile is set it wins over the PEM pair.
    pfxFile: '',
    passphrase: 'epos'
  },
  // The bridge usually runs with no console (scheduled task), so it keeps
  // its own log. Set logFile to '' to turn the file off.
  logFile: 'logs/bridge.log',
  logMaxBytes: 2 * 1024 * 1024,
  logJobs: true,
  // Dump every received XML body to ./logs for debugging.
  dumpPayloads: false
};

function loadConfig() {
  let fileCfg = {};
  try {
    // Strip a UTF-8 BOM: Windows PowerShell 5.1's Set-Content writes one,
    // and JSON.parse rejects it.
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`! Could not read ${CONFIG_PATH}: ${err.message}`);
      console.error('  Falling back to built-in defaults.');
    }
  }
  const cfg = Object.assign({}, DEFAULTS, fileCfg);
  cfg.tls = Object.assign({}, DEFAULTS.tls, fileCfg.tls || {});

  // Env overrides, handy for quick tests without editing the file.
  if (process.env.PRINTER_HOST) cfg.printerHost = process.env.PRINTER_HOST;
  if (process.env.PRINTER_PORT) cfg.printerPort = Number(process.env.PRINTER_PORT);
  if (process.env.LISTEN_PORT) cfg.listenPort = Number(process.env.LISTEN_PORT);
  return cfg;
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Tiny logger
//
// The bridge normally runs as a Windows scheduled task with no console, so it
// keeps its own file too. That log is the main diagnostic tool:
//   a POST line  -> the client reached the bridge, so any fault is printer-side
//   silence      -> the request never arrived, so the fault is address or DNS
// ---------------------------------------------------------------------------

const LOG_PATH = config.logFile ? path.resolve(__dirname, config.logFile) : null;

let logStream = null;
let logBytes = 0;

function openLog() {
  if (!LOG_PATH) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    try { logBytes = fs.statSync(LOG_PATH).size; } catch (err) { logBytes = 0; }
    logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    // A logging problem must never take the bridge down.
    logStream.on('error', () => { logStream = null; });
  } catch (err) {
    logStream = null;
  }
}

function writeLog(line) {
  if (!logStream) return;
  try {
    logStream.write(line + '\n');
    logBytes += Buffer.byteLength(line) + 1;
    if (logBytes > config.logMaxBytes) {
      logStream.end();
      logStream = null;
      // Keep one previous file; older than that isn't worth the disk.
      try { fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch (err) { /* keep going */ }
      openLog();
    }
  } catch (err) {
    logStream = null;
  }
}

openLog();

function stamp(parts) {
  return [new Date().toISOString()]
    .concat(parts.map((p) => (typeof p === 'string' ? p : String(p))))
    .join(' ');
}

const log = (...args) => {
  const line = stamp(args);
  console.log(line);
  writeLog(line);
};

const warn = (...args) => {
  const line = stamp(['!'].concat(args));
  console.warn(line);
  writeLog(line);
};

// ---------------------------------------------------------------------------
// ESC/POS byte helpers
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init: () => Buffer.from([ESC, 0x40]),
  codePage: (n) => Buffer.from([ESC, 0x74, n & 0xff]),
  align: (n) => Buffer.from([ESC, 0x61, n & 0x03]),          // 0 L, 1 C, 2 R
  bold: (on) => Buffer.from([ESC, 0x45, on ? 1 : 0]),
  underline: (on) => Buffer.from([ESC, 0x2d, on ? 1 : 0]),
  invert: (on) => Buffer.from([GS, 0x42, on ? 1 : 0]),
  // GS ! n — low nibble = height multiplier, high nibble = width multiplier
  size: (w, h) => Buffer.from([
    GS, 0x21,
    ((Math.max(1, Math.min(8, w)) - 1) << 4) | (Math.max(1, Math.min(8, h)) - 1)
  ]),
  lineSpacingDefault: () => Buffer.from([ESC, 0x32]),
  lineSpacing: (n) => Buffer.from([ESC, 0x33, n & 0xff]),
  feedLines: (n) => Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, n))]),
  feedDots: (n) => Buffer.from([ESC, 0x4a, Math.max(0, Math.min(255, n))]),
  cutPartial: () => Buffer.from([GS, 0x56, 0x01]),
  cutFull: () => Buffer.from([GS, 0x56, 0x00]),
  drawerPulse: (pin, onMs, offMs) => Buffer.from([
    ESC, 0x70, pin & 0x01,
    Math.max(1, Math.min(255, Math.round(onMs / 2))),
    Math.max(1, Math.min(255, Math.round(offMs / 2)))
  ])
};

const ALIGN = { left: 0, center: 1, right: 2 };

// ---------------------------------------------------------------------------
// Minimal XML helpers
//
// The payloads Odoo sends are machine-generated and shallow, so a real XML
// parser would be overkill. We pull out the <epos-print> body and walk its
// direct children in order.
// ---------------------------------------------------------------------------

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].replace(/^.*:/, '')] = decodeEntities(m[2]);
  }
  return attrs;
}

function extractPrintBody(xml) {
  const m = xml.match(
    /<(?:[A-Za-z0-9_]+:)?epos-print\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?epos-print>/
  );
  if (m) return m[1];
  // Some clients post a bare <epos-print .../> or skip the SOAP envelope.
  const body = xml.match(
    /<(?:[A-Za-z0-9_]+:)?Body\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?Body>/
  );
  return body ? body[1] : xml;
}

function parseElements(xml) {
  const out = [];
  const re = /<([A-Za-z0-9_:-]+)((?:\s+[A-Za-z0-9_:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const name = m[1].replace(/^.*:/, '').toLowerCase();
    const attrs = parseAttrs(m[2] || '');
    if (m[3] === '/') {
      out.push({ name, attrs, text: '' });
      continue;
    }
    const closeTag = `</${m[1]}>`;
    const closeIdx = xml.indexOf(closeTag, re.lastIndex);
    if (closeIdx === -1) {
      out.push({ name, attrs, text: '' });
      continue;
    }
    out.push({ name, attrs, text: xml.slice(re.lastIndex, closeIdx) });
    re.lastIndex = closeIdx + closeTag.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raster images
//
// Odoo renders the whole receipt (customer *and* kitchen tickets) to a canvas
// and ships it as one monochrome bitmap. So this path is the one that really
// matters — get it right and everything prints.
//
// ePOS <image> data and ESC/POS GS v 0 use the same layout: 1 bit per pixel,
// MSB first, rows padded to whole bytes, 1 = black dot. We just re-band it.
// ---------------------------------------------------------------------------

function buildRaster(base64Data, width, height, cfg) {
  const raw = Buffer.from(base64Data.replace(/\s+/g, ''), 'base64');
  const rowBytes = Math.ceil(width / 8);
  const usableRows = Math.min(height, Math.floor(raw.length / rowBytes));
  if (usableRows <= 0) return Buffer.alloc(0);

  const chunks = [];
  const band = Math.max(1, cfg.rasterBandRows);

  for (let start = 0; start < usableRows; start += band) {
    const rows = Math.min(band, usableRows - start);
    const slice = Buffer.from(
      raw.subarray(start * rowBytes, (start + rows) * rowBytes)
    );
    if (cfg.invertImage) {
      for (let i = 0; i < slice.length; i++) slice[i] = ~slice[i] & 0xff;
    }
    const header = Buffer.from([
      GS, 0x76, 0x30, 0x00,
      rowBytes & 0xff, (rowBytes >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff
    ]);
    chunks.push(header, slice);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// ePOS-Print XML  ->  ESC/POS bytes
// ---------------------------------------------------------------------------

// Default ESC/POS line spacing (ESC 2) is about 30 dots.
const FEED_LINE_DOTS = 30;

function cutDelayMs(rows, cfg) {
  return Math.max(cfg.cutDelayMinMs, Math.round(rows * cfg.cutDelayMsPer100Rows / 100));
}

// Returns the job as segments; each is sent after waiting its delayMs. A new
// segment starts at every cut, so the cut waits for the rows before it to print.
function translate(xml, cfg) {
  const segments = [];
  let parts = [CMD.init(), CMD.codePage(cfg.codePage)];
  let delayMs = 0;
  let rowsSinceCut = 0;
  const stats = { text: 0, images: 0, cuts: 0, pulses: 0, barcodes: 0 };
  let sawCut = false;

  // The feed goes out with the content so the whole ticket leaves the printer
  // in one motion; only the cut waits, for the image rows and the feed.
  const startCut = () => {
    parts.push(CMD.feedLines(cfg.feedLinesBeforeCut));
    segments.push({ delayMs, bytes: Buffer.concat(parts) });
    delayMs = cutDelayMs(rowsSinceCut + cfg.feedLinesBeforeCut * FEED_LINE_DOTS, cfg);
    rowsSinceCut = 0;
    parts = [cfg.cutType === 'full' ? CMD.cutFull() : CMD.cutPartial()];
  };

  for (const el of parseElements(extractPrintBody(xml))) {
    switch (el.name) {
      case 'text': {
        const a = el.attrs;
        if (a.align && ALIGN[a.align] !== undefined) parts.push(CMD.align(ALIGN[a.align]));
        if (a.em !== undefined) parts.push(CMD.bold(a.em === 'true' || a.em === '1'));
        if (a.ul !== undefined) parts.push(CMD.underline(a.ul === 'true' || a.ul === '1'));
        if (a.reverse !== undefined) parts.push(CMD.invert(a.reverse === 'true' || a.reverse === '1'));
        if (a.dw !== undefined || a.dh !== undefined || a.width || a.height) {
          const w = a.width ? Number(a.width) : (a.dw === 'true' ? 2 : 1);
          const h = a.height ? Number(a.height) : (a.dh === 'true' ? 2 : 1);
          parts.push(CMD.size(w || 1, h || 1));
        }
        if (a.linespc) parts.push(CMD.lineSpacing(Number(a.linespc)));

        const body = decodeEntities(el.text);
        if (body.length) {
          parts.push(Buffer.from(body, cfg.textEncoding));
          stats.text += body.length;
        }
        break;
      }

      case 'image':
      case 'logo': {
        const width = Number(el.attrs.width || 0);
        const height = Number(el.attrs.height || 0);
        if (width > 0 && height > 0 && el.text.trim()) {
          parts.push(CMD.align(ALIGN[el.attrs.align] ?? 0));
          parts.push(buildRaster(el.text, width, height, cfg));
          rowsSinceCut += height;
          stats.images++;
        }
        break;
      }

      case 'feed': {
        const a = el.attrs;
        if (a.unit) parts.push(CMD.feedDots(Number(a.unit)));
        else if (a.line) parts.push(CMD.feedLines(Number(a.line)));
        else parts.push(CMD.feedLines(1));
        break;
      }

      case 'cut': {
        startCut();
        sawCut = true;
        stats.cuts++;
        break;
      }

      case 'pulse': {
        const time = String(el.attrs.time || 'pulse_100');
        const ms = Number((time.match(/(\d+)/) || [])[1] || 100);
        const pin = el.attrs.drawer === 'drawer_2' ? 1 : 0;
        parts.push(CMD.drawerPulse(pin, ms, ms));
        stats.pulses++;
        break;
      }

      // Rendered by Odoo into the bitmap already; nothing to do here.
      case 'symbol':
      case 'barcode':
        stats.barcodes++;
        break;

      default:
        break;
    }
  }

  if (!sawCut) startCut();
  segments.push({ delayMs, bytes: Buffer.concat(parts) });

  return { segments, stats };
}

// ---------------------------------------------------------------------------
// Printer transport (raw TCP, one job at a time)
// ---------------------------------------------------------------------------

let printQueue = Promise.resolve();

function sendToPrinter(segments, cfg) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(cfg.connectTimeoutMs);
    socket.once('timeout', () => done(new Error(
      `timed out talking to ${cfg.printerHost}:${cfg.printerPort}`
    )));
    socket.once('error', (err) => done(err));

    socket.connect(cfg.printerPort, cfg.printerHost, () => {
      let i = 0;
      const next = () => {
        if (settled) return;
        if (i === segments.length) {
          // Small grace period so the printer drains its buffer before FIN.
          setTimeout(() => done(null), 250);
          return;
        }
        const seg = segments[i++];
        const write = () => {
          if (settled) return;
          socket.setTimeout(cfg.connectTimeoutMs);
          socket.write(seg.bytes, next);
        };
        if (seg.delayMs > 0) {
          // The idle timeout would otherwise fire during this deliberate wait.
          socket.setTimeout(0);
          setTimeout(write, seg.delayMs);
        } else {
          write();
        }
      };
      next();
    });
  });
}

function enqueuePrint(segments, cfg) {
  const job = printQueue.then(
    () => sendToPrinter(segments, cfg),
    () => sendToPrinter(segments, cfg)
  );
  printQueue = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// Responses Odoo understands
// ---------------------------------------------------------------------------

function soapResponse(success, code) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
    + '<s:Body>'
    + '<response xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print" '
    + `success="${success ? 'true' : 'false'}" `
    + `code="${success ? '' : (code || 'DeviceNotFound')}" `
    + 'status="251658262" battery="0"/>'
    + '</s:Body></s:Envelope>';
}

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, SOAPAction, If-Modified-Since, X-Requested-With',
    'Access-Control-Max-Age': '86400'
  };
}

const STATUS_PAGE = (cfg) => `<!doctype html>
<html><head><meta charset="utf-8"><title>epos-bridge</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:38rem;padding:0 1rem}
 h1{font-size:1.4rem;margin-bottom:.2rem} code{background:#f2f2f2;padding:.1rem .35rem;border-radius:3px}
 table{border-collapse:collapse;margin:1rem 0}td{padding:.3rem .8rem .3rem 0}
 button{font:inherit;padding:.5rem 1rem;cursor:pointer}
 #out{margin-top:1rem;color:#444}
</style></head><body>
<h1>epos-bridge is running</h1>
<p>Odoo thinks this is an Epson ePOS printer. It isn't — it forwards to a plain ESC/POS printer.</p>
<table>
<tr><td>Forwarding to</td><td><code>${cfg.printerHost}:${cfg.printerPort}</code></td></tr>
<tr><td>Point Odoo at</td><td><code>${cfg.tls.enabled ? 'https' : 'http'}://&lt;this-machine-ip&gt;:${cfg.listenPort}</code></td></tr>
</table>
<button onclick="t()">Send a test receipt</button>
<div id="out"></div>
<script>
async function t(){
 const o=document.getElementById('out');o.textContent='sending...';
 try{const r=await fetch('/test-print',{method:'POST'});
 o.textContent=r.ok?'Sent. Check the printer.':'Failed: '+await r.text();}
 catch(e){o.textContent='Failed: '+e.message}
}
</script></body></html>`;

const TEST_TICKET = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
<text align="center" dw="true" dh="true">EPOS-BRIDGE&#10;</text>
<text align="center">test ticket&#10;</text>
<feed line="1"/>
<text align="left">If you can read this, Odoo can print here.&#10;</text>
<text align="left">Bridge -&gt; ${config.printerHost}:${config.printerPort}&#10;</text>
<feed line="1"/>
<cut type="feed"/>
</epos-print></s:Body></s:Envelope>`;

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

function readBody(req, limitBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function dumpPayload(xml) {
  try {
    const dir = path.join(__dirname, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `job-${Date.now()}.xml`);
    fs.writeFileSync(file, xml);
    log(`  payload saved to ${file}`);
  } catch (err) {
    warn(`could not save payload: ${err.message}`);
  }
}

async function handlePrint(req, res, xml) {
  if (config.dumpPayloads) dumpPayload(xml);

  let translated;
  try {
    translated = translate(xml, config);
  } catch (err) {
    warn(`translation failed: ${err.message}`);
    res.writeHead(200, Object.assign(
      { 'Content-Type': 'text/xml; charset=utf-8' }, corsHeaders(req)
    ));
    res.end(soapResponse(false, 'EPTR_REC'));
    return;
  }

  if (config.logJobs) {
    const s = translated.stats;
    const segs = translated.segments;
    const bytes = segs.reduce((n, seg) => n + seg.bytes.length, 0);
    const delays = segs.filter((seg) => seg.delayMs > 0).map((seg) => seg.delayMs + 'ms');
    log(`job: ${bytes} bytes -> ${config.printerHost}:${config.printerPort}`
      + ` (images:${s.images} textChars:${s.text} cuts:${s.cuts} pulses:${s.pulses}`
      + ` cutDelay:${delays.join(',')})`);
  }

  try {
    await enqueuePrint(translated.segments, config);
    res.writeHead(200, Object.assign(
      { 'Content-Type': 'text/xml; charset=utf-8' }, corsHeaders(req)
    ));
    res.end(soapResponse(true));
  } catch (err) {
    warn(`print failed: ${err.message}`);
    // Still HTTP 200 — Odoo reads the SOAP success flag, not the status code.
    res.writeHead(200, Object.assign(
      { 'Content-Type': 'text/xml; charset=utf-8' }, corsHeaders(req)
    ));
    res.end(soapResponse(false, 'DeviceNotFound'));
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === 'GET') {
    if (url.pathname === '/health') {
      res.writeHead(200, Object.assign(
        { 'Content-Type': 'application/json' }, corsHeaders(req)
      ));
      res.end(JSON.stringify({
        ok: true,
        printer: `${config.printerHost}:${config.printerPort}`
      }));
      return;
    }
    res.writeHead(200, Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8' }, corsHeaders(req)
    ));
    res.end(STATUS_PAGE(config));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, corsHeaders(req));
    res.end();
    return;
  }

  if (url.pathname === '/test-print') {
    log('test print requested from status page');
    await handlePrint(req, res, TEST_TICKET);
    return;
  }

  let xml;
  try {
    xml = await readBody(req);
  } catch (err) {
    warn(`bad request body: ${err.message}`);
    res.writeHead(413, corsHeaders(req));
    res.end();
    return;
  }

  log(`POST ${url.pathname} (${xml.length} chars) from ${req.socket.remoteAddress}`);
  await handlePrint(req, res, xml);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function createServer() {
  if (!config.tls.enabled) return http.createServer(requestHandler);

  try {
    if (config.tls.pfxFile) {
      const pfxPath = path.resolve(__dirname, config.tls.pfxFile);
      log(`TLS: using PFX ${pfxPath}`);
      return https.createServer({
        pfx: fs.readFileSync(pfxPath),
        passphrase: config.tls.passphrase || undefined
      }, requestHandler);
    }
    const keyPath = path.resolve(__dirname, config.tls.keyFile);
    const certPath = path.resolve(__dirname, config.tls.certFile);
    log(`TLS: using PEM ${certPath}`);
    return https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    }, requestHandler);
  } catch (err) {
    console.error(`! TLS is enabled but the certificate could not be loaded: ${err.message}`);
    console.error('  Run setup-tls.ps1 in PowerShell (as Administrator) to create one,');
    console.error('  or see README.md, section "If your Odoo runs on HTTPS".');
    process.exit(1);
  }
}

const server = createServer();

// If a browser speaks TLS to our plain-HTTP port, Node sees the handshake as
// a malformed request. Say so plainly instead of failing silently — this is
// the single most common reason Odoo reports "Failed to reach the printer".
server.on('clientError', (err, socket) => {
  if (!config.tls.enabled && /HPE_INVALID|parse|SSL|packet/i.test(err.message || '')) {
    warn('A client tried to connect using HTTPS, but TLS is disabled here.');
    warn('  Your Odoo is served over https, so it demands https from the printer too.');
    warn('  Fix: run setup-tls.ps1, then set tls.enabled = true in config.json.');
  }
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`! Port ${config.listenPort} is already taken by another program.`);
    console.error('  Change "listenPort" in config.json, or stop whatever is using it.');
  } else if (err.code === 'EACCES') {
    console.error(`! Not allowed to listen on port ${config.listenPort}.`);
    console.error('  Ports below 1024 need admin rights. Try 8080 instead.');
  } else {
    console.error(`! Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(config.listenPort, config.listenHost, () => {
  const scheme = config.tls.enabled ? 'https' : 'http';
  log(`started: listening ${scheme}://${config.listenHost}:${config.listenPort}`
    + ` -> printer ${config.printerHost}:${config.printerPort}`);
  console.log('');
  console.log('  epos-bridge');
  console.log('  ' + '-'.repeat(48));
  console.log(`  listening   ${scheme}://${config.listenHost}:${config.listenPort}`);
  console.log(`  printer     ${config.printerHost}:${config.printerPort}`);
  console.log(`  config      ${CONFIG_PATH}`);
  console.log('');
  console.log(`  Open ${scheme}://localhost:${config.listenPort} in a browser`);
  console.log('  to check status and send a test receipt.');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nstopping...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
