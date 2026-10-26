/* QR Absensi — frontend. Semua data berasal dari API backend (/api/*). */
(() => {
'use strict';

// ───────────────────────── util ─────────────────────────
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONTHS_LONG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const TZ_LABEL = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' };
const JABATAN = ['Anggota', 'Ketua', 'Wakil'];

const fmtDate = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const fmtDateLong = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d} ${MONTHS_LONG[m - 1]} ${y}`;
};
const hm = (t) => (t ? String(t).slice(0, 5) : '—');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* abaikan */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* abaikan */ } },
};

const S = {
  token: store.get('qr_absensi_token'),
  user: null,
  settings: { app_name: 'QR Absensi', timezone: 'Asia/Jakarta' },
  event: null,
  dash: null,
  attendance: [],
  attEvent: null,
  participants: [],
  events: [],
  users: [],
  page: 'dashboard',
};

const tzNow = () => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: S.settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
};

let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ───────────────────────── API ─────────────────────────
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Tidak dapat terhubung ke server');
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  if (!res.ok) {
    const e = (data && data.error) || {};
    if (res.status === 401 && S.token) logout('Sesi berakhir, silakan login ulang.');
    throw new ApiError(res.status, e.code || 'ERROR', e.message || 'Terjadi kesalahan');
  }
  return data;
}

// ───────────────────────── modal ─────────────────────────
let modal = { onSave: null, onClose: null, open: false };

function openModal({ title, desc = '', html = '', onSave = null, saveLabel = 'Simpan', cancelLabel = 'Batal', hideSave = false, onClose = null }) {
  $('#modalTitle').textContent = title;
  $('#modalDesc').textContent = desc;
  $('#modalFields').innerHTML = html;
  const save = $('#modalSave');
  save.textContent = saveLabel;
  save.style.display = hideSave ? 'none' : '';
  save.disabled = false;
  $('#modalCancel').textContent = cancelLabel;
  modal = { onSave, onClose, open: true };
  $('#modalback').classList.add('show');
  const first = $('#modalFields input, #modalFields select');
  if (first && !hideSave) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  if (!modal.open) return;
  const cb = modal.onClose;
  modal = { onSave: null, onClose: null, open: false };
  $('#modalback').classList.remove('show');
  $('#modalFields').innerHTML = '';
  if (cb) cb();
  refreshCurrentSilently();
}

$('#modalCancel').addEventListener('click', closeModal);
$('#modalback').addEventListener('mousedown', (e) => { if (e.target.id === 'modalback') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#modalSave').addEventListener('click', async () => {
  if (!modal.onSave) return closeModal();
  const btn = $('#modalSave');
  btn.disabled = true;
  try {
    const keepOpen = await modal.onSave();
    if (keepOpen !== false) closeModal();
  } catch (e) {
    toast(e.message || 'Gagal menyimpan', 'error');
  } finally {
    btn.disabled = false;
  }
});

// ───────────────────────── auth & boot ─────────────────────────
function showLogin(message = '') {
  $('#appRoot').classList.add('is-hidden');
  $('#mobileTabs').classList.add('is-hidden');
  $('#loginScreen').classList.remove('is-hidden');
  $('#loginError').textContent = message;
  document.body.dataset.role = '';
  setTimeout(() => $('#loginUser').focus(), 30);
}

function logout(message = '') {
  S.token = null;
  S.user = null;
  store.del('qr_absensi_token');
  stopScanner();
  if (modal.open) { modal.onClose = null; closeModal(); }
  showLogin(message);
}

async function showApp() {
  document.body.dataset.role = S.user.role;
  $('#loginScreen').classList.add('is-hidden');
  $('#appRoot').classList.remove('is-hidden');
  $('#mobileTabs').classList.remove('is-hidden');
  $('#profileName').textContent = S.user.username;
  $('#profileRole').textContent = S.user.role === 'admin' ? 'Administrator' : 'Petugas Absen';
  $('#profileAvatar').textContent = initials(S.user.username).slice(0, 1) || 'A';
  try {
    const s = await api('/settings');
    S.settings = s;
    applyBrand();
  } catch { /* lanjut dengan default */ }
  showPage('dashboard');
}

function applyBrand() {
  const n = S.settings.app_name || 'QR Absensi';
  $('#brandName').textContent = n;
  $('#sideName').textContent = n;
  $('#loginAppName').textContent = n;
  document.title = n;
  updateClock();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  btn.disabled = true;
  $('#loginError').textContent = '';
  try {
    const res = await api('/auth/login', { method: 'POST', body: { username: $('#loginUser').value, password: $('#loginPass').value } });
    S.token = res.token;
    S.user = res.user;
    store.set('qr_absensi_token', res.token);
    $('#loginPass').value = '';
    await showApp();
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', () => logout());

// ───────────────────────── navigasi ─────────────────────────
const TITLES = {
  dashboard: 'Dashboard', pegawai: 'Master Data & QR', absensi: 'Monitoring Absensi', laporan: 'Export Hasil Absen',
  jadwal: 'Jadwal Event', perangkat: 'Akun Petugas', pengaturan: 'Pengaturan',
};
const ADMIN_PAGES = ['pegawai', 'laporan', 'perangkat'];
const LOADERS = {
  dashboard: () => loadDashboard(), absensi: () => loadAttendance(), pegawai: () => loadParticipants(),
  jadwal: () => loadEvents(), perangkat: () => loadUsers(), laporan: () => initReport(), pengaturan: () => initSettingsPage(),
};

function showPage(page) {
  if (!TITLES[page]) page = 'dashboard';
  if (S.user && S.user.role !== 'admin' && ADMIN_PAGES.includes(page)) page = 'dashboard';
  S.page = page;
  $$('.sectionpage').forEach((s) => s.classList.toggle('active', s.id === 'page-' + page));
  $$('[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#pageTitle').textContent = TITLES[page];
  $('.sidebar').classList.remove('open');
  const run = LOADERS[page]();
  if (run && run.catch) run.catch((e) => toast(e.message, 'error'));
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-page]');
  if (nav) return showPage(nav.dataset.page);
  const go = e.target.closest('[data-go]');
  if (go) return showPage(go.dataset.go);
  const ex = e.target.closest('[data-export]');
  if (ex) return exportReport(ex.dataset.export, !ex.closest('#page-laporan'));
});
$('#menuBtn').addEventListener('click', () => $('.sidebar').classList.toggle('open'));

function refreshCurrentSilently() {
  if (!S.token || !S.user) return;
  const fn = { dashboard: loadDashboard, absensi: loadAttendance, perangkat: loadUsers }[S.page];
  if (fn) fn().catch(() => {});
}

// ───────────────────────── dashboard ─────────────────────────
const STATE_BADGE = {
  upcoming: ['late', 'Belum mulai'], open: ['ok', '● Berjalan'], closed: ['absent', 'Ditutup'],
};
const statusBadge = (st) => `<span class="badge ${st === 'Hadir' ? 'ok' : st === 'Tidak hadir' ? 'absent' : 'late'}">${esc(st)}</span>`;

async function loadDashboard() {
  const d = await api('/dashboard');
  S.dash = d;
  S.event = d.event;
  S.settings.app_name = d.app_name;
  S.settings.timezone = d.timezone;
  applyBrand();
  renderDashboard();
}

function renderDashboard() {
  const d = S.dash;
  if (!d) return;
  const s = d.summary || { total: 0, hadir: 0, belum_absen: 0, tidak_hadir: 0 };
  const pct = (n) => (s.total ? (Math.round((n / s.total) * 1000) / 10).toString().replace('.', ',') : '0') + '% dari total';
  $('#greeting').textContent = `Selamat datang, ${S.user.username} 👋`;
  $('#datePill').innerHTML = '▣ &nbsp; ' + esc(fmtDateLong(d.now.date));
  $('#stTotal').textContent = s.total;
  $('#stHadir').textContent = s.hadir;
  $('#stBelum').textContent = s.belum_absen;
  $('#stTidak').textContent = s.tidak_hadir;
  $('#stHadirPct').textContent = pct(s.hadir);
  $('#stBelumPct').textContent = pct(s.belum_absen);
  $('#stTidakPct').textContent = pct(s.tidak_hadir);
  $('#lgHadir').textContent = s.hadir;
  $('#lgBelum').textContent = s.belum_absen;
  $('#lgTidak').textContent = s.tidak_hadir;
  const h = s.total ? (s.hadir / s.total) * 100 : 0;
  const b = s.total ? (s.belum_absen / s.total) * 100 : 0;
  $('#donut').style.background = s.total
    ? `conic-gradient(var(--green-500) 0% ${h}%, var(--orange) ${h}% ${h + b}%, var(--red) ${h + b}% 100%)`
    : 'conic-gradient(#e3e9e4 0% 100%)';

  const ev = d.event;
  const badge = $('#evBadge');
  if (ev) {
    const [cls, label] = STATE_BADGE[ev.state];
    badge.className = 'badge ' + cls;
    badge.textContent = label;
    $('#evStart').textContent = hm(ev.start_time);
    $('#evEnd').textContent = hm(ev.end_time);
    $('#evTitle').textContent = ev.name;
    $('#evMeta').textContent = `${fmtDate(ev.event_date)} · ${hm(ev.start_time)}–${hm(ev.end_time)}`;
    $('#recapEvent').textContent = fmtDate(ev.event_date);
  } else {
    badge.className = 'badge muted';
    badge.textContent = 'Belum ada event';
    ['#evStart', '#evEnd', '#evMeta', '#recapEvent'].forEach((id) => { $(id).textContent = '—'; });
    $('#evTitle').textContent = 'Belum ada event';
  }

  $('#recentRows').innerHTML = d.recent.length
    ? d.recent.slice(0, 6).map((r) => `<tr><td><div class="person"><span class="miniavatar">${esc(initials(r.name))}</span>${esc(r.name)}</div></td><td>${esc(r.jabatan)}</td><td>${esc(hm(r.time))}</td><td>${statusBadge(r.status)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Belum ada peserta yang absen.</td></tr>';

  $('#logList').innerHTML = d.recent.length
    ? d.recent.slice(0, 5).map((r) => `<div class="activity"><div class="scheduleicon ${r.method === 'manual' ? 'orange' : 'green'}">${r.method === 'manual' ? '✎' : '✓'}</div><div><strong>${esc(r.name)}</strong><small>${r.method === 'manual' ? 'Absen manual oleh petugas' : 'Absen via scan QR'}</small></div><small style="margin-left:auto">${esc(hm(r.time))}</small></div>`).join('')
    : '<div class="empty">Belum ada aktivitas.</div>';
}

// ───────────────────────── monitoring absensi ─────────────────────────
async function loadAttendance() {
  const res = await api('/attendance?limit=1000');
  S.attendance = res.data;
  S.attEvent = res.event;
  renderAttendance();
}

function renderAttendance() {
  const q = $('#attendanceSearch').value.trim().toLowerCase();
  const st = $('#statusFilter').value;
  const ev = S.attEvent;
  const rows = S.attendance.filter((r) => (st === 'all' || r.status === st) && (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)));
  const isAdmin = S.user && S.user.role === 'admin';
  const open = ev && ev.state === 'open';
  $('#attendanceInfo').textContent = ev
    ? `${ev.name} · ${fmtDate(ev.event_date)} · ${hm(ev.start_time)}–${hm(ev.end_time)} · ${S.attendance.filter((r) => r.status === 'Hadir').length}/${S.attendance.length} hadir`
    : 'Belum ada event. Admin perlu membuat jadwal event terlebih dahulu.';
  $('#fullAttendance').innerHTML = rows.length
    ? rows.map((r) => {
      let action = '';
      if (r.status === 'Hadir' && isAdmin) action = `<button class="btn btn-soft" data-act="cancel" data-id="${r.attendance_id}">Batalkan</button>`;
      else if (r.status !== 'Hadir' && open) action = `<button class="btn btn-soft" data-act="manual" data-code="${esc(r.code)}">Absen manual</button>`;
      return `<tr><td><div class="person"><span class="miniavatar">${esc(initials(r.name))}</span><div>${esc(r.name)}<div class="sub">${esc(r.code)}</div></div></div></td><td>${esc(r.jabatan)}</td><td>${ev ? esc(fmtDate(ev.event_date)) : '—'}</td><td>${esc(hm(r.time))}${r.method === 'manual' ? ' <span class="sub">(manual)</span>' : ''}</td><td>${statusBadge(r.status)}</td><td>${action}</td></tr>`;
    }).join('')
    : '<tr><td colspan="6" class="empty">Tidak ada data yang cocok.</td></tr>';
}

