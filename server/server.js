#!/usr/bin/env node
'use strict';
/* Tiny storage API for JEE 2028 Study OS.
 * GET /api/data -> {"data": <saved state or null>}
 * PUT /api/data (body: JSON state) -> {"ok": true}
 * State is validated by the frontend on load; stored as a single JSON document.
 * GET /api/pw-planner -> live planner schedule from tracker360.pw.live,
 *   fetched with the PW_TRACKER_SESSION cookie (secret) if configured. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.DATA_FILE || '/data/state.json';
const PW_BASE = 'https://tracker360.pw.live';
const PW_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

let state = null;
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = null;
} catch (e) {
  state = null;
}

function persist(o) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o));
  fs.renameSync(tmp, DATA_FILE);
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* ---------- PW Tracker 360 planner ---------- */
const PW_COOKIE_FILE = path.join(path.dirname(DATA_FILE), 'pw_session.json');
let pwSession = null;
try { pwSession = JSON.parse(fs.readFileSync(PW_COOKIE_FILE, 'utf8')).cookie || null; } catch (e) { pwSession = null; }
function pwSaveSession(c) {
  pwSession = c;
  try { fs.writeFileSync(PW_COOKIE_FILE, JSON.stringify({ cookie: c })); } catch (e) { /* best effort */ }
}

/* Minimal cookie jar: accumulate "name=value" pairs from Set-Cookie headers */
function jarFrom(res, jar) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const map = {};
  (jar || '').split(/; */).forEach(p => { const i = p.indexOf('='); if (i > 0) map[p.slice(0, i)] = p.slice(i + 1); });
  sc.forEach(c => { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) map[p.slice(0, i)] = p.slice(i + 1); });
  return Object.keys(map).map(k => k + '=' + map[k]).join('; ');
}

function pwHeaders(cookie) {
  return { Cookie: cookie, 'User-Agent': PW_UA, Accept: 'application/json' };
}

/* Fresh jar with the site's csrf cookie, like a real browser visit */
async function pwFreshJar() {
  const r = await fetch(PW_BASE + '/', { headers: { 'User-Agent': PW_UA }, signal: AbortSignal.timeout(15000) });
  return jarFrom(r, '');
}

let pwLoginJar = null, pwLoginPhone = null;

function normPhone(p) {
  const d = String(p || '').replace(/[^0-9]/g, '');
  return d;
}

async function pwLogin(action, phone, otp) {
  const p = normPhone(phone);
  if (!/^\d{10,13}$/.test(p)) return { ok: false, error: 'Enter a valid phone number (10 digits).' };
  if (action === 'send') {
    try {
      const jar = await pwFreshJar();
      const csrf = (jar.match(/cp_csrf=([^;]+)/) || [])[1] || '';
      const r = await fetch(PW_BASE + '/api/pw-login/send-otp', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': PW_UA, 'Content-Type': 'application/json', Accept: 'application/json', Cookie: jar, 'x-csrf-token': csrf, Origin: PW_BASE, Referer: PW_BASE + '/' },
        body: JSON.stringify({ phone: p })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) return { ok: false, error: (j && j.error) || 'Could not send the OTP. Try again.' };
      pwLoginJar = jarFrom(r, jar); pwLoginPhone = p;
      return { ok: true, sent: true };
    } catch (e) { return { ok: false, error: 'Could not reach PW Tracker 360. Try again.' }; }
  }
  if (action === 'verify') {
    if (!pwLoginJar || pwLoginPhone !== p) return { ok: false, error: 'Request a new OTP first.' };
    try {
      const csrf = (pwLoginJar.match(/cp_csrf=([^;]+)/) || [])[1] || '';
      const r = await fetch(PW_BASE + '/api/pw-login/verify-otp', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': PW_UA, 'Content-Type': 'application/json', Accept: 'application/json', Cookie: pwLoginJar, 'x-csrf-token': csrf, Origin: PW_BASE, Referer: PW_BASE + '/' },
        body: JSON.stringify({ phone: p, otp: String(otp || '').trim() })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) return { ok: false, error: (j && j.error) || 'That code did not work. Try again.' };
      pwSaveSession(jarFrom(r, pwLoginJar));
      pwLoginJar = null; pwLoginPhone = null; pwCache = { t: 0, v: null };
      return { ok: true, connected: true };
    } catch (e) { return { ok: false, error: 'Could not reach PW Tracker 360. Try again.' }; }
  }
  return { ok: false, error: 'Unknown action.' };
}

