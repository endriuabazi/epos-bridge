#!/usr/bin/env node
/**
 * Pretends to be Odoo and sends a job to the bridge.
 *
 *   node test-print.js            # text ticket
 *   node test-print.js image      # raster ticket (the format Odoo really uses)
 *   node test-print.js both
 *
 * Override the target with:  BRIDGE=http://192.168.1.50:8080 node test-print.js
 */

'use strict';

const http = require('http');
const https = require('https');

const BRIDGE = process.env.BRIDGE || 'http://localhost:8080';
const mode = (process.argv[2] || 'text').toLowerCase();

function envelope(inner) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
    + '<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">'
    + inner
    + '</epos-print></s:Body></s:Envelope>';
}

const textTicket = envelope(
  '<text align="center" dw="true" dh="true">KUZHINA&#10;</text>'
  + '<text align="center">--- test ticket ---&#10;</text>'
  + '<feed line="1"/>'
  + '<text align="left">2x Byrek me spinaq&#10;</text>'
  + '<text align="left">1x Kafe e zeze&#10;</text>'
  + '<feed line="1"/>'
  + '<text align="left" em="true">Tavolina 4&#10;</text>'
  + '<feed line="1"/>'
  + '<cut type="feed"/>'
);

/**
 * Builds a 1-bit-per-pixel bitmap the same way Odoo does: it renders the
 * whole ticket to a canvas, then base64-encodes the raw mono pixels.
 * Here we draw a simple frame plus diagonal stripes so any scaling or
 * bit-order problem is obvious on paper.
 */
function imageTicket() {
  const width = 384;              // 48mm of dots; use 576 for full 80mm
  const height = 160;
  const rowBytes = width / 8;
  const buf = Buffer.alloc(rowBytes * height, 0);

  const setPixel = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    buf[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  };

  for (let x = 0; x < width; x++) {
    for (let t = 0; t < 3; t++) { setPixel(x, t); setPixel(x, height - 1 - t); }
  }
  for (let y = 0; y < height; y++) {
    for (let t = 0; t < 3; t++) { setPixel(t, y); setPixel(width - 1 - t, y); }
  }
  for (let d = 0; d < width + height; d += 16) {
    for (let y = 0; y < height; y++) {
      const x = d - y;
      setPixel(x, y); setPixel(x + 1, y);
    }
  }

  return envelope(
    `<image width="${width}" height="${height}" color="color_1" mode="mono">`
    + buf.toString('base64')
    + '</image>'
    + '<feed line="1"/>'
    + '<text align="center">raster test ok&#10;</text>'
    + '<cut type="feed"/>'
  );
}

function send(xml, label) {
  return new Promise((resolve) => {
    const url = new URL('/cgi-bin/epos/service.cgi', BRIDGE);
    const lib = url.protocol === 'https:' ? https : http;
    const body = Buffer.from(xml, 'utf8');

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': body.length,
        SOAPAction: '""'
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const ok = /success="true"/.test(data);
        console.log(`${label}: HTTP ${res.statusCode} — ${ok ? 'PRINTED OK' : 'FAILED'}`);
        if (!ok) console.log(data.trim());
        resolve(ok);
      });
    });

    req.on('error', (err) => {
      console.log(`${label}: could not reach the bridge at ${BRIDGE} — ${err.message}`);
      console.log('  Is server.js running?');
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

// server.js reuses the tickets for its status-page test buttons.
module.exports = { textTicket, imageTicket };

if (require.main === module) {
  (async () => {
    console.log(`sending to ${BRIDGE}`);
    if (mode === 'text' || mode === 'both') await send(textTicket, 'text ticket');
    if (mode === 'image' || mode === 'both') await send(imageTicket(), 'image ticket');
  })();
}
