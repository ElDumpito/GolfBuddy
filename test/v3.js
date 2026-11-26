'use strict';
// L.A. City prices, "the rest paid at the course", Player Cards, weather alerts and the test call.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golfbuddy-v3-'));
process.env.INVITE_CODE = 'fore';
const HOUR = 3600000;

const realFetch = global.fetch;
const twilioCalls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  if (u.hostname === 'api.twilio.com') { twilioCalls.push(Object.fromEntries(new URLSearchParams(opts.body))); return new Response(JSON.stringify({ sid: 'CAtest' }), { status: 201 }); }
  throw new Error('unexpected outside call: ' + url);
};

const { quote, holiday, twilightStarts } = require('../server/rates');
const { server, weatherTick, reminderTick } = require('../server/index');
const db = require('../server/db');
const { decrypt } = require('./push');

const at = (s) => Date.parse(s);
const cents = (d) => Math.round(d * 100);

// ---- published rates --------------------------------------------------------------
{
  const q = (course, when, o = {}) => quote({ course, teeAt: at(when), ...o });
  assert.strictEqual(q('Rancho Park', '2026-12-02T07:00:00-08:00').green, cents(42), 'weekday');
  assert.strictEqual(q('Rancho Park', '2026-12-05T07:00:00-08:00').green, cents(58), 'weekend before 9 a.m. is the premium rate');
  assert.strictEqual(q('Rancho Park', '2026-12-05T09:00:00-08:00').green, cents(53), 'weekend from 9 a.m.');
  assert.strictEqual(q('Griffith Park - Harding', '2026-11-26T10:00:00-08:00').green, cents(49), 'Thanksgiving uses weekend rates');
  assert.ok(/Thanksgiving/.test(q('Griffith Park - Harding', '2026-11-26T10:00:00-08:00').label));
  // Winter (after the clocks go back): twilight 2 p.m., an hour earlier with a Player Card; super twilight 4 p.m.
  assert.strictEqual(q('Rancho Park', '2026-12-02T13:30:00-08:00', { card: true }).green, cents(28), 'Player Card hour of twilight');
  assert.strictEqual(q('Rancho Park', '2026-12-02T13:30:00-08:00', { card: false }).green, cents(42), 'no card, no early twilight');
  assert.strictEqual(q('Rancho Park', '2026-12-02T16:00:00-08:00').green, cents(19), 'super twilight');
  // Summer schedule: twilight 4 p.m. (3 p.m. with a card).
  assert.strictEqual(q('Griffith Park - Wilson', '2026-07-15T14:30:00-07:00').green, cents(41));
  assert.strictEqual(q('Griffith Park - Wilson', '2026-07-15T15:30:00-07:00').green, cents(27));
  // Rides
  assert.strictEqual(q('Rancho Park', '2026-12-02T07:00:00-08:00', { ride: 'cart' }).rideFee, cents(18));
  assert.strictEqual(q('Rancho Park', '2026-12-02T14:30:00-08:00', { ride: 'cart' }).rideFee, cents(13), 'twilight cart seat');
  assert.strictEqual(q('Rancho Park', '2026-12-02T07:00:00-08:00', { ride: 'push' }).rideFee, cents(8));
  assert.strictEqual(q('Rancho Park', '2026-12-02T07:00:00-08:00', { ride: 'walk' }).rideFee, 0, 'your own cart is free');
  // Roosevelt is 9 holes with its own rates.
  assert.strictEqual(q('Roosevelt', '2026-12-05T08:00:00-08:00', { holes: 9 }).green, cents(27));
  assert.strictEqual(q('Los Verdes Golf Course', '2026-12-02T07:00:00-08:00'), null, 'not an L.A. City course');
  assert.strictEqual(holiday(2027, 1, 18), 'Martin Luther King Jr. Day');
  // The City's 2025 list, checked against these rules.
  for (const [m, d] of [[1, 20], [2, 17], [5, 26], [6, 19], [7, 4], [9, 1], [11, 11], [11, 27], [11, 28], [12, 25]]) assert.ok(holiday(2025, m, d), `2025-${m}-${d}`);
  assert.strictEqual(holiday(2025, 3, 31), null, 'César Chávez Day is not a golf holiday');
  assert.strictEqual(holiday(2025, 10, 13), null);
  assert.deepStrictEqual(twilightStarts(2027, 3, 13), { tw: 13, stw: 15 });
  assert.deepStrictEqual(twilightStarts(2027, 3, 14), { tw: 15, stw: 17 }, 'changes when the clocks go forward');
}