function pwNormalize(j) {
  const raw = j || {};
  const days = Array.isArray(raw.days) ? raw.days : Array.isArray(raw) ? raw : [];
  const out = [];
  days.slice(0, 14).forEach(day => {
    if (!day || typeof day !== 'object') return;
    const groups = Array.isArray(day.groups) ? day.groups : (Array.isArray(day.lectures) ? [{ lectures: day.lectures }] : []);
    const lectures = [];
    groups.forEach(g => {
      const items = (g && (Array.isArray(g.lectures) ? g.lectures : Array.isArray(g.items) ? g.items : [])) || [];
      items.forEach(l => {
        if (l && typeof l === 'object') {
          const title = l.title || l.lecture || l.name;
          if (typeof title === 'string' && title) {
            lectures.push({
              title: String(title).slice(0, 200),
              subject: String(g.subject || l.subject || l.teacher || '').slice(0, 80),
              chapter: String(l.chapter || l.chapterName || '').slice(0, 120),
              duration: String(l.duration || l.durationMin || l.length || '').slice(0, 30),
              done: !!(l.done || l.isDone || l.watched || l.status === 'Done' || l.status === 'done')
            });
          }
        }
      });
    });
    const label = day.date || day.label || day.day;
    if (label || lectures.length) {
      out.push({
        date: typeof label === 'string' ? label.slice(0, 60) : '',
        done: typeof day.done === 'number' ? day.done : undefined,
        total: typeof day.total === 'number' ? day.total : (typeof day.lecture === 'number' ? day.lecture : undefined),
        lectures
      });
    }
  });
  return { days: out };
}

let pwCache = { t: 0, v: null };
async function pwPlanner() {
  const cookie = pwSession || process.env.PW_TRACKER_SESSION || '';
  if (!cookie) return { ok: false, reason: 'not_configured' };
  if (pwCache.v && Date.now() - pwCache.t < 60000) return pwCache.v;
  try {
    const s = await fetch(PW_BASE + '/api/pw-login/session', { headers: pwHeaders(cookie), signal: AbortSignal.timeout(15000) });
    const sj = await s.json().catch(() => ({}));
    if (!sj || sj.verified !== true) {
      const v = { ok: false, reason: 'session_expired' };
      pwCache = { t: Date.now(), v };
      return v;
    }
    const r = await fetch(PW_BASE + '/api/planner/export?from=today', { headers: pwHeaders(cookie), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error) {
      return { ok: false, reason: 'fetch_failed', detail: (j && j.error) || ('HTTP ' + r.status) };
    }
    const v = Object.assign({ ok: true }, pwNormalize(j));
    pwCache = { t: Date.now(), v };
    return v;
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', detail: 'network error' };
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/data') {
    return send(res, 200, { data: state });
  }
  if (req.method === 'GET' && req.url === '/api/pw-planner') {
    return pwPlanner().then(v => send(res, 200, v));
  }
  if (req.method === 'POST' && req.url === '/api/pw-login') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let o;
      try { o = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return send(res, 400, { ok: false, error: 'invalid json' }); }
      pwLogin(o && o.action, o && o.phone, o && o.otp).then(v => send(res, 200, v));
    });
    return;
  }
  if ((req.method === 'PUT' || req.method === 'POST') && req.url === '/api/data') {
    const chunks = [];
    let len = 0;
    let tooBig = false;
    req.on('data', c => {
      len += c.length;
      if (len > 6e6) { tooBig = true; chunks.length = 0; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return send(res, 413, { ok: false, error: 'payload too large' });
      let o;
      try { o = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return send(res, 400, { ok: false, error: 'invalid json' }); }
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        return send(res, 400, { ok: false, error: 'state must be a JSON object' });
      }
      state = o;
      try {
        persist(state);
      } catch (e) {
        return send(res, 500, { ok: false, error: 'could not persist' });
      }
      send(res, 200, { ok: true });
    });
    return;
  }
  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('storage api listening on ' + PORT);
});