$('#attendanceSearch').addEventListener('input', renderAttendance);
$('#statusFilter').addEventListener('change', renderAttendance);
$('#fullAttendance').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  btn.disabled = true;
  try {
    if (btn.dataset.act === 'manual') {
      const r = await api('/attendance/manual', { method: 'POST', body: { code: btn.dataset.code } });
      toast(r.message, r.code === 'OK' ? 'success' : 'gold');
    } else if (confirm('Batalkan data absensi ini?')) {
      await api('/attendance/' + btn.dataset.id, { method: 'DELETE' });
      toast('Absensi dibatalkan', 'gold');
    }
    await loadAttendance();
  } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
});

// ───────────────────────── master data peserta ─────────────────────────
async function loadParticipants() {
  const res = await api('/participants?limit=2000');
  S.participants = res.data;
  renderParticipants();
}

function renderParticipants() {
  const q = $('#employeeSearch').value.trim().toLowerCase();
  const rows = S.participants.filter((p) => !q || [p.name, p.jabatan, p.code].some((v) => v.toLowerCase().includes(q)));
  $('#employeeCount').textContent = `· ${rows.length} dari ${S.participants.length} peserta`;
  $('#employeeRows').innerHTML = rows.length
    ? rows.map((p) => `<tr><td><div class="person"><span class="miniavatar">${esc(initials(p.name))}</span>${esc(p.name)}</div></td><td>${esc(p.jabatan)}</td><td>${esc(p.code)}</td><td><span class="badge ${p.status === 'Aktif' ? 'ok' : 'muted'}">${esc(p.status)}</span></td><td class="actions"><button class="btn btn-soft" data-act="edit" data-id="${p.id}">Edit</button> <button class="btn btn-soft" data-act="qr" data-id="${p.id}">Buat QR</button> <button class="btn btn-soft" data-act="del" data-id="${p.id}">Hapus</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">Belum ada peserta. Tambahkan atau import dari CSV.</td></tr>';
}

$('#employeeSearch').addEventListener('input', renderParticipants);
$('#employeeRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const p = S.participants.find((x) => x.id === Number(btn.dataset.id));
  if (!p) return;
  if (btn.dataset.act === 'edit') return openParticipantForm(p);
  if (btn.dataset.act === 'qr') return openQr(p);
  if (btn.dataset.act === 'del') {
    if (!confirm(`Hapus ${p.name}? Jika sudah punya riwayat absensi, peserta hanya dinonaktifkan.`)) return;
    try {
      const r = await api('/participants/' + p.id, { method: 'DELETE' });
      toast(r.deactivated ? 'Peserta dinonaktifkan (riwayat absensi dipertahankan)' : 'Peserta dihapus', 'gold');
      await loadParticipants();
    } catch (err) { toast(err.message, 'error'); }
  }
});

function jabatanOptions(val) {
  const list = JABATAN.includes(val) || !val ? JABATAN : [...JABATAN, val];
  return list.map((j) => `<option${j === (val || 'Anggota') ? ' selected' : ''}>${esc(j)}</option>`).join('');
}

function openParticipantForm(p = null) {
  openModal({
    title: p ? 'Edit Peserta' : 'Tambah Peserta',
    desc: p ? `ID ${p.code}` : 'QR Code dibuat otomatis begitu peserta disimpan.',
    html: `<div class="field"><label for="fName">Nama lengkap</label><input id="fName" maxlength="120" value="${esc(p ? p.name : '')}"></div>
           <div class="field"><label for="fJabatan">Jabatan</label><select id="fJabatan">${jabatanOptions(p && p.jabatan)}</select></div>
           ${p
    ? `<div class="field"><label for="fStatus">Status</label><select id="fStatus"><option${p.status === 'Aktif' ? ' selected' : ''}>Aktif</option><option${p.status === 'Nonaktif' ? ' selected' : ''}>Nonaktif</option></select></div>`
    : '<div class="field"><label for="fCode">ID peserta (opsional)</label><input id="fCode" maxlength="20" placeholder="Kosongkan untuk dibuat otomatis (EMP-001, …)"></div>'}`,
    onSave: async () => {
      const name = $('#fName').value.trim();
      if (!name) { toast('Nama wajib diisi', 'error'); return false; }
      if (p) {
        await api('/participants/' + p.id, { method: 'PUT', body: { name, jabatan: $('#fJabatan').value, status: $('#fStatus').value } });
        toast('Data peserta diperbarui', 'success');
      } else {
        const created = await api('/participants', { method: 'POST', body: { name, jabatan: $('#fJabatan').value, code: $('#fCode').value.trim() } });
        toast(`Peserta ditambahkan (${created.code}) — QR sudah dibuat`, 'success');
      }
      await loadParticipants();
    },
  });
}
$('#addEmployee').addEventListener('click', () => openParticipantForm());

// ---- QR peserta
function qrReady() {
  if (window.QRLite) return true;
  toast('Library QR gagal dimuat (vendor/qr-encoder.js).', 'error');
  return false;
}

function qrCardCanvas(p, size = 300) {
  const qr = window.QRLite.toCanvas(p.qr_token, { size });
  const pad = 70;
  const c = document.createElement('canvas');
  c.width = qr.width;
  c.height = qr.height + pad;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(qr, 0, 0);
  ctx.fillStyle = '#0a3d2a';
  ctx.textAlign = 'center';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(p.name.length > 30 ? p.name.slice(0, 29) + '…' : p.name, c.width / 2, qr.height + 26);
  ctx.fillStyle = '#61708a';
  ctx.font = '15px sans-serif';
  ctx.fillText(`${p.code} · ${p.jabatan}`, c.width / 2, qr.height + 50);
  return c;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function openQr(p) {
  if (!qrReady()) return;
  openModal({
    title: 'QR Code Absensi',
    desc: `${p.name} · ${p.code}`,
    html: `<div class="qr-preview"><div id="qrBox"></div><div class="qr-id">${esc(p.code)} · ${esc(p.jabatan)}</div></div>
           <div class="toolbar" style="justify-content:center;margin-top:10px"><button class="btn btn-soft" id="qrDownload">⬇ Unduh PNG</button><button class="btn btn-soft" id="qrRegen">↻ Buat ulang QR</button></div>`,
    hideSave: true,
    cancelLabel: 'Tutup',
  });
  $('#qrBox').appendChild(window.QRLite.toCanvas(p.qr_token, { size: 240 }));
  $('#qrDownload').addEventListener('click', () => {
    qrCardCanvas(p).toBlob((b) => downloadBlob(b, `QR-${p.code}.png`), 'image/png');
  });
  $('#qrRegen').addEventListener('click', async () => {
    if (!confirm('Buat ulang QR? QR lama yang sudah dicetak tidak akan berlaku lagi.')) return;
    try {
      const np = await api(`/participants/${p.id}/regenerate-qr`, { method: 'POST' });
      Object.assign(p, np);
      toast('QR baru dibuat. Cetak ulang kartu peserta.', 'gold');
      openQr(p);
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function printAllQr() {
  if (!qrReady()) return;
  const w = window.open('', '_blank');
  if (!w) return toast('Pop-up diblokir browser. Izinkan pop-up untuk situs ini.', 'error');
  w.document.write('<p style="font-family:sans-serif;padding:20px">Menyiapkan kartu QR…</p>');
  try {
    await loadParticipants();
    const list = S.participants.filter((p) => p.status === 'Aktif');
    if (!list.length) { w.close(); return toast('Belum ada peserta aktif.', 'error'); }
    const cards = list.map((p) => `<div class="card"><img alt="" src="${window.QRLite.toDataURL(p.qr_token, { size: 200 })}"><b>${esc(p.name)}</b><span>${esc(p.code)} · ${esc(p.jabatan)}</span></div>`).join('');
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Kartu QR Peserta</title><style>
      body{font-family:system-ui,sans-serif;margin:12mm;color:#111}
      h1{font-size:16px;margin:0 0 10px}
      .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
      .card{border:1px dashed #999;border-radius:6px;padding:8px;text-align:center;break-inside:avoid}
      .card img{width:100%;max-width:140px;image-rendering:pixelated}
      .card b{display:block;font-size:12px;margin-top:4px}.card span{font-size:10.5px;color:#555}
      @media print{@page{margin:10mm}}
    </style></head><body><h1>Kartu QR Peserta — ${esc(S.settings.app_name)} (${list.length} peserta)</h1><div class="grid">${cards}</div></body></html>`);
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch { /* user bisa cetak manual */ } }, 700);
  } catch (err) { w.close(); toast(err.message, 'error'); }
}
$('#printQrBtn').addEventListener('click', printAllQr);