// ---- stand-in push service (decrypts what each phone receives) ---------------------
const inbox = {}; const phones = {};
const pushSrv = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { const uid = Number(req.url.split('/').pop()); (inbox[uid] ||= []).push(JSON.parse(decrypt(Buffer.concat(chunks), phones[uid].ecdh, phones[uid].auth))); res.writeHead(201); res.end(); });
});
const take = (uid) => { const m = inbox[uid] || []; inbox[uid] = []; return m; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  await new Promise((r) => pushSrv.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, p, body) {
    const res = await realFetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) jar[who] = set.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data };
  }
  const ck = (await call('ck', 'POST', '/api/register', { username: 'ck', password: 'secret1', name: 'CK', invite: 'fore' })).data.me;
  const mike = (await call('mike', 'POST', '/api/register', { username: 'mike', password: 'secret2', name: 'Mike Buddy', invite: 'fore' })).data.me;
  for (const u of [ck, mike]) {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const auth = crypto.randomBytes(16);
    phones[u.id] = { ecdh, auth };
    db.addSub(u.id, { endpoint: `http://127.0.0.1:${pushSrv.address().port}/push/${u.id}`, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  }
  const balanceOf = async (who, id) => (await call(who, 'GET', '/api/state')).data.balances.find((b) => b.userId === id).balance;

  // ---- Mike books Rancho (weekday 7 a.m.), pays the $20 deposit; the total comes from the rates ----
  const tee = at('2026-12-02T07:00:00-08:00') > Date.now() ? at('2026-12-02T07:00:00-08:00') : Date.now() + 9 * 24 * HOUR;
  let r = await call('mike', 'POST', '/api/bookings', { course: 'Rancho Park', teeAt: tee, players: 2, holes: 18, bookerId: mike.id, roster: [ck.id, mike.id], deposit: '20', total: '', cancelHours: 24 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  let b = r.data.booking;
  const expect = quote({ course: 'Rancho Park', teeAt: tee }).green * 2;
  assert.strictEqual(b.total, expect, 'total filled in from the City rates');
  assert.ok(b.priceAuto);
  let st = (await call('ck', 'GET', '/api/state')).data;
  assert.strictEqual(st.quotes[b.id].total, expect);
  take(ck.id); take(mike.id);

  // CK pays what's left at the course. The deposit counts toward the total; each owes half.
  assert.strictEqual((await call('ck', 'POST', `/api/bookings/${b.id}/paid`, { by: ck.id })).status, 200);
  await wait(150);
  const told = take(mike.id).find((m) => /paid at Rancho/.test(m.title));
  assert.ok(told, 'Mike hears that CK paid');
  st = (await call('ck', 'GET', '/api/state')).data;
  const line = st.expenses.find((e) => e.bookingId === b.id && e.category === 'Green fees');
  assert.strictEqual(line.amount, expect - 2000);
  assert.strictEqual(line.paidBy, ck.id);
  assert.strictEqual(await balanceOf('ck', ck.id), (expect - 2000) - expect / 2, 'Mike owes CK his half less the deposit he put down');
  assert.strictEqual(await balanceOf('ck', mike.id), 2000 - expect / 2);

  // Switching to riding carts reprices the round and the ledger follows.
  b = (await call('ck', 'POST', `/api/bookings/${b.id}/ride`, { ride: 'cart' })).data.booking;
  const withCarts = expect + 2 * quote({ course: 'Rancho Park', teeAt: tee, ride: 'cart' }).rideFee;
  assert.strictEqual(b.total, withCarts);
  st = (await call('ck', 'GET', '/api/state')).data;
  assert.strictEqual(st.expenses.find((e) => e.bookingId === b.id && e.category === 'Green fees').amount, withCarts - 2000);

  // A total typed by hand stays put (no more automatic prices for that booking).
  b = (await call('ck', 'POST', `/api/bookings/${b.id}/price`, { total: '95' })).data.booking;
  assert.strictEqual(b.total, 9500); assert.ok(!b.priceAuto);
  b = (await call('ck', 'POST', `/api/bookings/${b.id}/ride`, { ride: 'walk' })).data.booking;
  assert.strictEqual(b.total, 9500, 'manual total is not overwritten');
  b = (await call('ck', 'POST', `/api/bookings/${b.id}/price`, { auto: true })).data.booking;
  assert.strictEqual(b.total, expect);

  // "Not yet" takes the line back out; cancelling removes it too.
  await call('ck', 'POST', `/api/bookings/${b.id}/paid`, { by: null });
  st = (await call('ck', 'GET', '/api/state')).data;
  assert.ok(!st.expenses.some((e) => e.bookingId === b.id && e.category === 'Green fees'));

  // Entering a tee time and marking the other person paid, in one go.
  r = await call('ck', 'POST', '/api/bookings', { course: 'Griffith Park - Harding', teeAt: tee + 2 * 24 * HOUR, players: 2, holes: 18, bookerId: mike.id, roster: [ck.id, mike.id], deposit: '20', total: '', cancelHours: 24, balanceBy: mike.id });
  const b2 = r.data.booking;
  assert.strictEqual(b2.balanceBy, mike.id);
  st = (await call('mike', 'GET', '/api/state')).data;
  assert.strictEqual(st.expenses.find((e) => e.bookingId === b2.id && e.category === 'Green fees').paidBy, mike.id);
  // Not an L.A. City course: no automatic price.
  r = await call('ck', 'POST', '/api/bookings', { course: 'Los Verdes Golf Course', teeAt: tee, players: 2, holes: 18, bookerId: ck.id, total: '', cancelHours: 48 });
  assert.strictEqual(r.data.booking.total, 0); assert.ok(!r.data.booking.priceAuto);

  // ---- weather alerts --------------------------------------------------------------------
  take(ck.id); take(mike.id);
  const wx = (pop, wind, sky = 'Rain') => async () => ({ status: 'hourly', at: { temp: 58, wind, pop, sky, dir: 'S' }, popMax: pop, windMax: wind });
  const now = tee - 3 * 24 * HOUR;
  await weatherTick(now, wx(10, 5, 'Sunny')); await wait(150);
  assert.strictEqual(take(ck.id).length, 0, 'fine weather: nothing');
  await weatherTick(now + HOUR, wx(70, 18)); await wait(150);
  const rain = take(ck.id).filter((m) => /Rain in the forecast/.test(m.title));
  assert.strictEqual(rain.length, 3, 'one alert per upcoming tee time with rain'); // Rancho, Harding and Los Verdes
  assert.match(rain[0].body, /70% chance of rain/);
  assert.match(rain[0].body, /Free cancel until/);
  await weatherTick(now + 2 * HOUR, wx(80, 20)); await wait(150);
  assert.strictEqual(take(ck.id).length, 0, 'no repeat while it stays bad');
  await weatherTick(now + 3 * HOUR, wx(10, 6, 'Sunny')); await wait(150);
  assert.ok(take(ck.id).some((m) => /Forecast cleared/.test(m.title)));
  // The cancellation-deadline reminder carries the forecast.
  await reminderTick(b.cancelAt - 11 * HOUR, wx(60, 12)); await wait(150);
  const last = take(ck.id).find((m) => /Last call to cancel/.test(m.title));
  assert.ok(last && /Forecast: 58°, rain, 60% chance of rain/.test(last.body), last && last.body);

  // ---- Player Card: private number, affects twilight price -----------------------------
  assert.strictEqual((await call('mike', 'POST', '/api/me', { name: 'Mike Buddy', venmo: '', card: true, cardNo: '0012345', cardExp: '2027-03-01' })).status, 200);
  assert.strictEqual((await call('mike', 'GET', '/api/state')).data.me.cardNo, '0012345');
  const asSeenByCk = (await call('ck', 'GET', '/api/state')).data;
  assert.ok(!JSON.stringify(asSeenByCk).includes('0012345'), "Mike's card number isn't shown to CK");
  assert.strictEqual(asSeenByCk.users.find((u) => u.id === mike.id).card, true);
  const q = await call('ck', 'GET', `/api/quote?course=Rancho%20Park&teeAt=${at('2026-12-02T13:30:00-08:00')}&holes=18&players=2&roster=${ck.id},${mike.id}`);
  assert.strictEqual(q.data.quote.total, cents(56), 'both on Player Card twilight');
  await call('ck', 'POST', '/api/me', { name: 'CK', venmo: '', card: false, cardNo: '', cardExp: '' });
  const q2 = await call('ck', 'GET', `/api/quote?course=Rancho%20Park&teeAt=${at('2026-12-02T13:30:00-08:00')}&holes=18&players=2&roster=${ck.id},${mike.id}`);
  assert.strictEqual(q2.data.quote.total, cents(28 + 42), "CK without a card pays the regular rate in the card's early hour");
  // Renewal reminder, two weeks out, once.
  await reminderTick(at('2027-02-16T12:00:00-08:00'), async () => null); await wait(150);
  assert.ok(take(mike.id).some((m) => /Player Card/.test(m.title)));
  await reminderTick(at('2027-02-17T12:00:00-08:00'), async () => null); await wait(150);
  assert.ok(!take(mike.id).some((m) => /Player Card/.test(m.title)), 'only once');

  // ---- test call ---------------------------------------------------------------------------
  assert.strictEqual((await call('ck', 'POST', '/api/me/test-call', {})).status, 400, 'no Twilio yet');
  await call('ck', 'POST', '/api/admin/keys', { twilio_sid: 'ACx', twilio_token: 'tok', twilio_from: '+13105550000' });
  assert.strictEqual((await call('ck', 'POST', '/api/me/test-call', {})).status, 400, 'no phone yet');
  await call('ck', 'POST', '/api/me', { name: 'CK', venmo: '', home: '', phone: '(213) 555-0199', arriveMins: 30, wakeOk: false });
  assert.strictEqual((await call('ck', 'POST', '/api/me/test-call', {})).status, 200);
  assert.strictEqual(twilioCalls[0].To, '+12135550199');
  assert.match(twilioCalls[0].Twiml, /test call/);

  server.close(); pushSrv.close();
  console.log('v3: ok');
})().catch((e) => { console.error(e); process.exit(1); });
