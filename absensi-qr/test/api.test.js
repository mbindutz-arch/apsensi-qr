'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { nowParts } = require('../src/util');

let app, base, adminTok, petugasTok;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-test-'));

async function call(method, url, { token, body, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, data };
}
const login = async (username, password) => (await call('POST', '/api/auth/login', { body: { username, password } })).data.token;

before(async () => {
  app = createApp({ dataDir: tmp, quiet: true, loginMax: 1000, scanMax: 100000 });
  base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1'));
  adminTok = await login('admin', 'admin123');
  petugasTok = await login('petugas', 'petugas123');
});
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('health & login', async () => {
  assert.equal((await call('GET', '/api/health')).data.ok, true);
  const bad = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'salah' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error.code, 'BAD_CREDENTIALS');
  assert.ok(adminTok && petugasTok);
  assert.equal((await call('GET', '/api/auth/me', { token: adminTok })).data.user.role, 'admin');
});

test('endpoint butuh login & role dicek di server', async () => {
  assert.equal((await call('GET', '/api/dashboard')).status, 401);
  assert.equal((await call('GET', '/api/dashboard', { token: 'abc.def.ghi' })).status, 401);
  assert.equal((await call('GET', '/api/participants', { token: petugasTok })).status, 403);
  assert.equal((await call('POST', '/api/events', { token: petugasTok, body: {} })).status, 403);
});

