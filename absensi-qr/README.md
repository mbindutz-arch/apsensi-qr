# QR Absensi — Backend + Frontend

Sistem absensi berbasis QR Code. QR dibuat **otomatis** untuk setiap peserta, discan petugas lewat kamera
(atau scanner USB / input manual), dan tercatat di database dengan perlindungan **anti absen ganda**.
Dirancang untuk ±300 peserta, tetapi tetap ringan sampai ribuan.

- **Backend:** Node.js (≥ 22.13) + SQLite bawaan Node — **tanpa `npm install`**, tanpa dependency.
- **Frontend:** HTML/CSS/JS biasa (hasil perbaikan dari `fr.zip`), dilayani langsung oleh server yang sama.

## Mulai cepat

```bash
node -v            # harus 22.13 atau lebih baru
npm start          # server jalan di http://localhost:3000
npm run seed       # (opsional) isi 300 peserta dummy untuk uji coba
npm test           # jalankan 12 tes otomatis backend
```

Buka `http://localhost:3000` dan login:

| Peran   | Username  | Password      |
|---------|-----------|---------------|
| Admin   | `admin`   | `admin123`    |
| Petugas | `petugas` | `petugas123`  |

> **Ganti password** di menu *Pengaturan* sebelum dipakai sungguhan (atau set `ADMIN_PASSWORD` /
> `PETUGAS_PASSWORD` sebelum menjalankan server pertama kali).

Event contoh untuk hari ini dibuat otomatis dengan jam **00:00–23:59** supaya langsung bisa dites.
Atur jam sebenarnya di menu **Jadwal Event**.

## Foto peserta & logo aplikasi

- **Logo aplikasi**: menu *Pengaturan* → *Logo Aplikasi* (admin). Logo tampil di sidebar, layar login, dan
  sebagai watermark transparan di kartu QR & laporan yang dicetak.
- **Foto peserta**: diisi lewat form *Tambah/Edit Peserta* di menu *Master Data & QR*. Foto langsung tampil
  sebagai avatar di daftar peserta, daftar kehadiran, dan — yang terpenting — di **panel petugas begitu QR
  peserta discan**, bersanding dengan nama, jabatan, ID, dan jam absen.
- Gambar diperkecil otomatis di browser (maks. ±480px, JPEG) sebelum dikirim, jadi tidak perlu library
  image-processing di server. Disimpan sebagai file biasa di `data/uploads/` (bukan di database) dan dilayani
  tanpa header login (supaya bisa dipakai langsung sebagai `<img src>`) — jangan sebarkan link foto ke pihak
  yang tidak berkepentingan.

## Alur penggunaan

1. **Admin** menambah peserta (satu per satu, atau *Import CSV* untuk 300 sekaligus). Setiap peserta langsung
   mendapat **token QR acak** (32 karakter) — tidak perlu klik apa pun.
2. Admin mencetak kartu: tombol **Cetak Semua QR** (satu halaman berisi semua kartu), atau **Buat QR** per peserta
   lalu *Unduh PNG*.
3. Atur **Jadwal Event** (tanggal, jam mulai, jam selesai).
4. **Petugas** login di HP/laptop → *Absensi* → **Mulai Scan QR**. Scanner tetap menyala untuk peserta berikutnya;
   hasil tampil hijau (berhasil), kuning (sudah absen), atau merah (ditolak) disertai bunyi.
5. Admin memantau di Dashboard / Monitoring dan mengekspor **Excel** atau **PDF** di menu *Export Hasil Absen*.

### Kenapa QR tidak berisi nama?

QR hanya berisi token acak. Nama/ID peserta tidak ada di dalam QR, sehingga **QR tidak bisa dipalsukan**
dengan menulis data sendiri (versi lama berisi JSON `{id, name}` yang bisa dibuat siapa saja).
Jika kartu hilang, klik **Buat ulang QR** — token lama otomatis tidak berlaku.

## Aturan absensi

- Satu peserta hanya bisa tercatat **sekali per event** (`UNIQUE(event_id, participant_id)` di database),
  aman walau dua petugas memindai QR yang sama di detik yang sama.
