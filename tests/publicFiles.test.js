/**
 * tests/publicFiles.test.js
 * ============================================================
 * public/ served at the root (middleware/publicFiles.js), as server.js
 * mounts it — before helmet's defaults would block cross-origin use and
 * ahead of the API routes, which must still be reached:
 *   - /welcome-banner.png: the 1200x628 PNG, image/png, cacheable,
 *     Cross-Origin-Resource-Policy cross-origin
 *   - anything else (an API path, a missing file, a dotfile, the folder
 *     itself) falls through to the next handler
 *   - server.js mounts it, after helmet and before the API routes
 * A real HTTP server on a random local port; nothing external.
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const publicFiles = require('../middleware/publicFiles');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(publicFiles);
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  app.use((req, res) => res.status(404).json({ fellThrough: true }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const get = (p) => new Promise((resolve, reject) => {
  http.get(`${base}${p}`, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('/welcome-banner.png is the 1200x628 PNG, cacheable, usable cross-origin', async () => {
  const r = await get('/welcome-banner.png');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('image/png');
  expect(r.headers['cache-control']).toBe('public, max-age=86400');
  expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
  // PNG signature, then the IHDR width/height
  expect(r.body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(r.body.readUInt32BE(16)).toBe(1200);
  expect(r.body.readUInt32BE(20)).toBe(628);
  // under WhatsApp's 5 MB limit for an image header
  expect(r.body.length).toBeLessThan(5 * 1024 * 1024);
  expect(r.body.equals(fs.readFileSync(path.join(publicFiles.PUBLIC_DIR, 'welcome-banner.png')))).toBe(true);
});

test('the API is untouched: other paths, missing files, dotfiles and the folder fall through', async () => {
  expect((await get('/api/ping')).body.toString()).toBe('{"ok":true}');
  for (const p of ['/nope.png', '/.env', '/', '/welcome-banner.png/x']) {
    const r = await get(p);
    expect([p, r.status, JSON.parse(r.body.toString())]).toEqual([p, 404, { fellThrough: true }]);
  }
});

test('server.js mounts it after helmet and before the API routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const helmetAt = src.indexOf('app.use(helmet(');
  const filesAt = src.indexOf("app.use(require('./middleware/publicFiles'))");
  const firstApi = src.indexOf("app.use('/api/");
  expect(helmetAt).toBeGreaterThan(-1);
  expect(filesAt).toBeGreaterThan(helmetAt);
  expect(firstApi).toBeGreaterThan(filesAt);
});
