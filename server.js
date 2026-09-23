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
const { imageTicket } = require('./test-print.js');

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

// Returns {} when the file doesn't exist; throws on unreadable or invalid JSON.
function readConfigFile() {
  try {
    // Strip a UTF-8 BOM: Windows PowerShell 5.1's Set-Content writes one,
    // and JSON.parse rejects it.
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function buildConfig(fileCfg) {
  const cfg = Object.assign({}, DEFAULTS, fileCfg);
  cfg.tls = Object.assign({}, DEFAULTS.tls, fileCfg.tls || {});

  // Env overrides, handy for quick tests without editing the file.
  if (process.env.PRINTER_HOST) cfg.printerHost = process.env.PRINTER_HOST;
  if (process.env.PRINTER_PORT) cfg.printerPort = Number(process.env.PRINTER_PORT);
  if (process.env.LISTEN_PORT) cfg.listenPort = Number(process.env.LISTEN_PORT);
  return cfg;
}

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = readConfigFile();
  } catch (err) {
    console.error(`! Could not read ${CONFIG_PATH}: ${err.message}`);
    console.error('  Falling back to built-in defaults.');
  }
  return buildConfig(fileCfg);
}

function configMtime() {
  try { return fs.statSync(CONFIG_PATH).mtimeMs; } catch (err) { return 0; }
}

// Only read when the server starts; a reload keeps the running values.
const STARTUP_KEYS = ['listenPort', 'listenHost', 'tls', 'logFile', 'logMaxBytes'];

let config = loadConfig();
let configStamp = configMtime();

// Picks up config.json edits without a restart. A broken file keeps the
// previous settings rather than falling back to DEFAULTS, so a typo can't
// silently point the bridge at the wrong printer.
function currentConfig() {
  const stamp = configMtime();
  if (stamp === configStamp) return config;
  configStamp = stamp;
  try {
    const next = buildConfig(readConfigFile());
    for (const key of STARTUP_KEYS) next[key] = config[key];
    config = next;
    log(`config reloaded from ${CONFIG_PATH}`);
  } catch (err) {
    warn(`config.json not reloaded, keeping previous settings: ${err.message}`);
  }
  return config;
}

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

