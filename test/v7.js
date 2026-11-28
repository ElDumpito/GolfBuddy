'use strict';
// Sign-ups without the invite code wait for an admin. The admin gets a push with Approve / Decline;
// a waiting account can't log in or see anything; declining frees the username; only admins decide.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golfhomie-v7-'));
process.env.INVITE_CODE = 'fore';
const realFetch = global.fetch;
const pushes = [];
global.fetch = async (url, opts) => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  if (u.hostname === 'push.example') { pushes.push(u.pathname); return new Response('', { status: 201 }); }
  throw new Error('unexpected outside call: ' + url);
};
const { server } = require('../server/index');
const crypto = require('crypto');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, p, b) {
    const res = await realFetch(base + p, { method, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const set = res.headers.get('set-cookie'); if (set) jar[who] = set.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data };
  }
  const reg = (who, extra = {}) => call(who, 'POST', '/api/register', { username: who, password: 'secret1', name: who.toUpperCase(), ...extra });
  const login = (who) => call(who, 'POST', '/api/login', { username: who, password: 'secret1' });

  // The first account is the admin, no code needed.
  const ck = (await reg('ck')).data.me;
  assert.ok(ck.admin);
  // CK's phone is subscribed to notifications.
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const sub = { endpoint: 'https://push.example/ck-phone', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  assert.strictEqual((await call('ck', 'POST', '/api/push/subscribe', { subscription: sub })).status, 200);

  // Mike has the invite code: straight in.
  const mike = (await reg('mike', { invite: 'fore' })).data.me;
  assert.ok(mike && !mike.admin);
  assert.strictEqual((await reg('wrongcode', { invite: 'nope' })).status, 403);

  // Tammer just signs up: he waits, and CK gets a push.
  assert.deepStrictEqual((await reg('tam')).data, { pending: true });
  assert.ok(!jar.tam, 'no session for a waiting account');
  assert.deepStrictEqual(pushes, ['/ck-phone']);
  assert.strictEqual((await login('tam')).status, 403);
  assert.match((await login('tam')).data.error, /waiting for approval/);
  assert.strictEqual((await reg('tam')).status, 409, 'username is held while waiting');
  assert.ok(!(await call('ck', 'GET', '/api/state')).data.users.some((u) => u.username === 'tam'), "waiting accounts aren't in anyone's list");

  // Only an admin can see or decide.
  assert.strictEqual((await call('mike', 'GET', '/api/admin/signups')).status, 404);
  const [w] = (await call('ck', 'GET', '/api/admin/signups')).data.signups;
  assert.strictEqual(w.username, 'tam');
  assert.strictEqual((await call('mike', 'POST', `/api/admin/signups/${w.id}`, { approve: true })).status, 404);
  assert.strictEqual((await login('tam')).status, 403);

  // Approve: he can log in, and he and CK are Homies.
  const ok = (await call('ck', 'POST', `/api/admin/signups/${w.id}`, { approve: true })).data;
  assert.deepStrictEqual(ok, { ok: true, name: 'TAM', approved: true });
  assert.strictEqual((await call('ck', 'POST', `/api/admin/signups/${w.id}`, { approve: true })).status, 404, 'only once');
  const tam = (await login('tam')).data.me;
  assert.ok((await call('tam', 'GET', '/api/state')).data.users.some((u) => u.id === ck.id && u.homie));

  // Decline: the account is gone and the name is free again.
  await reg('spammer');
  const s = (await call('ck', 'GET', '/api/admin/signups')).data.signups.find((u) => u.username === 'spammer');
  assert.strictEqual((await call('ck', 'POST', `/api/admin/signups/${s.id}`, { approve: false })).data.approved, false);
  assert.strictEqual((await login('spammer')).status, 401);
  assert.deepStrictEqual((await reg('spammer')).data, { pending: true });

  // At most 10 waiting at once, so nobody can flood CK's phone.
  for (let i = 0; i < 9; i++) await call(`w${i}`, 'POST', '/api/register', { username: `wait${i}`, password: 'secret1' });
  assert.strictEqual((await call('w9', 'POST', '/api/register', { username: 'wait9', password: 'secret1' })).status, 429);
  assert.ok(tam);

  server.close();
  console.log('v7: ok');
})().catch((e) => { console.error(e); process.exit(1); });