// ---- import CSV
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : first.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const pushRow = () => { row.push(cur); cur = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else cur += ch;
  }
  pushRow();
  return rows;
}

function csvToParticipants(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const head = rows[0].map((c) => c.trim().toLowerCase());
  const idx = (names) => head.findIndex((h) => names.includes(h));
  let iName = idx(['nama', 'name', 'nama peserta']);
  let iJab = idx(['jabatan', 'role', 'posisi']);
  let iCode = idx(['id', 'kode', 'code', 'id peserta']);
  let data = rows;
  if (iName >= 0) data = rows.slice(1);
  else { iName = 0; iJab = 1; iCode = 2; }
  return data.map((r) => ({
    name: (r[iName] || '').trim(),
    jabatan: iJab >= 0 ? (r[iJab] || '').trim() : '',
    code: iCode >= 0 ? (r[iCode] || '').trim() : '',
  }));
}

$('#templateBtn').addEventListener('click', () => {
  downloadBlob(new Blob(['\uFEFFnama,jabatan,id\nAndi Pratama,Anggota,\nSiti Rahmawati,Ketua,\n'], { type: 'text/csv' }), 'template-peserta.csv');
});

$('#importBtn').addEventListener('click', () => {
  openModal({
    title: 'Import Peserta dari CSV',
    desc: 'Kolom: nama, jabatan, id (id boleh kosong — dibuat otomatis). Cocok untuk 300+ peserta sekaligus.',
    html: `<div class="field"><label for="csvFile">File CSV</label><input id="csvFile" type="file" accept=".csv,.txt,text/csv"></div>
           <div class="field"><label for="csvText">…atau tempel isi CSV di sini</label><textarea id="csvText" rows="6" placeholder="nama,jabatan,id&#10;Andi Pratama,Anggota,"></textarea></div>
           <div class="sub" id="csvInfo">Belum ada data.</div>`,
    saveLabel: 'Import',
    onSave: async () => {
      const rows = csvToParticipants($('#csvText').value);
      if (!rows.length) { toast('Tidak ada baris yang bisa diimport', 'error'); return false; }
      const res = await api('/participants/import', { method: 'POST', body: { rows } });
      await loadParticipants();
      closeModal();
      openModal({
        title: 'Import selesai',
        desc: `${res.created} peserta ditambahkan, ${res.skipped.length} baris dilewati.`,
        html: res.skipped.length
          ? `<div class="sub" style="max-height:200px;overflow:auto">${res.skipped.slice(0, 50).map((s) => `Baris ${s.row}${s.name ? ` (${esc(s.name)})` : ''}: ${esc(s.reason)}`).join('<br>')}</div>`
          : '<div class="sub">Semua baris berhasil diimport. QR dibuat otomatis untuk tiap peserta.</div>',
        hideSave: true, cancelLabel: 'Tutup',
      });
      return false;
    },
  });
  const info = () => {
    const n = csvToParticipants($('#csvText').value).filter((r) => r.name).length;
    $('#csvInfo').textContent = n ? `${n} baris siap diimport.` : 'Belum ada data.';
  };
  $('#csvText').addEventListener('input', info);
  $('#csvFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#csvText').value = await f.text();
    info();
  });
});