// Data from the bridge is only ever inserted with textContent: job sources come
// from request paths, so they must not reach innerHTML.
const STATUS_PAGE = (cfg) => {
  const scheme = cfg.tls.enabled ? 'https' : 'http';
  const defaultPort = cfg.tls.enabled ? 443 : 80;
  const odooUrl = `${scheme}://&lt;this-laptop-ip&gt;${cfg.listenPort === defaultPort ? '' : ':' + cfg.listenPort}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Printer bridge</title>
<style>
:root{
 --desk:#E9EDF0;--paper:#FFFFFF;--ink:#1C2530;--muted:#66737F;--line:rgba(28,37,48,.12);
 --ok:#1F8A4C;--bad:#C0362C;--idle:#8A96A1;--slot:#2A333C;--focus:#2563EB;color-scheme:light;
 --display:"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,sans-serif;
 --text:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
 --desk:#12171C;--paper:#1D242B;--ink:#E6EBEF;--muted:#95A1AC;--line:rgba(230,235,239,.13);
 --ok:#3FB872;--bad:#E5675C;--idle:#6B7782;--slot:#05080A;--focus:#7AA7FF;color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--desk);color:var(--ink);font:16px/1.5 var(--text);-webkit-font-smoothing:antialiased}
main{max-width:680px;margin:0 auto;padding:40px 20px 64px}

.top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.brand{font:600 17px/1.2 var(--display);margin:0}
.target{color:var(--muted);font-size:14px;font-variant-numeric:tabular-nums}

.slot{position:relative;z-index:2;height:14px;margin:0 -10px;border-radius:7px;background:var(--slot);
 box-shadow:inset 0 -4px 0 rgba(0,0,0,.35)}
.feed{overflow:hidden;margin:-7px -10px 0;padding:0 10px 34px}
.slip{position:relative;background:var(--paper);padding:36px 32px 18px;
 filter:drop-shadow(0 1px 1px rgba(28,37,48,.08)) drop-shadow(0 6px 10px rgba(28,37,48,.06));
 animation:feed 850ms cubic-bezier(.2,.75,.25,1) both}
.slip::after{content:"";position:absolute;left:0;right:0;top:100%;height:9px;background:var(--paper);
 -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='9'%3E%3Cpath d='M0 0h18L9 9z'/%3E%3C/svg%3E") 0 0/18px 9px repeat-x;
 mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='9'%3E%3Cpath d='M0 0h18L9 9z'/%3E%3C/svg%3E") 0 0/18px 9px repeat-x}
@keyframes feed{from{transform:translateY(-102%)}to{transform:none}}
@media (prefers-reduced-motion:reduce){.slip{animation:none}}

.state{display:flex;align-items:center;gap:14px;margin:0;font:600 31px/1.15 var(--display);letter-spacing:-.015em}
.dot{flex:none;width:12px;height:12px;border-radius:50%;background:var(--idle);transition:background-color .3s,box-shadow .3s}
.dot.ok{background:var(--ok);box-shadow:0 0 0 5px color-mix(in srgb,var(--ok) 18%,transparent)}
.dot.bad{background:var(--bad);box-shadow:0 0 0 5px color-mix(in srgb,var(--bad) 18%,transparent)}
.sub{margin:10px 0 0;color:var(--muted);max-width:56ch}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 20px;margin:22px 0 0;font-size:14px}
.facts dt{color:var(--muted)}
.facts dd{margin:0;font-variant-numeric:tabular-nums}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px;padding-top:22px;border-top:1.5px dashed var(--line)}

button{font:inherit;font-size:15px;color:var(--ink);background:transparent;border:1px solid var(--line);
 border-radius:10px;padding:9px 16px;cursor:pointer;transition:background-color .15s,border-color .15s,opacity .15s}
button:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}
button.primary{background:var(--ink);border-color:var(--ink);color:var(--paper)}
button.primary:hover{background:color-mix(in srgb,var(--ink) 86%,var(--paper))}
button:disabled{opacity:.4;cursor:default}
button:disabled:hover{background:transparent}
button.primary:disabled:hover{background:var(--ink)}
button:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

.msg{min-height:22px;margin:14px 0 0;font-size:14px;color:var(--muted)}
.msg.ok{color:var(--ok)} .msg.bad{color:var(--bad)}

section{margin-top:48px}
h2{margin:0 0 4px;font:600 20px/1.3 var(--display);letter-spacing:-.01em}
.lede{margin:0 0 16px;color:var(--muted);font-size:15px;max-width:60ch}

.jobs{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.jobs li{display:grid;grid-template-columns:4rem 1fr auto;gap:2px 16px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--line)}
.jobs li.empty{display:block;color:var(--muted)}
.jobs time{color:var(--muted);font-size:14px;font-variant-numeric:tabular-nums}
.jobs .meta{color:var(--muted);font-size:13px}
.res{font-size:14px;font-weight:600} .res.ok{color:var(--ok)} .res.bad{color:var(--bad)}
.jobs .err{grid-column:2/-1;color:var(--bad);font-size:13px}

.settings{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:1fr auto;gap:4px 24px;align-items:center;padding:16px 0;border-bottom:1px solid var(--line)}
.row>label,.row>.label{grid-column:1;grid-row:1;font-weight:600;font-size:15px}
.row>.hint{grid-column:1;grid-row:2;margin:0;color:var(--muted);font-size:13px;max-width:46ch}
.row>.control{grid-column:2;grid-row:1/span 2}
.stepper{display:inline-flex;align-items:center;background:var(--paper);border:1px solid var(--line);border-radius:10px}
.stepper:has(input:invalid){border-color:var(--bad)}
.stepper button{width:38px;height:38px;padding:0;border:0;border-radius:9px;font-size:18px;line-height:1}
.stepper input{width:58px;border:0;background:transparent;color:inherit;font:inherit;text-align:right;
 font-variant-numeric:tabular-nums;-moz-appearance:textfield;appearance:textfield}
.stepper input::-webkit-inner-spin-button,.stepper input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.unit{width:3.4em;padding-left:5px;color:var(--muted);font-size:13px}
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:11px;background:color-mix(in srgb,var(--ink) 7%,transparent)}
.seg button{border:0;border-radius:8px;padding:6px 16px;font-size:14px}
.seg button[aria-checked=true]{background:var(--paper);box-shadow:0 1px 2px rgba(0,0,0,.14)}
.formbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:18px}
.formbar .msg{margin:0 0 0 6px}
.note{margin:28px 0 0;color:var(--muted);font-size:13px;max-width:64ch}

@media (max-width:540px){
 main{padding-top:24px}
 .slip{padding:28px 20px 22px}
 .state{font-size:26px}
 .row{grid-template-columns:1fr}
 .row>.control{grid-column:1;grid-row:3;justify-self:start;margin-top:8px}
}
</style></head><body>
<main>
<header class="top">
 <p class="brand">Printer bridge</p>
 <p class="target">Printer at ${cfg.printerHost}:${cfg.printerPort}</p>
</header>

<div class="slot" aria-hidden="true"></div>
<div class="feed"><div class="slip">
 <h1 class="state"><span id="dot" class="dot" aria-hidden="true"></span><span id="state">Checking the bridge…</span></h1>
 <p id="sub" class="sub">One moment.</p>
 <dl class="facts adm" hidden>
  <dt>Bridge running since</dt><dd id="since"></dd>
 </dl>
 <div class="actions">
  <button class="primary" onclick="testPrint(this,'image')">Print Odoo-style test</button>
  <button onclick="testPrint(this,'text')">Print text test</button>
  <button class="adm" hidden onclick="checkPrinter(this)">Check connection</button>
 </div>
 <p id="out" class="msg" role="status" aria-live="polite"></p>
</div></div>

<section class="adm" hidden aria-labelledby="h-prints">
 <h2 id="h-prints">Recent prints</h2>
 <p class="lede">The last 10 since the bridge started. Updates every 10 seconds.</p>
 <ul id="jobs" class="jobs"></ul>
</section>

<section class="adm" hidden aria-labelledby="h-cut">
 <h2 id="h-cut">Cut settings</h2>
 <p class="lede">Your printer cuts the moment it is told to, so the bridge waits for the ticket to finish printing first.</p>
 <form onsubmit="saveChanges(event)" novalidate>
  <div class="settings">
   <div class="row">
    <label for="cutDelayMsPer100Rows">Wait before cutting</label>
    <div class="control stepper"><button type="button" data-d="-" aria-label="Decrease">−</button><input id="cutDelayMsPer100Rows" type="number" inputmode="numeric" min="0" max="2000" step="10" required><span class="unit">ms</span><button type="button" data-d="+" aria-label="Increase">+</button></div>
    <p class="hint">Per 100 rows of ticket. Raise it if the cut lands above the QR code; lower it if the pause feels long.</p>
   </div>
   <div class="row">
    <label for="cutDelayMinMs">Shortest wait</label>
    <div class="control stepper"><button type="button" data-d="-" aria-label="Decrease">−</button><input id="cutDelayMinMs" type="number" inputmode="numeric" min="0" max="10000" step="50" required><span class="unit">ms</span><button type="button" data-d="+" aria-label="Increase">+</button></div>
    <p class="hint">Used for short and text-only tickets.</p>
   </div>
   <div class="row">
    <label for="feedLinesBeforeCut">Blank lines after the ticket</label>
    <div class="control stepper"><button type="button" data-d="-" aria-label="Decrease">−</button><input id="feedLinesBeforeCut" type="number" inputmode="numeric" min="0" max="20" step="1" required><span class="unit">lines</span><button type="button" data-d="+" aria-label="Increase">+</button></div>
    <p class="hint">Pushes the footer past the blade. Raise it if the footer gets cut; lower it to save paper.</p>
   </div>
   <div class="row">
    <span class="label" id="l-cut">Cut</span>
    <div class="control seg" id="cutType" role="radiogroup" aria-labelledby="l-cut"><button type="button" role="radio" data-v="partial">Partial</button><button type="button" role="radio" data-v="full">Full</button></div>
    <p class="hint">Partial leaves a small tab so the ticket doesn't drop.</p>
   </div>
  </div>
  <div class="formbar">
   <button id="save" class="primary" type="submit" disabled>Save changes</button>
   <button id="discard" type="button" hidden onclick="discardChanges()">Discard</button>
   <p id="saved" class="msg" role="status" aria-live="polite"></p>
  </div>
 </form>
 <p class="note">Printer address, ports and HTTPS are set in config.json and need a restart: double-click Restart printer bridge on the desktop.</p>
</section>

<p class="note">Odoo connects to ${odooUrl}</p>
</main>

<script>
var H={'X-Bridge-Admin':'1'};
var KEYS=['cutDelayMsPer100Rows','cutDelayMinMs','feedLinesBeforeCut'];
var saved=null,busy=false,cutType='partial';
function $(id){return document.getElementById(id)}
function hm(t){return new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function when(t){return new Date(t).toLocaleDateString([],{day:'numeric',month:'short'})+', '+hm(t)}
function say(id,msg,kind){var e=$(id);e.textContent=msg;e.className='msg'+(kind?' '+kind:'')}
function secs(ms){return (ms/1000).toFixed(1).replace(/\\.0$/,'')+' s'}
function name(src){return src==='Odoo'?'Odoo ticket':src==='test (text)'?'Text test':src==='test (image)'?'Odoo-style test':src}

function showState(kind,head,sub){$('dot').className='dot'+(kind?' '+kind:'');$('state').textContent=head;$('sub').textContent=sub}

function renderState(s){
 var job=s.jobs[0],chk=s.lastPrinterCheck,ev=null;
 if(job)ev={t:job.time,ok:job.ok,err:job.error,print:true};
 if(chk&&(!ev||chk.time>ev.t))ev={t:chk.time,ok:chk.ok,err:chk.error,print:false};
 if(!ev)showState('','Waiting for the first print','The bridge is running. Print a test to make sure the printer answers.');
 else if(ev.ok)showState('ok','Ready to print',(ev.print?'Last print went through at ':'The printer answered at ')+hm(ev.t)+'.');
 else showState('bad','Printer not answering',(ev.print?'Last print failed at ':'The connection check failed at ')+hm(ev.t)+' ('+ev.err+'). Check that the printer is on and its cable is plugged in, then check the connection again.');
 $('since').textContent=when(s.startedAt);
}

function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function renderJobs(s){
 var ul=$('jobs');ul.textContent='';
 if(!s.jobs.length){ul.appendChild(el('li','empty','Nothing printed since '+when(s.startedAt)+'. Print a test above to check the printer.'));return}
 s.jobs.forEach(function(j){
  var li=el('li'),what=el('div');
  li.appendChild(el('time','',hm(j.time)));
  what.appendChild(el('div','',name(j.source)));
  what.appendChild(el('div','meta',(j.images?'Image':'Text')+(j.cutDelayMs&&j.cutDelayMs.length?', cut after '+secs(j.cutDelayMs[0]):'')));
  li.appendChild(what);
  li.appendChild(el('span','res '+(j.ok?'ok':'bad'),j.ok?'Printed':'Failed'));
  if(!j.ok&&j.error)li.appendChild(el('div','err',j.error));
  ul.appendChild(li);
 });
}

function setCut(v){cutType=v;document.querySelectorAll('#cutType button').forEach(function(b){b.setAttribute('aria-checked',String(b.dataset.v===v))})}
function values(){var o={};KEYS.forEach(function(k){o[k]=Number($(k).value)});o.cutType=cutType;return o}
function pick(s){var o={};KEYS.forEach(function(k){o[k]=s[k]});o.cutType=s.cutType;return o}
function dirty(){var d=!!saved&&JSON.stringify(values())!==JSON.stringify(pick(saved));$('save').disabled=!d;$('discard').hidden=!d;return d}
function fill(s){KEYS.forEach(function(k){$(k).value=s[k]});setCut(s.cutType);dirty()}

document.querySelectorAll('.stepper').forEach(function(st){
 var input=st.querySelector('input');
 st.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){
  if(b.dataset.d==='+')input.stepUp();else input.stepDown();dirty();say('saved','')})});
 input.addEventListener('input',function(){dirty();say('saved','')});
});
document.querySelectorAll('#cutType button').forEach(function(b){b.addEventListener('click',function(){setCut(b.dataset.v);dirty();say('saved','')})});

async function refresh(){
 var r;
 try{r=await fetch('/admin/status',{headers:H,cache:'no-store'})}
 catch(e){showState('bad','Bridge not reachable','This page lost contact with the bridge. Double-click Restart printer bridge on the desktop.');return}
 if(r.status===403){showState('','Test printing','Status and settings are shown only on the laptop the bridge runs on.');return}
 var s=await r.json();
 document.querySelectorAll('.adm').forEach(function(e){e.hidden=false});
 renderState(s);renderJobs(s);
 if(!dirty()){saved=s.settings;fill(saved)}
}

async function act(btn,label,fn){
 if(busy)return;busy=true;
 var all=document.querySelectorAll('.actions button'),old=btn.textContent;
 all.forEach(function(b){b.disabled=true});btn.textContent=label;
 try{await fn()}finally{busy=false;all.forEach(function(b){b.disabled=false});btn.textContent=old;refresh()}
}
function testPrint(btn,kind){act(btn,'Printing…',async function(){
 try{var r=await fetch('/test-print?kind='+kind,{method:'POST'});var t=await r.text();
  if(/success="true"/.test(t))say('out','Test printed. Check the paper.','ok');
  else say('out','The test did not print. Recent prints below shows why.','bad')}
 catch(e){say('out','Could not reach the bridge: '+e.message,'bad')}})}
function checkPrinter(btn){act(btn,'Checking…',async function(){
 try{var r=await fetch('/admin/check-printer',{method:'POST',headers:H});var c=await r.json();
  if(c.ok)say('out','The printer answered.','ok');else say('out','The printer did not answer: '+c.error,'bad')}
 catch(e){say('out','Could not reach the bridge: '+e.message,'bad')}})}

// Inline handlers inside the form see element ids first (form.save is the button), so names must differ from ids.
async function saveChanges(ev){
 ev.preventDefault();
 var bad=KEYS.filter(function(k){return !$(k).checkValidity()});
 if(bad.length){say('saved','That value is out of range. Use a whole number between the limits.','bad');$(bad[0]).focus();return}
 $('save').disabled=true;
 try{
  var r=await fetch('/admin/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Admin':'1'},body:JSON.stringify(values())});
  var res=await r.json();
  if(r.ok){saved=res.settings;fill(saved);say('saved','Saved. The next print uses these settings.','ok')}
  else{say('saved','Not saved: '+res.error,'bad');dirty()}
 }catch(e){say('saved','Not saved: the bridge could not be reached.','bad');dirty()}
}
function discardChanges(){fill(saved);say('saved','')}

refresh();setInterval(refresh,10000);
</script></body></html>`;
};

