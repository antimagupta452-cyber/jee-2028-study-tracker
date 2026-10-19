#!/usr/bin/env node
'use strict';
/* Tiny storage API for JEE 2028 Study OS.
 * GET /api/data -> {"data": <saved state or null>}
 * PUT /api/data (body: JSON state) -> {"ok": true}
 * State is validated by the frontend on load; stored as a single JSON document. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.DATA_FILE || '/data/state.json';

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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/data') {
    return send(res, 200, { data: state });
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
