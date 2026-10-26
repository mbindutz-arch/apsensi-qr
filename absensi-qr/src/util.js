'use strict';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const httpError = (status, code, message) => new HttpError(status, code, message);

// Tanggal & jam "sekarang" di zona waktu tertentu (mis. Asia/Jakarta)
const formatters = new Map();
function nowParts(tz, date = new Date()) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

// 'upcoming' | 'open' | 'closed'
function eventState(ev, now) {
  const t = now.time.slice(0, 5);
  if (now.date < ev.event_date) return 'upcoming';
  if (now.date > ev.event_date) return 'closed';
  if (t < ev.start_time) return 'upcoming';
  if (t > ev.end_time) return 'closed';
  return 'open';
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const isValidTime = (s) => typeof s === 'string' && TIME_RE.test(s);

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  // buang karakter kontrol, rapikan spasi
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

// Pembatas laju sederhana (sliding window, in-memory)
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    if (hits.size > 5000) {
      for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] > windowMs) hits.delete(k);
    }
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}

module.exports = { HttpError, httpError, nowParts, eventState, isValidDate, isValidTime, cleanStr, escapeLike, makeLimiter };
