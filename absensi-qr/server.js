'use strict';
/**
 * Backend Sistem Absensi QR — Node.js (>= 22.13) + SQLite bawaan Node, TANPA dependency npm.
 * Menjalankan API (/api/*) sekaligus melayani frontend dari folder /public.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb, tx, getSetting, setSetting, bootstrap, nextParticipantNumber, formatCode } = require('./src/db');
const auth = require('./src/auth');
const { httpError, HttpError, nowParts, eventState, isValidDate, isValidTime, cleanStr, escapeLike, makeLimiter, decodeImageDataUrl } = require('./src/util');
const { buildXlsx } = require('./src/xlsx');

const TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];
const CODE_RE = /^[A-Z0-9._-]{2,20}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // batas ukuran foto/logo setelah di-decode (sudah di-resize di browser)

const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const created = (data) => ({ __status: 201, data });
const rawReply = (body, headers) => ({ __raw: true, body, headers });

function createApp(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const dbFile = opts.dbFile || path.join(dataDir, 'absensi.db');
  const publicDir = path.resolve(opts.publicDir || path.join(__dirname, 'public'));
  const log = opts.quiet ? () => {} : console.log;
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
  const corsOrigin = opts.corsOrigin ?? process.env.CORS_ORIGIN ?? '';

  const db = openDb(dbFile);
  bootstrap(db, log);
  const secret = opts.secret || auth.loadSecret(dataDir);

  // ---- foto peserta & logo aplikasi: disimpan sebagai file di data/uploads, bukan di DB ----
  const uploadsDir = path.join(dataDir, 'uploads');
  const photosDir = path.join(uploadsDir, 'participants');
  const logoDir = path.join(uploadsDir, 'logo');
  fs.mkdirSync(photosDir, { recursive: true });
  fs.mkdirSync(logoDir, { recursive: true });

  // Hapus file lama dengan basename yang sama (ekstensi apa pun) sebelum menyimpan yang baru.
  function removeByBasename(dir, basename) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === basename || n.startsWith(basename + '.')) {
        try { fs.unlinkSync(path.join(dir, n)); } catch { /* abaikan */ }
      }
    }
  }

  // Simpan data-URL gambar (base64) ke disk; mengembalikan nama file (mis. "p-12.jpg") atau null bila body tidak berisi gambar baru.
  function saveImage(dir, basename, dataUrl) {
    if (dataUrl === undefined || dataUrl === null) return undefined; // tidak diubah
    removeByBasename(dir, basename);
    if (dataUrl === '') return null; // diminta dihapus
    const img = decodeImageDataUrl(dataUrl, MAX_IMAGE_BYTES);
    if (!img) throw httpError(400, 'VALIDATION', 'Gambar tidak valid. Gunakan JPG/PNG/WEBP, maksimal sekitar 1.5MB.');
    const filename = `${basename}.${img.ext}`;
    fs.writeFileSync(path.join(dir, filename), img.buffer, { mode: 0o644 });
    return filename;
  }

  const loginLimiter = makeLimiter(opts.loginMax ?? Number(process.env.LOGIN_MAX || 10), 15 * 60 * 1000);
  const scanLimiter = makeLimiter(opts.scanMax ?? Number(process.env.SCAN_MAX || 300), 60 * 1000);
  const lastSeenWrite = new Map();

  const tz = () => getSetting(db, 'timezone', 'Asia/Jakarta');

  // ───────────────────────── helper domain ─────────────────────────
  function currentEvent(now) {
    const today = db.prepare('SELECT * FROM events WHERE event_date = ? ORDER BY start_time').all(now.date);
    const ev = today.find((e) => eventState(e, now) === 'open')
      || today.find((e) => eventState(e, now) === 'upcoming')
      || today[today.length - 1]
      || db.prepare('SELECT * FROM events WHERE event_date > ? ORDER BY event_date, start_time LIMIT 1').get(now.date)
      || db.prepare('SELECT * FROM events ORDER BY event_date DESC, start_time DESC LIMIT 1').get();
    return ev ? { ...ev } : null;
  }

  function getEventOr404(id) {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!ev) throw httpError(404, 'NOT_FOUND', 'Event tidak ditemukan');
    return { ...ev };
  }

  function summary(ev, state) {
    const total = db.prepare("SELECT COUNT(*) AS c FROM participants WHERE status = 'Aktif'").get().c;
    const hadir = db.prepare("SELECT COUNT(*) AS c FROM attendances a JOIN participants p ON p.id = a.participant_id WHERE a.event_id = ? AND p.status = 'Aktif'").get(ev.id).c;
    const rest = total - hadir;
    return {
      total, hadir,
      belum_absen: state === 'closed' ? 0 : rest,
      tidak_hadir: state === 'closed' ? rest : 0,
      persen_hadir: total ? Math.round((hadir / total) * 1000) / 10 : 0,
    };
  }

  function listAttendance(ev, now, { q, status, jabatan, sort, limit, offset } = {}) {
    const state = eventState(ev, now);
    const zone = tz();
    const where = ["p.status = 'Aktif'"];
    const args = [ev.id];
    if (q) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(q)}%`;
      args.push(like, like);
    }
    if (jabatan) { where.push('p.jabatan = ?'); args.push(jabatan); }
    if (status === 'Hadir') where.push('a.id IS NOT NULL');
    else if (status === 'Tidak hadir') where.push(state === 'closed' ? 'a.id IS NULL' : '0');
    else if (status === 'Belum absen') where.push(state !== 'closed' ? 'a.id IS NULL' : '0');
    const base = `FROM participants p LEFT JOIN attendances a ON a.participant_id = p.id AND a.event_id = ? WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...args).c;
    const order = sort === 'latest'
      ? 'a.scanned_at IS NULL, a.scanned_at DESC, p.name COLLATE NOCASE'
      : 'p.name COLLATE NOCASE';
    const rows = db.prepare(
      `SELECT p.id AS participant_id, p.code, p.name, p.jabatan, p.photo, a.id AS attendance_id, a.scanned_at, a.method ${base} ORDER BY ${order}, p.id LIMIT ? OFFSET ?`,
    ).all(...args, limit ?? 500, offset ?? 0);
    return {
      total,
      data: rows.map((r) => ({
        participant_id: r.participant_id, attendance_id: r.attendance_id, code: r.code, name: r.name, jabatan: r.jabatan,
        photo_url: photoUrl(r.photo),
        status: r.attendance_id ? 'Hadir' : (state === 'closed' ? 'Tidak hadir' : 'Belum absen'),
        scanned_at: r.scanned_at, time: r.scanned_at ? nowParts(zone, new Date(r.scanned_at)).time : null,
        method: r.method,
      })),
    };
  }

  // Inti absensi: aman dari absen ganda berkat UNIQUE(event_id, participant_id)
  function markAttendance({ ev, participant, method, userId, now }) {
    const state = eventState(ev, now);
    if (state === 'upcoming') throw httpError(409, 'EVENT_NOT_STARTED', `Absensi baru dibuka pukul ${ev.start_time}`);
    if (state === 'closed') throw httpError(409, 'EVENT_CLOSED', 'Absensi sudah ditutup');
    if (participant.status !== 'Aktif') throw httpError(403, 'PARTICIPANT_INACTIVE', `${participant.name} berstatus nonaktif`);
    const scannedAt = new Date().toISOString();
    const r = db.prepare(
      'INSERT INTO attendances (event_id, participant_id, scanned_at, method, scanned_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id, participant_id) DO NOTHING',
    ).run(ev.id, participant.id, scannedAt, method, userId);
    let code = 'OK';
    let at = scannedAt;
    if (Number(r.changes) === 0) {
      code = 'ALREADY';
      at = db.prepare('SELECT scanned_at FROM attendances WHERE event_id = ? AND participant_id = ?').get(ev.id, participant.id).scanned_at;
    }
    const time = nowParts(tz(), new Date(at)).time;
    return {
      code,
      message: code === 'OK' ? `${participant.name} berhasil absen` : `${participant.name} sudah absen pukul ${time.slice(0, 5)}`,
      participant: { code: participant.code, name: participant.name, jabatan: participant.jabatan, photo_url: photoUrl(participant.photo) },
      scanned_at: at, time, method,
    };
  }

  function buildReport({ from, to, jabatan }) {
    if (!isValidDate(from) || !isValidDate(to)) throw httpError(400, 'VALIDATION', 'Parameter from/to harus berformat YYYY-MM-DD');
    if (from > to) throw httpError(400, 'VALIDATION', 'Tanggal awal tidak boleh melewati tanggal akhir');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw httpError(400, 'VALIDATION', 'Rentang laporan maksimal 366 hari');
    const zone = tz();
    const now = nowParts(zone);
    const args = [from, to];
    let jab = '';
    if (jabatan) { jab = 'AND p.jabatan = ?'; args.push(jabatan); }
    const raw = db.prepare(
      `SELECT e.id AS event_id, e.name AS event_name, e.event_date, e.start_time, e.end_time, p.code, p.name, p.jabatan, a.scanned_at, a.method
       FROM events e CROSS JOIN participants p
       LEFT JOIN attendances a ON a.event_id = e.id AND a.participant_id = p.id
       WHERE e.event_date BETWEEN ? AND ? AND p.status = 'Aktif' ${jab}
       ORDER BY e.event_date, e.start_time, p.name COLLATE NOCASE`,
    ).all(...args);
    const states = new Map();
    const events = new Set();
    const sum = { hadir: 0, tidak_hadir: 0, belum_absen: 0 };
    const rows = raw.map((r) => {
      if (!states.has(r.event_id)) states.set(r.event_id, eventState(r, now));
      events.add(r.event_id);
      let status;
      if (r.scanned_at) { status = 'Hadir'; sum.hadir++; }
      else if (states.get(r.event_id) === 'closed') { status = 'Tidak hadir'; sum.tidak_hadir++; }
      else { status = 'Belum absen'; sum.belum_absen++; }
      return {
        tanggal: r.event_date, event: r.event_name, code: r.code, name: r.name, jabatan: r.jabatan,
        jam: r.scanned_at ? nowParts(zone, new Date(r.scanned_at)).time : '', status,
        metode: r.scanned_at ? (r.method === 'manual' ? 'Manual' : 'QR') : '',
      };
    });
    const total = rows.length;
    return {
      from, to, jabatan: jabatan || null,
      summary: { events: events.size, total_records: total, ...sum, persen_hadir: total ? Math.round((sum.hadir / total) * 1000) / 10 : 0 },
      rows,
    };
  }

  const photoUrl = (filename) => (filename ? `/uploads/participants/${filename}` : null);
  const logoUrl = () => { const f = getSetting(db, 'app_logo', ''); return f ? `/uploads/logo/${f}` : null; };

  const publicParticipant = (p, withToken) => {
    const out = {
      id: p.id, code: p.code, name: p.name, jabatan: p.jabatan, status: p.status, created_at: p.created_at,
      photo_url: photoUrl(p.photo),
    };
    if (withToken) out.qr_token = p.qr_token;
    return out;
  };

  function validateEventBody(body, partial = false) {
    const out = {};
    if (!partial || body.name !== undefined) {
      out.name = cleanStr(body.name, 120);
      if (!out.name) throw httpError(400, 'VALIDATION', 'Nama event wajib diisi');
    }
    if (!partial || body.event_date !== undefined) {
      if (!isValidDate(body.event_date)) throw httpError(400, 'VALIDATION', 'Tanggal event tidak valid (YYYY-MM-DD)');
      out.event_date = body.event_date;
    }
    if (!partial || body.start_time !== undefined) {
      if (!isValidTime(body.start_time)) throw httpError(400, 'VALIDATION', 'Jam mulai tidak valid (HH:MM)');
      out.start_time = body.start_time;
    }
    if (!partial || body.end_time !== undefined) {
      if (!isValidTime(body.end_time)) throw httpError(400, 'VALIDATION', 'Jam selesai tidak valid (HH:MM)');
      out.end_time = body.end_time;
    }
    return out;
  }

  // ───────────────────────── routing ─────────────────────────
  const routes = [];
  function route(method, pattern, access, handler, bodyLimit = 256 * 1024) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, access, handler, bodyLimit });
  }

  // ---- publik
  route('GET', '/api/health', 'public', () => ({ ok: true, time: new Date().toISOString() }));
  route('GET', '/api/public/info', 'public', () => ({ app_name: getSetting(db, 'app_name', 'QR Absensi'), logo_url: logoUrl() }));

  // ---- auth
  route('POST', '/api/auth/login', 'public', ({ body, ip }) => {
    const username = cleanStr(body.username, 50).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!loginLimiter(`${ip}|${username}`)) throw httpError(429, 'RATE_LIMIT', 'Terlalu banyak percobaan login. Coba lagi beberapa menit lagi.');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = auth.verifyPassword(password, user && user.password_hash);
    if (!user || !ok) throw httpError(401, 'BAD_CREDENTIALS', 'Username atau password salah');
    const token = auth.signToken({ sub: user.id, username: user.username, role: user.role }, secret);
    return { token, user: { id: user.id, username: user.username, role: user.role } };
  });
  route('GET', '/api/auth/me', 'auth', ({ user }) => ({ user }));
  route('POST', '/api/auth/password', 'auth', ({ body, user }) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(String(body.old_password || ''), row.password_hash)) throw httpError(400, 'BAD_CREDENTIALS', 'Password lama salah');
    const np = String(body.new_password || '');
    if (np.length < 8) throw httpError(400, 'VALIDATION', 'Password baru minimal 8 karakter');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(np), user.id);
    return { ok: true };
  });

  // ---- pengaturan
  route('GET', '/api/settings', 'auth', () => ({ app_name: getSetting(db, 'app_name', 'QR Absensi'), timezone: tz(), logo_url: logoUrl() }));
  route('PUT', '/api/settings', 'admin', ({ body }) => {
    if (body.app_name !== undefined) {
      const n = cleanStr(body.app_name, 40);
      if (!n) throw httpError(400, 'VALIDATION', 'Nama aplikasi tidak boleh kosong');
      setSetting(db, 'app_name', n);
    }
    if (body.timezone !== undefined) {
      if (!TIMEZONES.includes(body.timezone)) throw httpError(400, 'VALIDATION', 'Zona waktu tidak didukung');
      setSetting(db, 'timezone', body.timezone);
    }
    return { app_name: getSetting(db, 'app_name', 'QR Absensi'), timezone: tz(), logo_url: logoUrl() };
  });

  // Logo aplikasi: dipakai sebagai brand di sidebar/login dan watermark di kartu QR & laporan cetak.
  route('POST', '/api/settings/logo', 'admin', ({ body }) => {
    const image = typeof body.image === 'string' ? body.image : '';
    if (!image) throw httpError(400, 'VALIDATION', 'Gambar logo wajib dikirim');
    const filename = saveImage(logoDir, 'app-logo', image);
    setSetting(db, 'app_logo', filename || '');
    return { logo_url: logoUrl() };
  }, 3 * 1024 * 1024);
  route('DELETE', '/api/settings/logo', 'admin', () => {
    removeByBasename(logoDir, 'app-logo');
    setSetting(db, 'app_logo', '');
    return { logo_url: null };
  });

  // ---- akun petugas
  route('GET', '/api/users', 'admin', () => {
    const rows = db.prepare('SELECT id, username, role, last_seen_at, created_at FROM users ORDER BY role, username').all();
    const cutoff = Date.now() - 2 * 60 * 1000;
    return { data: rows.map((u) => ({ ...u, online: !!u.last_seen_at && Date.parse(u.last_seen_at) >= cutoff })) };
  });
  route('POST', '/api/users', 'admin', ({ body }) => {
    const username = cleanStr(body.username, 30).toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw httpError(400, 'VALIDATION', 'Username 3–30 karakter (huruf kecil, angka, titik, strip, underscore)');
    const password = String(body.password || '');
    if (password.length < 8) throw httpError(400, 'VALIDATION', 'Password minimal 8 karakter');
    const role = body.role === 'admin' ? 'admin' : 'petugas';
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw httpError(409, 'DUPLICATE', 'Username sudah dipakai');
    const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, auth.hashPassword(password), role);
    return created({ id: Number(r.lastInsertRowid), username, role });
  });
  route('DELETE', '/api/users/:id', 'admin', ({ params, user }) => {
    const id = Number(params.id);
    if (id === user.id) throw httpError(400, 'VALIDATION', 'Tidak bisa menghapus akun yang sedang dipakai');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw httpError(404, 'NOT_FOUND', 'Akun tidak ditemukan');
    if (target.role === 'admin' && db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c <= 1) {
      throw httpError(400, 'VALIDATION', 'Harus ada minimal satu admin');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { deleted: true };
  });

  // ---- peserta (master data + QR)
  route('GET', '/api/participants', 'admin', ({ query }) => {
    const where = [];
    const args = [];
    if (query.q) {
      where.push("(name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(query.q)}%`;
      args.push(like, like);
    }
    if (query.status === 'Aktif' || query.status === 'Nonaktif') { where.push('status = ?'); args.push(query.status); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM participants ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT * FROM participants ${w} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`)
      .all(...args, clampInt(query.limit, 1, 2000, 1000), clampInt(query.offset, 0, 1e9, 0));
    return { total, data: rows.map((p) => publicParticipant(p, true)) };
  });

  route('POST', '/api/participants', 'admin', ({ body }) => {
    const name = cleanStr(body.name, 120);
    if (!name) throw httpError(400, 'VALIDATION', 'Nama wajib diisi');
    const jabatan = cleanStr(body.jabatan, 30) || 'Anggota';
    let code = cleanStr(body.code, 20).toUpperCase();
    if (code && !CODE_RE.test(code)) throw httpError(400, 'VALIDATION', 'ID hanya boleh huruf/angka/titik/strip/underscore (2–20 karakter)');
    return created(tx(db, () => {
      if (!code) code = formatCode(nextParticipantNumber(db));
      else if (db.prepare('SELECT 1 FROM participants WHERE code = ?').get(code)) throw httpError(409, 'DUPLICATE_CODE', 'ID peserta sudah dipakai');
      const r = db.prepare('INSERT INTO participants (code, name, jabatan, qr_token) VALUES (?, ?, ?, ?)').run(code, name, jabatan, auth.newQrToken());
      return publicParticipant(db.prepare('SELECT * FROM participants WHERE id = ?').get(Number(r.lastInsertRowid)), true);
    }));
  });

  route('POST', '/api/participants/import', 'admin', ({ body }) => {
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) throw httpError(400, 'VALIDATION', 'Data import kosong');
    if (rows.length > 2000) throw httpError(400, 'VALIDATION', 'Maksimal 2000 baris per import');
    return tx(db, () => {
      let n = nextParticipantNumber(db);
      let createdCount = 0;
      const skipped = [];
      const exists = db.prepare('SELECT 1 FROM participants WHERE code = ?');
      const ins = db.prepare('INSERT INTO participants (code, name, jabatan, qr_token) VALUES (?, ?, ?, ?)');
      rows.forEach((r, i) => {
        const line = i + 1;
        const name = cleanStr(r && r.name, 120);
        if (!name) { skipped.push({ row: line, reason: 'Nama kosong' }); return; }
        const jabatan = cleanStr(r.jabatan, 30) || 'Anggota';
        let code = cleanStr(r.code, 20).toUpperCase();
        if (code) {
          if (!CODE_RE.test(code)) { skipped.push({ row: line, name, reason: 'Format ID tidak valid' }); return; }
          if (exists.get(code)) { skipped.push({ row: line, name, reason: 'ID sudah dipakai' }); return; }
        } else {
          do { code = formatCode(n++); } while (exists.get(code));
        }
        ins.run(code, name, jabatan, auth.newQrToken());
        createdCount++;
      });
      return { created: createdCount, skipped };
    });
  }, 4 * 1024 * 1024);

  route('PUT', '/api/participants/:id', 'admin', ({ params, body }) => {
    const p = db.prepare('SELECT * FROM participants WHERE id = ?').get(Number(params.id));
    if (!p) throw httpError(404, 'NOT_FOUND', 'Peserta tidak ditemukan');
    const name = body.name !== undefined ? cleanStr(body.name, 120) : p.name;
    if (!name) throw httpError(400, 'VALIDATION', 'Nama wajib diisi');
    const jabatan = body.jabatan !== undefined ? (cleanStr(body.jabatan, 30) || p.jabatan) : p.jabatan;
    const status = body.status === 'Aktif' || body.status === 'Nonaktif' ? body.status : p.status;
    db.prepare('UPDATE participants SET name = ?, jabatan = ?, status = ? WHERE id = ?').run(name, jabatan, status, p.id);
    return publicParticipant(db.prepare('SELECT * FROM participants WHERE id = ?').get(p.id), true);
  });

  route('DELETE', '/api/participants/:id', 'admin', ({ params }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM participants WHERE id = ?').get(id)) throw httpError(404, 'NOT_FOUND', 'Peserta tidak ditemukan');
    if (db.prepare('SELECT 1 FROM attendances WHERE participant_id = ?').get(id)) {
      db.prepare("UPDATE participants SET status = 'Nonaktif' WHERE id = ?").run(id); // pertahankan riwayat absensi
      return { deleted: false, deactivated: true };
    }
    db.prepare('DELETE FROM participants WHERE id = ?').run(id);
    removeByBasename(photosDir, `p-${id}`);
    return { deleted: true, deactivated: false };
  });

  route('POST', '/api/participants/:id/regenerate-qr', 'admin', ({ params }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM participants WHERE id = ?').get(id)) throw httpError(404, 'NOT_FOUND', 'Peserta tidak ditemukan');
    db.prepare('UPDATE participants SET qr_token = ? WHERE id = ?').run(auth.newQrToken(), id);
    return publicParticipant(db.prepare('SELECT * FROM participants WHERE id = ?').get(id), true);
  });

  // Foto peserta: ditampilkan di panel petugas begitu QR-nya discan.
  route('POST', '/api/participants/:id/photo', 'admin', ({ params, body }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM participants WHERE id = ?').get(id)) throw httpError(404, 'NOT_FOUND', 'Peserta tidak ditemukan');
    const image = typeof body.image === 'string' ? body.image : '';
    if (!image) throw httpError(400, 'VALIDATION', 'Gambar foto wajib dikirim');
    const filename = saveImage(photosDir, `p-${id}`, image);
    db.prepare('UPDATE participants SET photo = ? WHERE id = ?').run(filename || null, id);
    return publicParticipant(db.prepare('SELECT * FROM participants WHERE id = ?').get(id), true);
  }, 3 * 1024 * 1024);
  route('DELETE', '/api/participants/:id/photo', 'admin', ({ params }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM participants WHERE id = ?').get(id)) throw httpError(404, 'NOT_FOUND', 'Peserta tidak ditemukan');
    removeByBasename(photosDir, `p-${id}`);
    db.prepare('UPDATE participants SET photo = NULL WHERE id = ?').run(id);
    return publicParticipant(db.prepare('SELECT * FROM participants WHERE id = ?').get(id), true);
  });

  // ---- event / jadwal
  route('GET', '/api/events', 'auth', () => {
    const now = nowParts(tz());
    const rows = db.prepare('SELECT * FROM events ORDER BY event_date DESC, start_time DESC LIMIT 200').all();
    return { data: rows.map((e) => ({ ...e, state: eventState(e, now) })) };
  });
  route('GET', '/api/events/current', 'auth', () => {
    const now = nowParts(tz());
    const ev = currentEvent(now);
    return { event: ev ? { ...ev, state: eventState(ev, now) } : null };
  });
  route('POST', '/api/events', 'admin', ({ body }) => {
    const v = validateEventBody(body);
    if (v.end_time < v.start_time) throw httpError(400, 'VALIDATION', 'Jam selesai tidak boleh lebih awal dari jam mulai');
    const r = db.prepare('INSERT INTO events (name, event_date, start_time, end_time) VALUES (?, ?, ?, ?)').run(v.name, v.event_date, v.start_time, v.end_time);
    return created({ id: Number(r.lastInsertRowid), ...v });
  });
  route('PUT', '/api/events/:id', 'admin', ({ params, body }) => {
    const ev = getEventOr404(Number(params.id));
    const merged = { ...ev, ...validateEventBody(body, true) };
    if (merged.end_time < merged.start_time) throw httpError(400, 'VALIDATION', 'Jam selesai tidak boleh lebih awal dari jam mulai');
    db.prepare('UPDATE events SET name = ?, event_date = ?, start_time = ?, end_time = ? WHERE id = ?')
      .run(merged.name, merged.event_date, merged.start_time, merged.end_time, ev.id);
    return merged;
  });
  route('DELETE', '/api/events/:id', 'admin', ({ params }) => {
    const ev = getEventOr404(Number(params.id));
    if (db.prepare('SELECT 1 FROM attendances WHERE event_id = ?').get(ev.id)) {
      throw httpError(409, 'HAS_ATTENDANCE', 'Event sudah memiliki data absensi dan tidak bisa dihapus');
    }
    db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
    return { deleted: true };
  });
  route('GET', '/api/events/:id/summary', 'auth', ({ params }) => {
    const ev = getEventOr404(Number(params.id));
    const state = eventState(ev, nowParts(tz()));
    return { event: { ...ev, state }, summary: summary(ev, state) };
  });

  route('GET', '/api/dashboard', 'auth', () => {
    const now = nowParts(tz());
    const base = { app_name: getSetting(db, 'app_name', 'QR Absensi'), timezone: tz(), now };
    const ev = currentEvent(now);
    if (!ev) return { ...base, event: null, summary: null, recent: [] };
    const state = eventState(ev, now);
    return {
      ...base, event: { ...ev, state }, summary: summary(ev, state),
      recent: listAttendance(ev, now, { status: 'Hadir', sort: 'latest', limit: 8 }).data,
    };
  });

  // ---- absensi
  route('GET', '/api/attendance', 'auth', ({ query }) => {
    const now = nowParts(tz());
    const ev = query.event_id ? getEventOr404(Number(query.event_id)) : currentEvent(now);
    if (!ev) return { event: null, total: 0, data: [] };
    const res = listAttendance(ev, now, {
      q: cleanStr(query.q || '', 100), status: query.status, jabatan: cleanStr(query.jabatan || '', 30),
      sort: query.sort, limit: clampInt(query.limit, 1, 1000, 500), offset: clampInt(query.offset, 0, 1e9, 0),
    });
    return { event: { ...ev, state: eventState(ev, now) }, ...res };
  });

  function resolveEvent(body, now) {
    const ev = body.event_id ? getEventOr404(Number(body.event_id)) : currentEvent(now);
    if (!ev) throw httpError(404, 'NO_EVENT', 'Belum ada event. Buat jadwal event terlebih dahulu.');
    return ev;
  }

  route('POST', '/api/scan', 'auth', ({ body, user }) => {
    if (!scanLimiter(`scan|${user.id}`)) throw httpError(429, 'RATE_LIMIT', 'Terlalu banyak scan. Tunggu sebentar.');
    const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : '';
    const now = nowParts(tz());
    const ev = resolveEvent(body, now);
    if (!TOKEN_RE.test(token)) throw httpError(404, 'QR_INVALID', 'QR Code tidak dikenali');
    const participant = db.prepare('SELECT * FROM participants WHERE qr_token = ?').get(token);
    if (!participant) throw httpError(404, 'QR_INVALID', 'QR Code tidak dikenali');
    return markAttendance({ ev, participant, method: 'qr', userId: user.id, now });
  });

  route('POST', '/api/attendance/manual', 'auth', ({ body, user }) => {
    if (!scanLimiter(`scan|${user.id}`)) throw httpError(429, 'RATE_LIMIT', 'Terlalu banyak permintaan. Tunggu sebentar.');
    const code = cleanStr(body.code, 20).toUpperCase();
    const now = nowParts(tz());
    const ev = resolveEvent(body, now);
    const participant = code && db.prepare('SELECT * FROM participants WHERE code = ?').get(code);
    if (!participant) throw httpError(404, 'NOT_FOUND', 'ID peserta tidak ditemukan');
    return markAttendance({ ev, participant, method: 'manual', userId: user.id, now });
  });

  route('DELETE', '/api/attendance/:id', 'admin', ({ params }) => {
    const r = db.prepare('DELETE FROM attendances WHERE id = ?').run(Number(params.id));
    if (Number(r.changes) === 0) throw httpError(404, 'NOT_FOUND', 'Data absensi tidak ditemukan');
    return { deleted: true };
  });

  // ---- laporan
  route('GET', '/api/reports/summary', 'admin', ({ query }) => {
    const rep = buildReport({ from: query.from, to: query.to, jabatan: cleanStr(query.jabatan || '', 30) });
    if (query.rows !== '1') delete rep.rows;
    return rep;
  });
  route('GET', '/api/reports/attendance.xlsx', 'admin', ({ query }) => {
    const rep = buildReport({ from: query.from, to: query.to, jabatan: cleanStr(query.jabatan || '', 30) });
    const buf = buildXlsx({
      sheetName: 'Absensi',
      headers: ['Tanggal', 'Event', 'ID', 'Nama', 'Jabatan', 'Jam Hadir', 'Status', 'Metode'],
      widths: [12, 28, 12, 30, 14, 11, 13, 10],
      rows: rep.rows.map((r) => [r.tanggal, r.event, r.code, r.name, r.jabatan, r.jam, r.status, r.metode]),
    });
    return rawReply(buf, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="absensi_${rep.from}_${rep.to}.xlsx"`,
    });
  });

  // ───────────────────────── HTTP plumbing ─────────────────────────
  function clientIp(req) {
    if (trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) return String(xf).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...headers });
    res.end(body);
  }
  const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

  function sendError(res, err) {
    if (res.headersSent) { res.end(); return; }
    if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    console.error('[error]', err);
    return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Terjadi kesalahan pada server' } });
  }

  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let tooLarge = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { tooLarge = true; return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return reject(httpError(413, 'TOO_LARGE', 'Data yang dikirim terlalu besar'));
        if (!chunks.length) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(httpError(400, 'BAD_JSON', 'Body harus berupa objek JSON'));
          resolve(parsed);
        } catch { reject(httpError(400, 'BAD_JSON', 'Body bukan JSON yang valid')); }
      });
      req.on('error', reject);
    });
  }

  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw httpError(401, 'UNAUTHORIZED', 'Silakan login terlebih dahulu');
    const payload = auth.verifyToken(m[1], secret);
    if (!payload) throw httpError(401, 'UNAUTHORIZED', 'Sesi berakhir, silakan login ulang');
    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(payload.sub);
    if (!user) throw httpError(401, 'UNAUTHORIZED', 'Akun tidak ditemukan');
    const now = Date.now();
    if (now - (lastSeenWrite.get(user.id) || 0) > 30000) {
      lastSeenWrite.set(user.id, now);
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), user.id);
    }
    return { id: user.id, username: user.username, role: user.role };
  }

  async function handleApi(req, res, url) {
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return send(res, 204, '');
    }
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const user = r.access === 'public' ? null : authenticate(req);
      if (r.access === 'admin' && user.role !== 'admin') throw httpError(403, 'FORBIDDEN', 'Anda tidak punya akses untuk aksi ini');
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req, r.bodyLimit) : {};
      const result = await r.handler({ req, params, query: Object.fromEntries(url.searchParams), body, user, ip: clientIp(req) });
      if (result && result.__raw) return send(res, 200, result.body, { 'Cache-Control': 'no-store', ...result.headers });
      if (result && result.__status) return sendJson(res, result.__status, result.data);
      return sendJson(res, 200, result);
    }
    throw pathMatched ? httpError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan') : httpError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan');
  }

  function serveFile(req, res, root, pathname, { cache = 'no-cache' } = {}) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain' });
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain' }); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      fs.readFile(file, (e2, data) => {
        if (e2) return send(res, 500, 'Server Error', { 'Content-Type': 'text/plain' });
        const ext = path.extname(file).toLowerCase();
        send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
      });
    });
  }

  function serveStatic(req, res, pathname) {
    const cache = pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache';
    serveFile(req, res, publicDir, pathname, { cache });
  }

  // Foto peserta & logo: file statis di luar /public (di data/uploads), tanpa perlu Authorization
  // header (supaya bisa dipakai langsung sebagai <img src>). Nama file memakai token acak/ID peserta,
  // jadi tidak mudah ditebak, tapi tetap dianggap semi-publik selama tautannya tidak disebar.
  function serveUploads(req, res, pathname) {
    const rel = pathname.slice('/uploads'.length) || '/';
    serveFile(req, res, uploadsDir, rel, { cache: 'public, max-age=300' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/uploads' || url.pathname.startsWith('/uploads/')) return serveUploads(req, res, url.pathname);
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      return sendError(res, err);
    }
  });
  server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

  return {
    server, db,
    listen: (port, host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.close(() => { try { db.close(); } catch { /* sudah tertutup */ } resolve(); }); server.closeAllConnections?.(); }),
  };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  app.listen(port, host).then((p) => {
    console.log(`\n  Absensi QR berjalan di  http://localhost:${p}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  (jaringan lokal)         http://${i.address}:${p}`);
    }
    console.log('  Catatan: kamera browser hanya aktif di localhost atau HTTPS.\n');
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