const testTicket = (cfg) => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
<text align="center" dw="true" dh="true">EPOS-BRIDGE&#10;</text>
<text align="center">test ticket&#10;</text>
<feed line="1"/>
<text align="left">If you can read this, Odoo can print here.&#10;</text>
<text align="left">Bridge -&gt; ${cfg.printerHost}:${cfg.printerPort}&#10;</text>
<feed line="1"/>
<cut type="feed"/>
</epos-print></s:Body></s:Envelope>`;

// ---------------------------------------------------------------------------
// Control page backend: status, printer check, settings
// ---------------------------------------------------------------------------

const STARTED_AT = new Date().toISOString();
const recentJobs = [];
let lastPrinterCheck = null;

function recordJob(job) {
  recentJobs.unshift(job);
  if (recentJobs.length > 10) recentJobs.length = 10;
}

const EDITABLE = {
  cutDelayMsPer100Rows: { min: 0, max: 2000 },
  cutDelayMinMs: { min: 0, max: 10000 },
  feedLinesBeforeCut: { min: 0, max: 20 },
  cutType: { values: ['partial', 'full'] }
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// Admin only from this laptop's own page: loopback, a header other sites can't
// send cross-origin (absent from Allow-Headers), and a local Host (DNS rebinding).
function isLocalAdmin(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  if (req.headers['x-bridge-admin'] !== '1') return false;
  let host;
  try { host = new URL(`http://${req.headers.host || ''}`); } catch (err) { return false; }
  if (!LOCAL_HOSTNAMES.has(host.hostname)) return false;
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== host.host) return false;
    } catch (err) {
      return false;
    }
  }
  return true;
}

