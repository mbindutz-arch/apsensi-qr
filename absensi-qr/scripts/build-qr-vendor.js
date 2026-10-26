// Membangun public/vendor/qr-encoder.js (encoder QR offline, tanpa CDN)
// Sumber: modul QRCode (Kazuhiko Arase, lisensi MIT) -> dibungkus jadi satu file browser.
// File hasilnya sudah disertakan di repo; jalankan ulang hanya jika ingin membangun ulang:
//   node scripts/build-qr-vendor.js <folder-QRCode>
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/build-qr-vendor.js <folder vendor/QRCode>');
  process.exit(1);
}

const defs = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const name = './' + f.replace(/\.js$/, '');
  defs.push(`${JSON.stringify(name)}: function (module, exports, require) {\n${fs.readFileSync(path.join(dir, f), 'utf8')}\n}`);
}

const out = `/*! qr-encoder.js — QR Code generator (MIT)
 * Copyright (c) 2009 Kazuhiko Arase — http://www.d-project.com/ — Licensed under the MIT license.
 * "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
 * Dibungkus untuk browser; menyediakan window.QRLite.
 */
(function (global) {
  'use strict';
  var defs = {
${defs.join(',\n')}
  };
  var cache = {};
  function req(name) {
    if (name === '.' || name === './') name = './index';
    if (cache[name]) return cache[name].exports;
    if (!defs[name]) throw new Error('module not found: ' + name);
    var module = cache[name] = { exports: {} };
    defs[name](module, module.exports, req);
    return module.exports;
  }
  var QRCode = req('./index');
  var ECL = req('./QRErrorCorrectLevel');

  function build(text, level) {
    var q = new QRCode(-1, ECL[level || 'M']);
    q.addData(String(text));
    q.make();
    return q;
  }

  // Menggambar ke <canvas>. opts: { size, level, dark, light }
  function toCanvas(text, opts) {
    opts = opts || {};
    var q = build(text, opts.level);
    var n = q.getModuleCount();
    var quiet = 4;
    var cell = Math.max(2, Math.floor((opts.size || 220) / (n + quiet * 2)));
    var px = cell * (n + quiet * 2);
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = opts.dark || '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (q.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
    return canvas;
  }

  global.QRLite = {
    toCanvas: toCanvas,
    toDataURL: function (text, opts) { return toCanvas(text, opts).toDataURL('image/png'); },
    matrix: function (text, level) {
      var q = build(text, level), n = q.getModuleCount(), m = [];
      for (var r = 0; r < n; r++) { m.push([]); for (var c = 0; c < n; c++) m[r].push(q.isDark(r, c)); }
      return m;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;

fs.writeFileSync(path.join(__dirname, '..', 'public', 'vendor', 'qr-encoder.js'), out);
console.log('OK', out.length, 'bytes');