// ───────────────────────── jadwal event ─────────────────────────
async function loadEvents() {
  const [list, cur] = await Promise.all([api('/events'), api('/events/current')]);
  S.events = list.data;
  S.event = cur.event;
  renderEvents();
}

function renderEvents() {
  const isAdmin = S.user.role === 'admin';
  const ev = S.event;
  if (isAdmin) {
    $('#evFormName').value = ev ? ev.name : '';
    $('#evFormDate').value = ev ? ev.event_date : tzNow().date;
    $('#evFormStart').value = ev ? ev.start_time : '08:00';
    $('#evFormEnd').value = ev ? ev.end_time : '17:00';
    $('#eventState').textContent = ev ? 'Status sesi: ' + STATE_BADGE[ev.state][1].replace('● ', '') : 'Belum ada event — isi form lalu simpan untuk membuatnya.';
  }
  $('#eventList').innerHTML = S.events.length
    ? S.events.map((e) => {
      const [cls, label] = STATE_BADGE[e.state];
      const cur = ev && ev.id === e.id;
      return `<div class="scheduleitem"><div class="scheduleicon ${cur ? 'green' : 'blue'}">▣</div><div><strong>${esc(e.name)}${cur ? ' <span class="sub">· event aktif</span>' : ''}</strong><small>${esc(fmtDate(e.event_date))} · ${esc(hm(e.start_time))}–${esc(hm(e.end_time))}</small></div><span class="badge ${cls}" style="margin-left:auto">${esc(label)}</span>${isAdmin ? `<button class="btn btn-soft" data-act="edit" data-id="${e.id}">Edit</button><button class="btn btn-soft" data-act="del" data-id="${e.id}">Hapus</button>` : ''}</div>`;
    }).join('')
    : '<div class="empty">Belum ada event.</div>';
}