function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  for (const [key, value] of Object.entries(body)) {
    const rule = EDITABLE[key];
    if (!rule) return `${key} can't be changed from this page`;
    if (rule.values) {
      if (!rule.values.includes(value)) return `${key} must be one of: ${rule.values.join(', ')}`;
    } else if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      return `${key} must be a whole number from ${rule.min} to ${rule.max}`;
    }
  }
  return null;
}

// Rewrites only the given keys; tmp + rename so a crash can't leave half a file.
function saveSettings(updates) {
  const fileCfg = readConfigFile();
  Object.assign(fileCfg, updates);
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fileCfg, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
}

function statusSnapshot(cfg) {
  const settings = {};
  for (const key of Object.keys(EDITABLE)) settings[key] = cfg[key];
  return {
    startedAt: STARTED_AT,
    printer: `${cfg.printerHost}:${cfg.printerPort}`,
    configFile: CONFIG_PATH,
    lastPrinterCheck,
    jobs: recentJobs,
    settings
  };
}

// Connect-and-close through the queue, so it never overlaps a print job.
async function checkPrinter(cfg) {
  const time = new Date().toISOString();
  try {
    await enqueuePrint([], cfg);
    lastPrinterCheck = { time, ok: true };
  } catch (err) {
    lastPrinterCheck = { time, ok: false, error: err.message };
  }
  return lastPrinterCheck;
}

