'use strict';
// Mengisi data peserta dummy untuk uji coba:  npm run seed            (300 peserta)
//                                              npm run seed -- 500     (jumlah lain)
const path = require('node:path');
const { openDb, tx, bootstrap, nextParticipantNumber, formatCode } = require('../src/db');
const { newQrToken } = require('../src/auth');

const count = Math.max(1, Math.min(2000, Number(process.argv[2]) || 300));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = openDb(path.join(dataDir, 'absensi.db'));
bootstrap(db);

const FIRST = ['Andi', 'Budi', 'Citra', 'Dewi', 'Eko', 'Fajar', 'Gita', 'Hendra', 'Indah', 'Joko', 'Kartika', 'Lukman', 'Maya', 'Nanda', 'Oki', 'Putri', 'Qori', 'Rina', 'Sari', 'Tono', 'Umar', 'Vina', 'Wahyu', 'Xena', 'Yusuf', 'Zahra', 'Agus', 'Bayu', 'Dian', 'Erna', 'Fitri', 'Galih', 'Hani', 'Irfan', 'Jihan', 'Kevin', 'Laras', 'Mira', 'Nino', 'Octavia'];
const LAST = ['Pratama', 'Saputra', 'Wijaya', 'Lestari', 'Kusuma', 'Santoso', 'Hidayat', 'Permata', 'Nugroho', 'Maulana', 'Rahayu', 'Setiawan', 'Firmansyah', 'Anggraini', 'Gunawan', 'Utami', 'Purnomo', 'Susanto', 'Wulandari', 'Ramadhan', 'Siregar', 'Nasution', 'Hasibuan', 'Simanjuntak', 'Halim', 'Kurniawan', 'Yulianto', 'Handayani', 'Suryadi', 'Mahendra', 'Cahyono', 'Puspita', 'Prasetyo', 'Iskandar', 'Wibowo', 'Marlina', 'Basuki', 'Syahputra', 'Amalia', 'Darmawan'];

const exists = db.prepare('SELECT 1 FROM participants WHERE code = ?');
const ins = db.prepare('INSERT INTO participants (code, name, jabatan, qr_token) VALUES (?, ?, ?, ?)');
let made = 0;
tx(db, () => {
  let n = nextParticipantNumber(db);
  const start = n - 1;
  for (let i = 0; i < count; i++) {
    const code = formatCode(n++);
    if (exists.get(code)) continue;
    const idx = start + i;
    const name = `${FIRST[idx % FIRST.length]} ${LAST[Math.floor(idx / FIRST.length) % LAST.length]}`;
    const jabatan = idx === 0 ? 'Ketua' : idx <= 2 ? 'Wakil' : 'Anggota';
    ins.run(code, name, jabatan, newQrToken());
    made++;
  }
});
const total = db.prepare('SELECT COUNT(*) AS c FROM participants').get().c;
console.log(`Selesai: ${made} peserta dummy ditambahkan. Total peserta sekarang: ${total}.`);
db.close();
