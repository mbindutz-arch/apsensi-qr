'use strict';
// Backup database yang aman dipakai saat server berjalan:  npm run backup
// Hasil: data/backup/absensi-YYYY-MM-DD-HH-MM-SS.db
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const src = path.join(dataDir, 'absensi.db');
if (!fs.existsSync(src)) { console.error('Database belum ada: ' + src); process.exit(1); }

const dir = path.join(dataDir, 'backup');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = path.join(dir, `absensi-${stamp}.db`);

const db = openDb(src);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log('Backup dibuat: ' + out);