async function handleAdmin(req, res, url) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (!isLocalAdmin(req)) {
    reply(403, { error: 'Manage the bridge from the laptop it runs on.' });
    return;
  }

  const cfg = currentConfig();
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /admin/status') {
    reply(200, statusSnapshot(cfg));
    return;
  }

  if (route === 'POST /admin/check-printer') {
    reply(200, await checkPrinter(cfg));
    return;
  }

  if (route === 'POST /admin/settings') {
    let body;
    try {
      body = JSON.parse(await readBody(req, 16 * 1024));
    } catch (err) {
      reply(400, { error: 'expected a JSON object' });
      return;
    }
    const problem = validateSettings(body);
    if (problem) {
      reply(400, { error: problem });
      return;
    }
    try {
      saveSettings(body);
    } catch (err) {
      reply(500, { error: `could not update config.json: ${err.message}` });
      return;
    }
    log(`settings changed from the control page: ${JSON.stringify(body)}`);
    reply(200, statusSnapshot(currentConfig()));
    return;
  }

  reply(404, { error: 'unknown admin route' });
}

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

async function handlePrint(req, res, xml, source) {
  const cfg = currentConfig();
  const time = new Date().toISOString();
  if (cfg.dumpPayloads) dumpPayload(xml);

  let translated;
  try {
    translated = translate(xml, cfg);
  } catch (err) {
    warn(`translation failed: ${err.message}`);
    recordJob({ time, source, ok: false, error: `could not read the ticket: ${err.message}` });
    res.writeHead(200, Object.assign(
      { 'Content-Type': 'text/xml; charset=utf-8' }, corsHeaders(req)
    ));
    res.end(soapResponse(false, 'EPTR_REC'));
    return;
  }

  const s = translated.stats;
  const segs = translated.segments;
  const bytes = segs.reduce((n, seg) => n + seg.bytes.length, 0);
  const delays = segs.filter((seg) => seg.delayMs > 0).map((seg) => seg.delayMs);
  const job = { time, source, bytes, images: s.images, cutDelayMs: delays };

  if (cfg.logJobs) {
    log(`job: ${bytes} bytes -> ${cfg.printerHost}:${cfg.printerPort}`
      + ` (images:${s.images} textChars:${s.text} cuts:${s.cuts} pulses:${s.pulses}`
      + ` cutDelay:${delays.map((d) => d + 'ms').join(',')})`);
  }

  try {
    await enqueuePrint(segs, cfg);
    recordJob(Object.assign(job, { ok: true }));
    res.writeHead(200, Object.assign(
      { 'Content-Type': 'text/xml; charset=utf-8' }, corsHeaders(req)
    ));
    res.end(soapResponse(true));
  } catch (err) {
    warn(`print failed: ${err.message}`);
    recordJob(Object.assign(job, { ok: false, error: err.message }));
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

  if (url.pathname.startsWith('/admin/')) {
    await handleAdmin(req, res, url);
    return;
  }

  if (req.method === 'GET') {
    const cfg = currentConfig();
    if (url.pathname === '/health') {
      res.writeHead(200, Object.assign(
        { 'Content-Type': 'application/json' }, corsHeaders(req)
      ));
      res.end(JSON.stringify({
        ok: true,
        printer: `${cfg.printerHost}:${cfg.printerPort}`
      }));
      return;
    }
    res.writeHead(200, Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8' }, corsHeaders(req)
    ));
    res.end(STATUS_PAGE(cfg));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, corsHeaders(req));
    res.end();
    return;
  }

  if (url.pathname === '/test-print') {
    const image = url.searchParams.get('kind') === 'image';
    log(`test print (${image ? 'image' : 'text'}) requested from status page`);
    await handlePrint(req, res, image ? imageTicket() : testTicket(currentConfig()),
      image ? 'test (image)' : 'test (text)');
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
  await handlePrint(req, res, xml,
    url.pathname === '/cgi-bin/epos/service.cgi' ? 'Odoo' : url.pathname);
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