function eventFormHtml(e) {
  return `<div class="field"><label for="mEvName">Nama event</label><input id="mEvName" maxlength="120" value="${esc(e.name)}"></div>
          <div class="field"><label for="mEvDate">Tanggal</label><input id="mEvDate" type="date" value="${esc(e.event_date)}"></div>
          <div class="field"><label for="mEvStart">Jam mulai</label><input id="mEvStart" type="time" value="${esc(e.start_time)}"></div>
          <div class="field"><label for="mEvEnd">Jam selesai</label><input id="mEvEnd" type="time" value="${esc(e.end_time)}"></div>`;
}

function openEventForm(ev = null) {
  openModal({
    title: ev ? 'Edit Event' : 'Event Baru',
    desc: 'Absensi hanya bisa dilakukan antara jam mulai dan jam selesai.',
    html: eventFormHtml(ev || { name: '', event_date: tzNow().date, start_time: '08:00', end_time: '17:00' }),
    onSave: async () => {
      const body = { name: $('#mEvName').value, event_date: $('#mEvDate').value, start_time: $('#mEvStart').value, end_time: $('#mEvEnd').value };
      if (ev) await api('/events/' + ev.id, { method: 'PUT', body });
      else await api('/events', { method: 'POST', body });
      toast('Event disimpan', 'success');
      await loadEvents();
    },
  });
}
$('#newEvent').addEventListener('click', () => openEventForm());