test('peserta: buat otomatis kode + token QR, duplikat ditolak', async () => {
  const r = await call('POST', '/api/participants', { token: adminTok, body: { name: '  Andi   Pratama ', jabatan: 'Ketua' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.code, 'EMP-001');
  assert.match(r.data.qr_token, /^[0-9a-f]{32}$/);
  assert.equal(r.data.name, 'Andi Pratama');
  const dup = await call('POST', '/api/participants', { token: adminTok, body: { name: 'X', code: 'emp-001' } });
  assert.equal(dup.status, 409);
  assert.equal((await call('POST', '/api/participants', { token: adminTok, body: { name: '' } })).status, 400);
});

test('scan: OK -> ALREADY, token salah, manual, role petugas', async () => {
  const list = (await call('GET', '/api/participants', { token: adminTok })).data.data;
  const p = list[0];
  const s1 = await call('POST', '/api/scan', { token: petugasTok, body: { token: p.qr_token } });
  assert.equal(s1.status, 200);
  assert.equal(s1.data.code, 'OK');
  assert.equal(s1.data.participant.name, 'Andi Pratama');
  const s2 = await call('POST', '/api/scan', { token: petugasTok, body: { token: p.qr_token } });
  assert.equal(s2.data.code, 'ALREADY');
  assert.equal(s2.data.scanned_at, s1.data.scanned_at);
  const bad = await call('POST', '/api/scan', { token: petugasTok, body: { token: 'f'.repeat(32) } });
  assert.equal(bad.status, 404);
  assert.equal(bad.data.error.code, 'QR_INVALID');
  assert.equal((await call('POST', '/api/scan', { token: petugasTok, body: { token: '{"id":"EMP-001"}' } })).data.error.code, 'QR_INVALID');
  const man = await call('POST', '/api/attendance/manual', { token: petugasTok, body: { code: 'emp-001' } });
  assert.equal(man.data.code, 'ALREADY');
  assert.equal((await call('POST', '/api/attendance/manual', { token: petugasTok, body: { code: 'NOPE' } })).status, 404);
});

test('regenerate QR membuat token lama tidak berlaku', async () => {
  const p = (await call('POST', '/api/participants', { token: adminTok, body: { name: 'Budi Santoso' } })).data;
  const re = await call('POST', `/api/participants/${p.id}/regenerate-qr`, { token: adminTok });
  assert.notEqual(re.data.qr_token, p.qr_token);
  assert.equal((await call('POST', '/api/scan', { token: petugasTok, body: { token: p.qr_token } })).data.error.code, 'QR_INVALID');
  assert.equal((await call('POST', '/api/scan', { token: petugasTok, body: { token: re.data.qr_token } })).data.code, 'OK');
});

test('status event: belum mulai / ditutup / dibuka', async () => {
  const ev = (await call('GET', '/api/events/current', { token: adminTok })).data.event;
  assert.equal(ev.state, 'open');
  const p = (await call('POST', '/api/participants', { token: adminTok, body: { name: 'Citra Dewi' } })).data;
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

  await call('PUT', `/api/events/${ev.id}`, { token: adminTok, body: { event_date: day(-2) } });
  const closed = await call('POST', '/api/scan', { token: petugasTok, body: { token: p.qr_token, event_id: ev.id } });
  assert.equal(closed.status, 409);
  assert.equal(closed.data.error.code, 'EVENT_CLOSED');

  await call('PUT', `/api/events/${ev.id}`, { token: adminTok, body: { event_date: day(3) } });
  const early = await call('POST', '/api/scan', { token: petugasTok, body: { token: p.qr_token, event_id: ev.id } });
  assert.equal(early.data.error.code, 'EVENT_NOT_STARTED');

  const today = nowParts('Asia/Jakarta').date;
  await call('PUT', `/api/events/${ev.id}`, { token: adminTok, body: { event_date: today } });
  assert.equal((await call('GET', '/api/events/current', { token: adminTok })).data.event.state, 'open');
  assert.equal((await call('PUT', `/api/events/${ev.id}`, { token: adminTok, body: { start_time: '10:00', end_time: '09:00' } })).status, 400);
});

test('import 300 peserta + 600 scan bersamaan => tepat 300 absen (tanpa dobel)', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ name: `Peserta ${i + 1}`, jabatan: 'Anggota' }));
  rows.push({ name: '' }, { name: 'Dobel', code: 'EMP-001' });
  const imp = await call('POST', '/api/participants/import', { token: adminTok, body: { rows } });
  assert.equal(imp.data.created, 300);
  assert.equal(imp.data.skipped.length, 2);

  const all = (await call('GET', '/api/participants?limit=2000', { token: adminTok })).data.data;
  assert.equal(all.length, 303);
  const before = app.db.prepare('SELECT COUNT(*) AS c FROM attendances').get().c; // Andi & Budi
  const t0 = Date.now();
  const results = await Promise.all(all.concat(all).map((p) => call('POST', '/api/scan', { token: petugasTok, body: { token: p.qr_token } })));
  const ms = Date.now() - t0;
  const ok = results.filter((r) => r.data.code === 'OK').length;
  const already = results.filter((r) => r.data.code === 'ALREADY').length;
  assert.equal(ok, all.length - before, 'tiap peserta baru hanya boleh dicatat satu kali');
  assert.equal(ok + already, all.length * 2);
  const count = app.db.prepare('SELECT COUNT(*) AS c FROM attendances').get().c;
  const uniq = app.db.prepare('SELECT COUNT(DISTINCT participant_id) AS c FROM attendances').get().c;
  assert.equal(count, all.length);
  assert.equal(uniq, count, 'tidak boleh ada absen ganda');
  const sum = (await call('GET', '/api/dashboard', { token: adminTok })).data.summary;
  assert.equal(sum.hadir, 303);
  assert.equal(sum.belum_absen, 0);
  console.log(`   ${all.length * 2} request scan serentak dalam ${ms} ms (~${Math.round((all.length * 2) / (ms / 1000))} req/dtk)`);
});