- Scan hanya diterima antara **jam mulai** dan **jam selesai** event (jam server, zona waktu bisa diatur).
- Status **tidak disimpan** sebagai baris, melainkan dihitung:
  ada catatan → *Hadir*; tidak ada & event masih berjalan/belum mulai → *Belum absen*;
  tidak ada & event sudah ditutup → *Tidak hadir*. Jadi tidak butuh cron job.
- Absen manual (ketik ID, mis. `EMP-001`) tersedia untuk petugas dan admin, tercatat sebagai `manual`.
  Admin bisa membatalkan absensi yang salah.
- Peserta yang punya riwayat absensi tidak dihapus permanen, hanya dinonaktifkan.

## Struktur proyek

```
server.js            HTTP server + semua route API + penyaji file statis
src/db.js            skema SQLite, transaksi, data awal
src/auth.js          hash password (scrypt), JWT HS256, token QR
src/xlsx.js          pembuat file .xlsx (tanpa dependency)
src/util.js          zona waktu, status event, validasi, rate limiter
public/              frontend (index.html, script.js, styles.css)
public/vendor/       qr-encoder.js = generator QR offline (MIT)
scripts/seed.js      data dummy       |  scripts/backup.js  backup database
test/api.test.js     tes otomatis backend
data/                database & secret (dibuat otomatis, jangan di-commit)
data/uploads/        foto peserta & logo aplikasi (dibuat otomatis, jangan di-commit)
```

## API ringkas

Semua endpoint `/api/*` memakai header `Authorization: Bearer <token>` kecuali login.
Error selalu berbentuk `{"error":{"code":"...","message":"..."}}`.

| Method & path | Akses | Fungsi |
|---|---|---|
| `POST /api/auth/login` | publik | login → token JWT (12 jam) |
| `GET /api/auth/me`, `POST /api/auth/password` | login | profil, ganti password |
| `GET /api/dashboard` | login | event aktif + ringkasan + kehadiran terbaru |
| `POST /api/scan` `{token}` | login | catat absen dari QR → `OK` / `ALREADY` |
| `POST /api/attendance/manual` `{code}` | login | absen manual via ID peserta |
| `GET /api/attendance?status=&q=&limit=` | login | daftar kehadiran event aktif |
| `DELETE /api/attendance/:id` | admin | batalkan absensi |
| `GET/POST /api/participants` | admin | daftar / tambah (kode & token QR otomatis) |
| `POST /api/participants/import` | admin | import banyak peserta (maks 2000/permintaan) |
| `PUT/DELETE /api/participants/:id` | admin | ubah / hapus-atau-nonaktifkan |
| `POST /api/participants/:id/regenerate-qr` | admin | ganti token QR |
| `GET/POST/PUT/DELETE /api/events` | admin (GET: login) | jadwal event |
| `GET /api/reports/summary?from=&to=&jabatan=` | admin | ringkasan laporan (`&rows=1` untuk detail) |
| `GET /api/reports/attendance.xlsx?from=&to=` | admin | unduh Excel |
| `GET/POST/DELETE /api/users` | admin | akun petugas |
| `GET/PUT /api/settings` | login / admin | nama aplikasi, zona waktu, `logo_url` |
| `POST/DELETE /api/settings/logo` | admin | unggah/hapus logo aplikasi (`{"image":"data:image/png;base64,..."}`) |
| `POST/DELETE /api/participants/:id/photo` | admin | unggah/hapus foto peserta (format sama seperti logo) |

Kode hasil `/api/scan`: `OK`, `ALREADY` (200); error: `QR_INVALID` (404), `EVENT_NOT_STARTED` / `EVENT_CLOSED` (409),
`PARTICIPANT_INACTIVE` (403), `RATE_LIMIT` (429).

## Konfigurasi (environment variable)

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | alamat server |
| `DATA_DIR` | `./data` | lokasi database & secret |
| `JWT_SECRET` | dibuat otomatis di `data/jwt.secret` | kunci penanda token login |
| `APP_TZ` | `Asia/Jakarta` | zona waktu awal |
| `ADMIN_PASSWORD`, `PETUGAS_PASSWORD` | `admin123`, `petugas123` | password akun awal |
| `LOGIN_MAX` / `SCAN_MAX` | `10` per 15 menit / `300` per menit | batas laju |
| `TRUST_PROXY` | – | isi `1` jika di belakang reverse proxy (agar IP asli terbaca) |
| `CORS_ORIGIN` | – | isi jika frontend dilayani dari domain lain |