$('#saveEvent').addEventListener('click', async () => {
  const body = { name: $('#evFormName').value, event_date: $('#evFormDate').value, start_time: $('#evFormStart').value, end_time: $('#evFormEnd').value };
  try {
    if (S.event) await api('/events/' + S.event.id, { method: 'PUT', body });
    else await api('/events', { method: 'POST', body });
    toast('Jadwal disimpan', 'success');
    await loadEvents();
  } catch (e) { toast(e.message, 'error'); }
});

$('#eventList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const ev = S.events.find((x) => x.id === Number(btn.dataset.id));
  if (!ev) return;
  if (btn.dataset.act === 'edit') return openEventForm(ev);
  if (!confirm(`Hapus event "${ev.name}"?`)) return;
  try { await api('/events/' + ev.id, { method: 'DELETE' }); toast('Event dihapus', 'gold'); await loadEvents(); } catch (err) { toast(err.message, 'error'); }
});

// ───────────────────────── akun petugas ─────────────────────────
const timeAgo = (iso) => {
  if (!iso) return 'belum pernah aktif';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' menit lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return fmtDate(iso.slice(0, 10));
};

async function loadUsers() {
  S.users = (await api('/users')).data;
  $('#userList').innerHTML = S.users.map((u) => `<div class="scheduleitem"><div class="scheduleicon ${u.role === 'admin' ? 'red' : 'blue'}">${u.role === 'admin' ? '♙' : '▣'}</div><div><strong>${esc(u.username)}${u.id === S.user.id ? ' <span class="sub">(Anda)</span>' : ''}</strong><small>${u.role === 'admin' ? 'Administrator' : 'Petugas Absen'} · Terakhir aktif ${esc(timeAgo(u.last_seen_at))}</small></div><span class="badge ${u.online ? 'ok' : 'muted'}" style="margin-left:auto">${u.online ? 'Online' : 'Offline'}</span>${u.id === S.user.id ? '' : `<button class="btn btn-soft" data-act="del" data-id="${u.id}">Hapus</button>`}</div>`).join('') || '<div class="empty">Belum ada akun.</div>';
}

$('#userList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="del"]');
  if (!btn) return;
  const u = S.users.find((x) => x.id === Number(btn.dataset.id));
  if (!u || !confirm(`Hapus akun "${u.username}"?`)) return;
  try { await api('/users/' + u.id, { method: 'DELETE' }); toast('Akun dihapus', 'gold'); await loadUsers(); } catch (err) { toast(err.message, 'error'); }
});

$('#addUser').addEventListener('click', () => {
  openModal({
    title: 'Tambah Akun',
    desc: 'Akun dipakai untuk login di perangkat petugas.',
    html: `<div class="field"><label for="uName">Username</label><input id="uName" maxlength="30" placeholder="mis. gate1" autocomplete="off"></div>
           <div class="field"><label for="uPass">Password (minimal 8 karakter)</label><input id="uPass" type="password" autocomplete="new-password"></div>
           <div class="field"><label for="uRole">Peran</label><select id="uRole"><option value="petugas">Petugas Absen</option><option value="admin">Admin</option></select></div>`,
    onSave: async () => {
      await api('/users', { method: 'POST', body: { username: $('#uName').value, password: $('#uPass').value, role: $('#uRole').value } });
      toast('Akun dibuat', 'success');
      await loadUsers();
    },
  });
});

// ───────────────────────── laporan & ekspor ─────────────────────────
async function initReport() {
  const t = tzNow().date;
  if (!$('#repFrom').value) $('#repFrom').value = t.slice(0, 8) + '01';
  if (!$('#repTo').value) $('#repTo').value = t;
  await applyReport();
}

function reportParams() {
  const from = $('#repFrom').value;
  const to = $('#repTo').value;
  if (!from || !to) throw new Error('Isi rentang tanggal terlebih dahulu');
  const qs = new URLSearchParams({ from, to });
  if ($('#repJabatan').value) qs.set('jabatan', $('#repJabatan').value);
  return qs;
}

