'use strict';
// Homies: a third person joins from CK's QR code. They see CK, not Mike; they can't open CK and
// Mike's tee time; money is counted pair by pair; a foursome scorecard works across Homies.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golfhomie-v5-'));
process.env.INVITE_CODE = 'fore';
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (new URL(url).hostname === '127.0.0.1') return realFetch(url, opts);
  throw new Error('unexpected outside call: ' + url);
};
const { server } = require('../server/index');

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
  const reg = async (who, name, extra) => (await call(who, 'POST', '/api/register', { username: who, password: 'secret1', name, ...extra })).data;
  const ck = (await reg('ck', 'CK', { invite: 'fore' })).me;
  const mike = (await reg('mike', 'Mike', { invite: 'fore' })).me;
  const st = async (who) => (await call(who, 'GET', '/api/state')).data;
  assert.ok((await st('mike')).users.find((u) => u.id === ck.id).homie, 'invite-code sign-ups are linked with the admin');

  // Tammer signs up from CK's QR code: no invite code needed, and he's CK's Homie (not Mike's).
  const code = (await call('ck', 'GET', '/api/homies/code')).data.code;
  // Tammer signs up from CK's code: he waits for approval, then he's linked with CK.
  assert.deepStrictEqual(await reg('tam', 'Tammer', { homie: code }), { pending: true });
  assert.strictEqual((await call('tam', 'POST', '/api/login', { username: 'tam', password: 'secret1' })).status, 403);
  const waiting = (await call('ck', 'GET', '/api/admin/signups')).data.signups;
  assert.strictEqual(waiting[0].viaName, 'CK');
  await call('ck', 'POST', `/api/admin/signups/${waiting[0].id}`, { approve: true });
  const tam = (await call('tam', 'POST', '/api/login', { username: 'tam', password: 'secret1' })).data.me;
  assert.ok((await st('tam')).users.some((u) => u.id === ck.id && u.homie));
  assert.ok(!(await st('tam')).users.some((u) => u.id === mike.id), "Tammer doesn't see Mike");
  assert.ok(!(await st('mike')).users.some((u) => u.id === tam.id), "Mike doesn't see Tammer");
  assert.strictEqual((await call('ck', 'POST', '/api/homies', { code })).status, 400, 'own code');

  // CK and Mike's tee time stays theirs.
  const tee = Date.now() + 5 * 86400000;
  const b = (await call('ck', 'POST', '/api/bookings', { course: 'Rancho Park', teeAt: tee, players: 2, holes: 18, bookerId: mike.id, roster: [ck.id, mike.id], deposit: '20', total: '', cancelHours: 24 })).data.booking;
  assert.ok(!(await st('tam')).bookings.some((x) => x.id === b.id));
  assert.strictEqual((await call('tam', 'GET', `/api/bookings/${b.id}/brief`)).status, 404);
  assert.strictEqual((await call('tam', 'POST', `/api/bookings/${b.id}/rsvp`, { rsvp: 'out' })).status, 404);

  // Money pair by pair: Tammer owes CK for lunch; Mike's deposit is between Mike and CK only.
  await call('ck', 'POST', '/api/expenses', { amount: '30', paidBy: ck.id, category: 'Food & drinks', split: { mode: 'even', ids: [ck.id, tam.id] } });
  const ckView = await st('ck');
  const owe = (s, from, to) => s.transfers.find((t) => t.fromId === from && t.toId === to)?.amount;
  assert.strictEqual(owe(ckView, tam.id, ck.id), 1500);
  assert.strictEqual(owe(ckView, ck.id, mike.id), 1000, 'CK owes Mike half the deposit');
  const tamView = await st('tam');
  assert.strictEqual(tamView.transfers.length, 1, 'Tammer only sees his own debt');
  assert.strictEqual(owe(tamView, tam.id, ck.id), 1500);
  assert.ok(!tamView.expenses.some((e) => e.bookingId === b.id), "Tammer doesn't see CK and Mike's deposit");

  // Scan-to-link: Mike scans Tammer's code; now a foursome card with all of them works.
  const tcode = (await call('tam', 'GET', '/api/homies/code')).data.code;
  assert.strictEqual((await call('mike', 'POST', '/api/homies', { code: tcode })).data.added, true);
  assert.ok((await st('mike')).users.some((u) => u.id === tam.id && u.homie));
  const round = (await call('mike', 'POST', '/api/rounds', { course: 'Rancho Park', holes: 18, players: [ck.id, mike.id, tam.id] })).data.round;
  assert.strictEqual(round.scores.length, 3);
  await call('tam', 'PUT', `/api/rounds/${round.id}`, { scores: { [tam.id]: [4] } });
  assert.strictEqual((await call('ck', 'GET', `/api/rounds/${round.id}`)).data.round.scores.find((s) => s.userId === tam.id).strokes[0], 4);
  // A fresh code retires the old one.
  await call('ck', 'POST', '/api/homies/code', { fresh: true });
  await call('x', 'POST', '/api/register', { username: 'newguy', password: 'secret1', homie: code });
  assert.strictEqual((await call('ck', 'GET', '/api/admin/signups')).data.signups.find((u) => u.username === 'newguy').via, null, 'old code links nobody');
  // Unlinking hides them again (past shared things stay visible).
  await call('tam', 'DELETE', `/api/homies/${mike.id}`);
  assert.ok(!(await st('tam')).users.find((u) => u.id === mike.id)?.homie);

  server.close();
  console.log('v5: ok');
})().catch((e) => { console.error(e); process.exit(1); });