test('daftar absensi, filter status, dan ringkasan', async () => {
  await call('POST', '/api/participants', { token: adminTok, body: { name: 'Belum Hadir' } });
  const sum = (await call('GET', '/api/dashboard', { token: petugasTok })).data;
  const total = sum.summary.total;
  assert.equal(sum.summary.belum_absen, 1);
  assert.equal(sum.summary.hadir + sum.summary.belum_absen + sum.summary.tidak_hadir, total);
  const belum = (await call('GET', '/api/attendance?status=' + encodeURIComponent('Belum absen'), { token: petugasTok })).data;
  assert.equal(belum.total, sum.summary.belum_absen);
  assert.ok(belum.data.every((r) => r.status === 'Belum absen'));
  const hadir = (await call('GET', '/api/attendance?status=Hadir&sort=latest&limit=5', { token: petugasTok })).data;
  assert.equal(hadir.data.length, 5);
  assert.match(hadir.data[0].time, /^\d\d:\d\d:\d\d$/);
  const q = (await call('GET', '/api/attendance?q=Peserta%201&limit=1000', { token: petugasTok })).data;
  assert.ok(q.data.length > 0 && q.data.every((r) => /peserta 1/i.test(r.name)));
});

test('hapus/nonaktifkan peserta & batalkan absen (admin)', async () => {
  const list = (await call('GET', '/api/participants?q=Andi', { token: adminTok })).data.data;
  const andi = list[0];
  const del = await call('DELETE', `/api/participants/${andi.id}`, { token: adminTok });
  assert.equal(del.data.deactivated, true);
  assert.equal((await call('POST', '/api/scan', { token: petugasTok, body: { token: andi.qr_token } })).data.error.code, 'PARTICIPANT_INACTIVE');

  const att = (await call('GET', '/api/attendance?status=Hadir&limit=1', { token: adminTok })).data.data[0];
  assert.equal((await call('DELETE', `/api/attendance/${att.attendance_id}`, { token: petugasTok })).status, 403);
  assert.equal((await call('DELETE', `/api/attendance/${att.attendance_id}`, { token: adminTok })).data.deleted, true);
});

test('laporan JSON & export XLSX', async () => {
  const today = nowParts('Asia/Jakarta').date;
  const rep = await call('GET', `/api/reports/summary?from=${today}&to=${today}&rows=1`, { token: adminTok });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.summary.events, 1);
  assert.equal(rep.data.rows.length, rep.data.summary.total_records);
  assert.equal((await call('GET', '/api/reports/summary?from=2026-13-01&to=2026-01-01', { token: adminTok })).status, 400);
  assert.equal((await call('GET', `/api/reports/summary?from=${today}&to=${today}`, { token: petugasTok })).status, 403);
  const x = await call('GET', `/api/reports/attendance.xlsx?from=${today}&to=${today}`, { token: adminTok, raw: true });
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /\.xlsx/);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  fs.writeFileSync(path.join(os.tmpdir(), 'laporan-test.xlsx'), buf);
});

test('akun: tambah petugas, ganti password, proteksi admin terakhir', async () => {
  assert.equal((await call('POST', '/api/users', { token: adminTok, body: { username: 'gate1', password: 'rahasia123', role: 'petugas' } })).status, 201);
  assert.equal((await call('POST', '/api/users', { token: adminTok, body: { username: 'gate1', password: 'rahasia123' } })).status, 409);
  assert.equal((await call('POST', '/api/users', { token: adminTok, body: { username: 'x', password: '1' } })).status, 400);
  assert.ok(await login('gate1', 'rahasia123'));
  const me = (await call('GET', '/api/auth/me', { token: adminTok })).data.user;
  assert.equal((await call('DELETE', `/api/users/${me.id}`, { token: adminTok })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { token: petugasTok, body: { old_password: 'salah', new_password: 'passwordbaru1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { token: petugasTok, body: { old_password: 'petugas123', new_password: 'passwordbaru1' } })).status, 200);
  assert.ok(await login('petugas', 'passwordbaru1'));
});

test('static: frontend dilayani, path traversal ditolak', async () => {
  const html = await fetch(base + '/');
  assert.ok([200, 404].includes(html.status));
  const trav = await fetch(base + '/..%2fserver.js');
  assert.ok([403, 404].includes(trav.status));
  assert.equal((await fetch(base + '/api/tidak-ada')).status, 404);
});