async function applyReport() {
  const qs = reportParams();
  const r = await api('/reports/summary?' + qs);
  const s = r.summary;
  $('#rpHadir').textContent = s.hadir;
  $('#rpTidak').textContent = s.tidak_hadir;
  $('#rpBelum').textContent = s.belum_absen;
  $('#rpHadirPct').textContent = `${String(s.persen_hadir).replace('.', ',')}% dari ${s.total_records} catatan`;
  $('#rpPeriode').textContent = r.from === r.to ? fmtDate(r.from) : `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  $('#rpEvents').textContent = `${s.events} event`;
}
$('#applyReport').addEventListener('click', () => applyReport().catch((e) => toast(e.message, 'error')));

function reportHtml(rep) {
  const s = rep.summary;
  const rows = rep.rows.map((r) => `<tr><td>${esc(fmtDate(r.tanggal))}</td><td>${esc(r.event)}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.jabatan)}</td><td>${esc(hm(r.jam))}</td><td class="${r.status === 'Hadir' ? 'ok' : r.status === 'Tidak hadir' ? 'bad' : 'mid'}">${esc(r.status)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Laporan Kehadiran</title><style>
    body{font-family:system-ui,sans-serif;margin:14mm;color:#111;font-size:12px}
    h1{font-size:18px;margin:0 0 4px}.meta{color:#555;margin-bottom:12px}
    .sum{display:flex;gap:18px;margin:10px 0 14px}.sum div{border:1px solid #ccc;border-radius:6px;padding:6px 12px}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}
    th{background:#0f5c3f;color:#fff}.ok{color:#157a51;font-weight:700}.bad{color:#d33;font-weight:700}.mid{color:#b8872b;font-weight:700}
    @media print{@page{size:A4;margin:10mm}thead{display:table-header-group}tr{break-inside:avoid}}
  </style></head><body>
    <h1>Laporan Kehadiran — ${esc(S.settings.app_name)}</h1>
    <div class="meta">Periode ${esc(fmtDate(rep.from))} – ${esc(fmtDate(rep.to))}${rep.jabatan ? ' · Jabatan: ' + esc(rep.jabatan) : ''} · Dicetak ${esc(fmtDate(tzNow().date))} ${esc(tzNow().time.slice(0, 5))}</div>
    <div class="sum"><div>Hadir: <b>${s.hadir}</b></div><div>Tidak hadir: <b>${s.tidak_hadir}</b></div><div>Belum absen: <b>${s.belum_absen}</b></div><div>Event: <b>${s.events}</b></div></div>
    <table><thead><tr><th>Tanggal</th><th>Event</th><th>ID</th><th>Nama</th><th>Jabatan</th><th>Jam</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`;
}

async function exportReport(kind, fromDashboard) {
  try {
    let qs;
    if (fromDashboard) {
      if (!S.event) return toast('Belum ada event untuk diekspor', 'error');
      qs = new URLSearchParams({ from: S.event.event_date, to: S.event.event_date });
    } else qs = reportParams();
    const from = qs.get('from');
    const to = qs.get('to');
    if (kind === 'Excel') {
      const res = await api('/reports/attendance.xlsx?' + qs, { raw: true });
      downloadBlob(await res.blob(), `absensi_${from}_${to}.xlsx`);
      return toast('File Excel diunduh', 'success');
    }
    const w = window.open('', '_blank');
    if (!w) return toast('Pop-up diblokir browser. Izinkan pop-up untuk situs ini.', 'error');
    w.document.write('<p style="font-family:sans-serif;padding:20px">Menyiapkan laporan…</p>');
    try {
      qs.set('rows', '1');
      const rep = await api('/reports/summary?' + qs);
      w.document.open();
      w.document.write(reportHtml(rep));
      w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* cetak manual */ } }, 500);
      if (kind === 'PDF') toast('Pilih “Simpan sebagai PDF” pada dialog cetak', 'gold');
    } catch (err) { w.close(); throw err; }
  } catch (err) { toast(err.message, 'error'); }
}

// ───────────────────────── pengaturan ─────────────────────────
function initSettingsPage() {
  $('#setAppName').value = S.settings.app_name;
  $('#setTz').value = S.settings.timezone;
}
$('#saveSettings').addEventListener('click', async () => {
  try {
    S.settings = await api('/settings', { method: 'PUT', body: { app_name: $('#setAppName').value, timezone: $('#setTz').value } });
    applyBrand();
    toast('Pengaturan disimpan', 'success');
  } catch (e) { toast(e.message, 'error'); }
});
$('#savePw').addEventListener('click', async () => {
  try {
    await api('/auth/password', { method: 'POST', body: { old_password: $('#pwOld').value, new_password: $('#pwNew').value } });
    $('#pwOld').value = '';
    $('#pwNew').value = '';
    toast('Password berhasil diubah', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// ───────────────────────── scanner QR ─────────────────────────
const SCANNER_URLS = [
  '/vendor/html5-qrcode.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
];
let scanner = null;
let scanSession = 0;
let scanBusy = false;
let lastScan = { text: '', at: 0 };
let scanOkCount = 0;

function loadScriptFrom(urls) {
  if (window.Html5Qrcode) return Promise.resolve();
  return urls.reduce((chain, url) => chain.catch(() => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('gagal memuat ' + url)); };
    document.head.appendChild(s);
  })), Promise.reject(new Error('mulai')));
}

function beep(ok) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.12 : 0.3));
    setTimeout(() => ctx.close(), 500);
  } catch { /* tanpa suara */ }
}

function setScanStatus(text, cls = '') {
  const el = $('#scanStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'scanresult ' + cls;
}

function showScanOutcome(kind, title, detail) {
  const box = $('#scanBox');
  if (!box) return;
  box.className = 'scanbox ' + kind;
  box.innerHTML = `<div class="scanicon">${kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '×'}</div><div><strong>${esc(title)}</strong><small>${esc(detail)}</small></div>`;
  beep(kind === 'ok');
}

async function submitScan(value, source) {
  const v = String(value || '').trim();
  if (!v || scanBusy) return;
  scanBusy = true;
  try {
    let res;
    if (/^[0-9a-f]{32}$/i.test(v)) res = await api('/scan', { method: 'POST', body: { token: v } });
    else if (source === 'manual') res = await api('/attendance/manual', { method: 'POST', body: { code: v } });
    else throw new ApiError(404, 'QR_INVALID', 'QR Code tidak dikenali');
    if (res.code === 'OK') {
      scanOkCount++;
      const c = $('#scanCount');
      if (c) c.textContent = `Berhasil di sesi ini: ${scanOkCount}`;
    }
    showScanOutcome(res.code === 'OK' ? 'ok' : 'warn', res.participant.name, res.code === 'OK' ? `Absen tercatat pukul ${res.time.slice(0, 5)} · ${res.participant.code}` : `Sudah absen pukul ${res.time.slice(0, 5)}`);
  } catch (err) {
    showScanOutcome('err', err.code === 'QR_INVALID' ? 'QR tidak dikenali' : 'Absen ditolak', err.message);
  } finally {
    scanBusy = false;
  }
}

async function stopScanner() {
  scanSession++;
  const sc = scanner;
  scanner = null;
  if (!sc) return;
  try { await sc.stop(); } catch { /* sudah berhenti */ }
  try { sc.clear(); } catch { /* abaikan */ }
}

async function startCamera() {
  if (!window.isSecureContext) return setScanStatus('Kamera hanya bisa dipakai lewat HTTPS atau localhost. Gunakan input manual di bawah.', 'miss');
  try { await loadScriptFrom(SCANNER_URLS); } catch {
    return setScanStatus('Library scanner gagal dimuat (cek internet, atau simpan html5-qrcode.min.js di public/vendor). Gunakan input manual.', 'miss');
  }
  const session = ++scanSession;
  try {
    const sc = new window.Html5Qrcode('qrReader');
    scanner = sc;
    await sc.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      (text) => {
        const now = Date.now();
        if (scanBusy || (text === lastScan.text && now - lastScan.at < 3000)) return;
        lastScan = { text, at: now };
        submitScan(text, 'camera');
      },
      () => {},
    );
    if (session !== scanSession) { try { await sc.stop(); } catch { /* ditutup lebih dulu */ } return; }
    setScanStatus('Kamera aktif — arahkan ke QR Code peserta');
  } catch (e) {
    setScanStatus('Kamera tidak bisa diakses: ' + (e && e.message ? e.message : e) + '. Gunakan input manual.', 'miss');
  }
}

function openScanner() {
  scanOkCount = 0;
  lastScan = { text: '', at: 0 };
  openModal({
    title: 'Scan QR Absensi',
    desc: 'Scanner tetap aktif untuk peserta berikutnya. Tutup jika sudah selesai.',
    html: `<div class="scanwrap">
             <div id="qrReader"></div>
             <div class="scanresult" id="scanStatus">Menyiapkan kamera…</div>
             <div class="scanbox idle" id="scanBox"><div class="scanicon">▦</div><div><strong>Menunggu scan…</strong><small>Hasil absensi muncul di sini</small></div></div>
             <div class="sub" id="scanCount"></div>
           </div>
           <div class="field" style="margin-top:12px"><label for="manualInput">Input manual — ID peserta (mis. EMP-001) atau hasil scanner USB</label>
             <div class="inline"><input id="manualInput" autocomplete="off" placeholder="EMP-001"><button class="btn btn-primary" id="manualSubmit" type="button">Absen</button></div></div>`,
    hideSave: true,
    cancelLabel: 'Tutup Scanner',
    onClose: () => { stopScanner(); },
  });
  const submitManual = async () => {
    const input = $('#manualInput');
    const v = input.value;
    input.value = '';
    await submitScan(v, 'manual');
    input.focus();
  };
  $('#manualSubmit').addEventListener('click', submitManual);
  $('#manualInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitManual(); } });
  startCamera();
}
$('#scanBtn').addEventListener('click', openScanner);

// ───────────────────────── jam & polling ─────────────────────────
function updateClock() {
  const t = tzNow().time.slice(0, 5);
  $('#clock').textContent = `${t} ${TZ_LABEL[S.settings.timezone] || ''}`.trim();
}
setInterval(updateClock, 1000);
setInterval(() => {
  if (!S.token || !S.user || document.hidden || modal.open) return;
  refreshCurrentSilently();
}, 8000);

// ───────────────────────── mulai ─────────────────────────
(async function boot() {
  try {
    const info = await fetch('/api/public/info').then((r) => r.json());
    if (info && info.app_name) { S.settings.app_name = info.app_name; applyBrand(); }
  } catch { /* abaikan */ }
  if (!S.token) return showLogin();
  try {
    S.user = (await api('/auth/me')).user;
    await showApp();
  } catch { showLogin(); }
})();
})();
