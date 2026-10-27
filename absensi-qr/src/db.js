'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, newQrToken } = require('./auth');
const { nowParts } = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','petugas')),
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  jabatan    TEXT NOT NULL DEFAULT 'Anggota',
  status     TEXT NOT NULL DEFAULT 'Aktif' CHECK (status IN ('Aktif','Nonaktif')),
  qr_token   TEXT NOT NULL UNIQUE,
  photo      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(name);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  event_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE TABLE IF NOT EXISTS attendances (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  scanned_at     TEXT NOT NULL,
  method         TEXT NOT NULL DEFAULT 'qr' CHECK (method IN ('qr','manual')),
  scanned_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (event_id, participant_id)   -- kunci anti absen ganda
);
CREATE INDEX IF NOT EXISTS idx_att_event ON attendances(event_id);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Migrasi ringan: tambah kolom baru pada database lama tanpa menghapus data.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(participants)').all().map((c) => c.name);
  if (!cols.includes('photo')) db.exec('ALTER TABLE participants ADD COLUMN photo TEXT');
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Transaksi: BEGIN IMMEDIATE ... COMMIT / ROLLBACK
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* sudah rollback */ }
    throw err;
  }
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Data awal: akun default + 1 event hari ini (hanya jika tabel masih kosong)
function bootstrap(db, log = console.log) {
  const usersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (usersCount === 0) {
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const petugasPass = process.env.PETUGAS_PASSWORD || 'petugas123';
    const ins = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    ins.run('admin', hashPassword(adminPass), 'admin');
    ins.run('petugas', hashPassword(petugasPass), 'petugas');
    log('[init] Akun dibuat: admin / ' + adminPass + '  dan  petugas / ' + petugasPass + '  (GANTI di menu Pengaturan!)');
  }
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'app_name'").get()) setSetting(db, 'app_name', 'QR Absensi');
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'timezone'").get()) setSetting(db, 'timezone', process.env.APP_TZ || 'Asia/Jakarta');

  const eventsCount = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  if (eventsCount === 0) {
    const today = nowParts(getSetting(db, 'timezone', 'Asia/Jakarta')).date;
    db.prepare('INSERT INTO events (name, event_date, start_time, end_time) VALUES (?, ?, ?, ?)')
      .run('Absensi Hari Ini', today, '00:00', '23:59');
    log('[init] Event contoh dibuat untuk hari ini (00:00–23:59). Atur jamnya di menu Jadwal Event.');
  }
}

function nextParticipantNumber(db) {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM participants WHERE code GLOB 'EMP-[0-9]*'").get();
  return (row && row.n ? row.n : 0) + 1;
}
const formatCode = (n) => 'EMP-' + String(n).padStart(3, '0');

module.exports = { openDb, tx, getSetting, setSetting, bootstrap, nextParticipantNumber, formatCode, newQrToken };
