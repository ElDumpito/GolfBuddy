'use strict';
// The whole server, for real: two friends, a booking, the ledger, push messages and reminders.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golfbuddy-'));
process.env.INVITE_CODE = 'fore';
const { server, reminderTick } = require('../server/index');
const db = require('../server/db');
const { decrypt } = require('./push');
const HOUR = 3600000;

// A stand-in push service: records and decrypts what each user's "phone" receives.
const inbox = {}; const phones = {};
const pushSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const uid = Number(req.url.split('/').pop());
    assert.ok(/^vapid t=/.test(req.headers.authorization));
    assert.strictEqual(req.headers['content-encoding'], 'aes128gcm');
    (inbox[uid] ||= []).push(JSON.parse(decrypt(Buffer.concat(chunks), phones[uid].ecdh, phones[uid].auth)));
    res.writeHead(201); res.end();
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const take = (uid) => { const m = inbox[uid] || []; inbox[uid] = []; return m; };

(async () => {
  await new Promise((r) => server.listen(0, r));
  await new Promise((r) => pushSrv.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, p, body, headers = {}) {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) jar[who] = set.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* html */ }
    return { status: res.status, data };
  }

  // accounts
  assert.strictEqual((await call('x', 'GET', '/api/state')).status, 401);
  assert.strictEqual((await call('x', 'POST', '/api/register', { username: 'zed', password: 'secret1', invite: 'nope' })).status, 403);
  const ck = (await call('ck', 'POST', '/api/register', { username: 'ck', password: 'secret1', name: 'CK', invite: 'fore' })).data.me;
  const mike = (await call('mike', 'POST', '/api/register', { username: 'mike', password: 'secret2', name: 'Mike Buddy', invite: 'fore' })).data.me;
  assert.ok(ck.admin && !mike.admin);
  assert.strictEqual((await call('mike', 'POST', '/api/me', { name: 'Mike Buddy', venmo: '@mike-golf' })).status, 200);
  let st = (await call('ck', 'GET', '/api/state')).data;
  assert.strictEqual(st.users.find((u) => u.id === mike.id).venmo, 'mike-golf');
  assert.strictEqual(st.invite, 'fore');
  assert.strictEqual((await call('mike', 'GET', '/api/state')).data.invite, undefined);
  // writes must be JSON
  assert.strictEqual((await fetch(base + '/api/me', { method: 'POST', headers: { Cookie: jar.ck, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);

  // each phone subscribes (straight into the database: the real subscribe call insists on https)
  for (const u of [ck, mike]) {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const auth = crypto.randomBytes(16);
    phones[u.id] = { ecdh, auth };
    db.addSub(u.id, { endpoint: `http://127.0.0.1:${pushSrv.address().port}/push/${u.id}`, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  }

  // reading a pasted confirmation matches the booker to an account
  const parsed = (await call('mike', 'POST', '/api/parse', { text: fs.readFileSync(path.join(__dirname, 'fixtures', 'lacity.txt'), 'utf8') })).data;
  assert.strictEqual(parsed.bookerId, mike.id); assert.strictEqual(parsed.course, 'Rancho Park'); assert.strictEqual(parsed.deposit, 2000);

  // Mike books 3 days out, $20 deposit, 24h free cancellation
  const tee = Date.now() + 72 * HOUR;
  let r = await call('mike', 'POST', '/api/bookings', { course: 'Rancho Park', teeAt: tee, players: 2, holes: 18, bookerId: mike.id, roster: [ck.id, mike.id], deposit: '20', total: '', cancelHours: 24, source: 'L.A. City Golf' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const bid = r.data.booking.id;
  assert.strictEqual(r.data.booking.address, '10460 W Pico Blvd, Los Angeles, CA 90064'); // from the course list
  await wait(150);
  let m = take(ck.id);
  assert.strictEqual(m.length, 1); assert.ok(m[0].title.includes('New tee time: Rancho Park')); assert.deepStrictEqual(m[0].actions.map((a) => a.action), ['in', 'out']);
  assert.strictEqual(take(mike.id).length, 0); // you are not told about your own booking
  st = (await call('ck', 'GET', '/api/state')).data;
  const bal = (s, id) => s.balances.find((b) => b.userId === id).balance;
  assert.strictEqual(bal(st, mike.id), 1000); assert.strictEqual(bal(st, ck.id), -1000);
  assert.deepStrictEqual(st.transfers, [{ fromId: ck.id, toId: mike.id, amount: 1000 }]);

  // CK says he's out; Mike hears about it
  await call('ck', 'POST', `/api/bookings/${bid}/rsvp`, { rsvp: 'out' }); await wait(150);
  m = take(mike.id); assert.strictEqual(m.length, 1); assert.ok(m[0].title.includes('is out'));
  await call('ck', 'POST', `/api/bookings/${bid}/rsvp`, { rsvp: 'in' }); await wait(150); take(mike.id);

  // food at the turn, paid by CK, split evenly
  r = await call('ck', 'POST', '/api/expenses', { amount: '24', paidBy: ck.id, category: 'Food & drinks', description: 'Burgers', split: { mode: 'even', ids: [ck.id, mike.id] }, bookingId: bid });
  assert.strictEqual(r.status, 200); const foodId = r.data.id;
  await wait(150); m = take(mike.id); assert.ok(m[0].body.includes('your share $12.00'), m[0].body);
  st = (await call('ck', 'GET', '/api/state')).data;
  assert.strictEqual(bal(st, mike.id), -200);
  // custom split must add up; deposit line cannot be deleted directly; only the creator/payer deletes
  assert.strictEqual((await call('ck', 'POST', '/api/expenses', { amount: '10', paidBy: ck.id, category: 'Pro shop', split: { mode: 'custom', shares: { [ck.id]: '3', [mike.id]: '3' } } })).status, 400);
  const dep = st.expenses.find((e) => e.auto === 'deposit');
  assert.strictEqual((await call('ck', 'DELETE', `/api/expenses/${dep.id}`)).status, 400);
  assert.strictEqual((await call('mike', 'DELETE', `/api/expenses/${foodId}`)).status, 403);

  // Mike settles the $2 by Venmo
  r = await call('mike', 'POST', '/api/settlements', { toId: ck.id, amount: '2', method: 'venmo' });
  assert.strictEqual(r.status, 200); await wait(150); assert.ok(take(ck.id)[0].title.includes('$2.00 settled'));
  st = (await call('ck', 'GET', '/api/state')).data;
  assert.strictEqual(bal(st, ck.id), 0); assert.deepStrictEqual(st.transfers, []);

  // the deposit follows the booking when it is edited
  r = await call('mike', 'PUT', `/api/bookings/${bid}`, { course: 'Rancho Park', teeAt: tee, players: 2, holes: 18, bookerId: mike.id, roster: [ck.id, mike.id], deposit: '30', total: '90', cancelHours: 24 });
  assert.strictEqual(r.status, 200);
  st = (await call('ck', 'GET', '/api/state')).data;
  assert.strictEqual(bal(st, mike.id), 500); assert.strictEqual(st.expenses.filter((e) => e.auto).length, 1);

  // reminders: nothing yet; "still in?" 12h before free cancellation ends; then the evening before
  take(ck.id); take(mike.id);
  await reminderTick(Date.now(), async () => null); assert.strictEqual((inbox[ck.id] || []).length, 0);
  await reminderTick(tee - 36 * HOUR + 60000, async () => null);
  m = take(ck.id); assert.strictEqual(m.length, 1); assert.ok(m[0].title.startsWith('⏰ Last call to cancel'), m[0].title); assert.ok(m[0].requireInteraction);
  assert.strictEqual(take(mike.id).length, 1);
  await reminderTick(tee - 35 * HOUR, async () => null); assert.strictEqual(take(ck.id).length, 0); // only once
  const eve = require('../server/index').eveAt({ teeAt: tee });
  await reminderTick(eve + 60000, async () => null); m = take(ck.id); assert.strictEqual(m.length, 1); assert.ok(m[0].title.startsWith('🏌️ Tomorrow'));

  // answering from the notification (what the service worker does)
  await call('ck', 'POST', `/api/bookings/${bid}/rsvp`, { rsvp: 'out' });
  st = (await call('ck', 'GET', '/api/state')).data;
  assert.strictEqual(st.bookings[0].roster.find((x) => x.userId === ck.id).rsvp, 'out');

  // scorecard: pars learned by the course, strokes saved
  r = await call('ck', 'POST', '/api/rounds', { bookingId: bid, holes: 18, players: [ck.id, mike.id] });
  assert.strictEqual(r.status, 200); const rid = r.data.round.id;
  const pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5];
  r = await call('mike', 'PUT', `/api/rounds/${rid}`, { pars, scores: { [ck.id]: [5, 4, 3], [mike.id]: [4, 5, 4] } });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.data.round.scores.find((s) => s.userId === ck.id).strokes, [5, 4, 3]);
  assert.strictEqual((await call('mike', 'PUT', `/api/rounds/${rid}`, { scores: { [ck.id]: [0] } })).status, 400);
  st = (await call('ck', 'GET', '/api/state')).data;
  assert.deepStrictEqual(st.courses.find((c) => c.name === 'Rancho Park').pars, pars);
  r = await call('ck', 'POST', '/api/rounds', { course: 'Rancho Park', holes: 9, startHole: 10, players: [ck.id] });
  assert.deepStrictEqual(r.data.round.pars, pars.slice(9));

  // cancelling tells the others
  await call('mike', 'POST', `/api/bookings/${bid}/cancel`, {}); await wait(150);
  assert.ok(take(ck.id)[0].title.startsWith('🚫 Cancelled'));

  // the app shell, the share target and the manifest
  let res = await fetch(base + '/share?text=hello'); assert.ok((await res.text()).includes('<div id="app">'));
  res = await fetch(base + '/manifest.json'); assert.strictEqual((await res.json()).share_target.action, '/share');
  res = await fetch(base + '/sw.js'); assert.strictEqual(res.headers.get('service-worker-allowed'), '/');
  res = await fetch(base + '/../server/db.js'); assert.ok((await res.text()).includes('<div id="app">')); // no escaping the public folder

  console.log('e2e: ok');
  server.close(); pushSrv.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