## Hari-H: checklist

1. **Kamera butuh HTTPS.** Browser hanya mengaktifkan kamera di `https://…` atau `http://localhost`.
   - Laptop sendiri: `http://localhost:3000` sudah cukup.
   - HP petugas: pakai HTTPS. Opsi tercepat untuk uji: tunnel (mis. `cloudflared tunnel --url http://localhost:3000`
     atau `ngrok http 3000`). Opsi produksi: reverse proxy, contoh Caddy:
     ```
     absensi.contoh.com {
         reverse_proxy localhost:3000
     }
     ```
     lalu jalankan server dengan `TRUST_PROXY=1`.
   - Tanpa HTTPS, scanner kamera tidak aktif, tetapi **input manual / scanner USB tetap berfungsi**.
2. **Scanner kamera** memuat library `html5-qrcode`. Pertama dari `public/vendor/html5-qrcode.min.js` (jika Anda
   menaruhnya di sana, berguna untuk jaringan tanpa internet), lalu dari CDN unpkg/jsDelivr. Pembuat QR sendiri
   sudah offline.
3. Uji dulu dengan `npm run seed` + 2–3 HP sekaligus, lalu **hapus data dummy** (atau pakai folder `DATA_DIR` terpisah).
4. **Backup** sebelum acara dan sesudahnya: `npm run backup` (aman saat server berjalan).
5. Ganti password akun awal, lalu buat akun petugas per pos di menu *Akun Petugas*.
6. Jalankan sebagai layanan agar hidup lagi setelah restart (pm2: `pm2 start server.js --name absensi`,
   atau systemd).

## Hasil uji

- `npm test`: 12 tes backend (login & role, kode otomatis, import 300 peserta, **606 scan serentak untuk 303 peserta
  → tepat 303 catatan, nol dobel**, status event, laporan, file `.xlsx` valid, akun, path traversal).
- Uji browser (Chromium headless) terhadap server asli dengan 300 peserta: login, dashboard, tambah/import peserta,
  QR digambar lalu **dibaca ulang dengan decoder QR** (isinya cocok dengan token), scan benar/salah/ganda,
  event ditutup, ekspor Excel & cetak, hak akses petugas, tampilan HP.

## Perubahan dari frontend lama (`fr.zip`)

- Data demo/`localStorage` diganti API backend; statistik dashboard dihitung dari database.
- Login sungguhan; hak akses dicek di server (bukan sekadar menyembunyikan menu).
- QR berisi token acak (bukan JSON nama); format lama ditolak server.
- **Bug diperbaiki:** modal tidak pernah tampil (JS memakai class `open`, CSS memakai `show`); variabel CSS yang
  tidak ada (`--text-muted`, `--success`, `--danger`); elemen scanner `#reader` vs CSS `#qrReader`;
  filter status `"Tidak Hadir"` vs data `"Tidak hadir"`; tabel absensi 5 header tapi 6 kolom; `</div>` berlebih
  di dashboard; typo `absensi-ao y`; nama peserta disisipkan lewat `innerHTML` (celah XSS) — kini di-escape.
- Scanner kini **terus aktif** (tidak menutup setelah satu scan), ada jeda anti-scan-ganda, bunyi bip, dan input
  manual/scanner USB.
- Fitur baru: import CSV, cetak semua QR, unduh kartu QR PNG, ekspor Excel asli, cetak/PDF laporan, kelola event,
  kelola akun petugas, ganti password, pengaturan nama aplikasi & zona waktu.

## Jika nanti pindah ke PostgreSQL/MySQL

Skema ada di `src/db.js` dan sangat sederhana (5 tabel). Semua query ada di `server.js` memakai SQL standar
(`ON CONFLICT DO NOTHING` setara dengan `INSERT IGNORE` di MySQL). Untuk 300 peserta, SQLite (mode WAL) sudah
lebih dari cukup; pindah hanya perlu jika Anda menjalankan beberapa server sekaligus.
