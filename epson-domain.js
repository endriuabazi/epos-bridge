#!/usr/bin/env node
/**
 * Works out the hostname Odoo will use for a given "serial number".
 *
 *   node epson-domain.js FRUTZA-KUZHINA
 *
 * Recent Odoo versions no longer accept an IP in the Epson printer field.
 * They take whatever you type as a printer serial number and derive Epson's
 * "certified domain" from it:
 *
 *     base32( sha256( serial ) ).toLowerCase()  +  ".omnilinkcert.epson.biz"
 *
 * Real Epson printers register that name with Epson's DNS so it resolves to
 * the printer on your LAN, and ship a matching certificate. We can't do that,
 * but we don't need to: the name is derived purely from the text you type, so
 * we point it at this machine with a hosts-file entry and issue our own
 * certificate for it.
 */

'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function certifiedDomain(serial) {
  const digest = crypto.createHash('sha256').update(serial, 'utf8').digest();
  return base32(digest).toLowerCase() + '.omnilinkcert.epson.biz';
}

// Sanity check against a value observed in the wild: Odoo turned the text
// "localhost:8080" into rmp5yrf5...omnilinkcert.epson.biz
const KNOWN_INPUT = 'localhost:8080';
const KNOWN_OUTPUT = 'rmp5yrf5v6oww667vc2hjbsmxrlum44txzcgq4cge3v2wxr772ua.omnilinkcert.epson.biz';

if (require.main === module) {
  if (certifiedDomain(KNOWN_INPUT) !== KNOWN_OUTPUT) {
    console.error('! Self-check failed — the derivation no longer matches Odoo.');
    process.exit(1);
  }

  const serial = process.argv[2];
  if (!serial) {
    console.log('');
    console.log('  Usage: node epson-domain.js <serial>');
    console.log('');
    console.log('  <serial> is any text you like — it is just the seed for the');
    console.log('  hostname. Pick something stable, e.g. FRUTZA-KUZHINA.');
    console.log('');
    process.exit(1);
  }

  const domain = certifiedDomain(serial);
  console.log('');
  console.log(`  serial typed into Odoo : ${serial}`);
  console.log(`  hostname Odoo will use : ${domain}`);
  console.log('');
  console.log('  Windows hosts file line (C:\\Windows\\System32\\drivers\\etc\\hosts):');
  console.log('');
  console.log(`    127.0.0.1    ${domain}`);
  console.log('');
}

module.exports = { certifiedDomain, base32 };
