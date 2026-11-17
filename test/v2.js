'use strict';
// Round Brief, keys, wake-up calls, shot tracking and the bag. Outside services (weather, Google,
// Twilio, the product database) are replaced by a stand-in that answers like they do.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golfbuddy-v2-'));
process.env.INVITE_CODE = 'fore';

const HOUR = 3600000, MIN = 60000;
const calls = [];
const realFetch = global.fetch;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  calls.push({ host: u.hostname, path: u.pathname, opts });
  if (u.hostname === 'api.weather.gov' && u.pathname.startsWith('/points/')) return json({ properties: { forecastHourly: 'https://api.weather.gov/gridpoints/LOX/1,2/forecast/hourly', forecast: 'https://api.weather.gov/gridpoints/LOX/1,2/forecast' } });
  if (u.hostname === 'api.weather.gov' && u.pathname.endsWith('/hourly')) {
    const t0 = Math.floor(Date.now() / HOUR) * HOUR;
    return json({ properties: { periods: Array.from({ length: 150 }, (_, k) => ({ startTime: new Date(t0 + k * HOUR).toISOString(), endTime: new Date(t0 + (k + 1) * HOUR).toISOString(),
      temperature: 60 + (k % 6), windSpeed: k % 2 ? '5 to 10 mph' : '8 mph', windDirection: 'W', probabilityOfPrecipitation: { value: 10 }, shortForecast: 'Sunny' })) } });
  }
  if (u.hostname === 'geocoding.geo.census.gov') {
    const a = u.searchParams.get('address');
    return json({ result: { addressMatches: /nowhere/i.test(a) ? [] : [{ coordinates: { x: -118.28, y: 34.06 }, matchedAddress: a.toUpperCase() }] } });
  }
  if (u.hostname === 'routes.googleapis.com') {
    assert.ok(opts.headers['X-Goog-Api-Key'], 'server key sent');
    assert.ok(/routes.duration/.test(opts.headers['X-Goog-FieldMask']));
    return json({ routes: [{ duration: '1680s', staticDuration: '1320s', distanceMeters: 19000 }] });
  }
  if (u.hostname === 'places.googleapis.com') {
    const b = JSON.parse(opts.body);
    if (/nowhere/i.test(b.textQuery)) return json({});
    if (/test st/i.test(b.textQuery)) return json({ places: [{ location: { latitude: 34.06, longitude: -118.28 }, formattedAddress: '123 Test St' }] });
    if (/simulator/.test(b.textQuery)) return json({ places: [{ id: 's1', displayName: { text: 'Sim Spot' }, formattedAddress: '1 Main St', location: { latitude: 34.07, longitude: -118.3 }, googleMapsUri: 'https://maps.google.com/?cid=1' }] });
    return json({ places: [{ id: 'r1', displayName: { text: 'Near Range' }, formattedAddress: '2 Main St', location: { latitude: 34.065, longitude: -118.285 } },
      { id: 'r2', displayName: { text: 'Far Range' }, formattedAddress: 'Far away', location: { latitude: 35.5, longitude: -118.3 } }] });
  }
  if (u.hostname === 'api.twilio.com') {
    if (opts.method === 'POST') { const f = new URLSearchParams(opts.body); calls[calls.length - 1].form = Object.fromEntries(f); return json({ sid: `CA${calls.length}` }); }
    return json({ status: 'no-answer', answered_by: null });
  }
  if (u.hostname === 'api.upcitemdb.com') return json({ items: [{ title: 'Titleist Pro V1 Golf Balls', brand: 'TITLEIST', model: 'PRO V1', category: 'Golf Balls' }] });
  if (/overpass/.test(u.hostname)) return json({ elements: [] });
  throw new Error('unexpected outside call: ' + url);
};

const { server } = require('../server/index');
const db = require('../server/db');
const { sunTimes } = require('../server/geo');
const { measureHole, holesFromOsm } = require('../server/track');
const { wakeTick, e164, script } = require('../server/wake');
const svc = require('../server/services');

// ---- pure pieces -------------------------------------------------------------
{
  const s = sunTimes(Date.parse('2026-11-17T20:00:00Z'), 34.0364, -118.4256);
  // Published for Los Angeles on Nov 17, 2026: sunrise 6:29, sunset 4:49 (good to a minute or two).
  assert.ok(Math.abs(s.sunrise - Date.parse('2026-11-17T14:29:00Z')) < 2 * MIN, new Date(s.sunrise).toISOString());
  assert.ok(Math.abs(s.sunset - Date.parse('2026-11-18T00:49:00Z')) < 2 * MIN, new Date(s.sunset).toISOString());
  assert.ok(s.lastLight - s.sunset > 20 * MIN && s.lastLight - s.sunset < 35 * MIN);

  // 3 shots and a pin on a hole running due north: ~200 yd straight, ~150 yd pulled left, ~20 yd chip.
  const Y = 0.9144 / 111195; // degrees latitude per yard (roughly)
  const base = { lat: 34, lon: -118 };
  const pts = [
    { id: 1, kind: 'shot', club: 'Dr', lat: base.lat, lon: base.lon },
    { id: 2, kind: 'shot', club: '7i', lat: base.lat + 200 * Y, lon: base.lon },
    { id: 3, kind: 'shot', club: 'SW', lat: base.lat + 345 * Y, lon: base.lon - 30 * Y / Math.cos(34 * Math.PI / 180) },
    { id: 4, kind: 'pin', lat: base.lat + 360 * Y, lon: base.lon },
  ];
  const m = measureHole(pts, null);
  assert.strictEqual(m.length, 3);
  assert.ok(Math.abs(m[0].yards - 200) <= 2, `drive ${m[0].yards}`);
  assert.ok(Math.abs(m[0].offline) <= 2, 'drive on line');
  assert.ok(m[1].offline < -20, `7i missed left: ${m[1].offline}`);
  assert.strictEqual(m[2].offline, null, 'no miss direction for chips');

  // Two courses in one park: holes are picked by the matching course outline, not just the nearest.
  const ring = (lat, lon) => [[lat, lon], [lat + 0.01, lon], [lat + 0.01, lon + 0.01], [lat, lon + 0.01], [lat, lon]].map(([a, b]) => ({ lat: a, lon: b }));
  const hole = (ref, lat, lon) => ({ type: 'way', tags: { golf: 'hole', ref: String(ref) }, geometry: [{ lat, lon }, { lat: lat + 0.002, lon }, { lat: lat + 0.004, lon }] });
  const els = [
    { type: 'way', tags: { leisure: 'golf_course', name: 'Wilson Golf Course' }, geometry: ring(34.0, -118.0) },
    { type: 'way', tags: { leisure: 'golf_course', name: 'Harding Golf Course' }, geometry: ring(34.0, -117.99) },
    hole(1, 34.001, -117.995), hole(1, 34.001, -117.985), hole(2, 34.003, -117.984),
  ];
  const wilson = holesFromOsm(els, { name: 'Griffith Park - Wilson', lat: 34.005, lon: -117.986 }); // deliberately nearer Harding's hole 1
  assert.strictEqual(wilson.length, 2);
  assert.strictEqual(wilson[0].tee.lon, -117.995, 'Wilson hole 1 comes from inside the Wilson outline');
  assert.ok(Math.abs(wilson[0].green.lat - 34.005) < 1e-9, 'green is the far end of the hole line');

  assert.strictEqual(e164('(310) 555-0123'), '+13105550123');
  assert.strictEqual(e164('555-0123'), null);
  assert.ok(!/<script/.test(script('Mike <b>', { teeAt: Date.now(), course: 'A & B' }, { at: Date.now(), minutes: 30 })), 'spoken text is escaped');
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, p, body) {
    const res = await realFetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) jar[who] = set.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  }
  const ck = (await call('ck', 'POST', '/api/register', { username: 'ck', password: 'secret1', name: 'CK', invite: 'fore' })).data.me;
  const mike = (await call('mike', 'POST', '/api/register', { username: 'mike', password: 'secret2', name: 'Mike Buddy', invite: 'fore' })).data.me;

  // ---- courses come with researched data --------------------------------------
  let st = (await call('ck', 'GET', '/api/state')).data;
  const rancho = st.courses.find((c) => c.name === 'Rancho Park');
  assert.strictEqual(rancho.info.par, 71);
  assert.strictEqual(rancho.info.holes.length, 18);
  assert.ok(rancho.website.startsWith('https://') && rancho.lat > 34);
  assert.ok(rancho.info.notes.length >= 3);
  assert.strictEqual(st.courses.find((c) => c.name === 'Roosevelt').address, '2650 N Vermont Ave, Los Angeles, CA 90027', 'vague seed address replaced');
  assert.strictEqual(st.features.google, false);
  assert.strictEqual(st.mapsKey, null);

  // ---- keys: admin only, write-only ---------------------------------------------
  assert.strictEqual((await call('mike', 'POST', '/api/admin/keys', { google_server_key: 'x' })).status, 404);
  let k = (await call('ck', 'POST', '/api/admin/keys', { google_server_key: 'AIzaServerKey1234', google_browser_key: 'AIzaBrowserKey9876' })).data.keys;
  assert.strictEqual(k.google_server_key, '…1234');
  assert.ok(!JSON.stringify(k).includes('AIzaServer'), 'server key never sent back');
  st = (await call('mike', 'GET', '/api/state')).data;
  assert.strictEqual(st.mapsKey, 'AIzaBrowserKey9876', 'browser key reaches the app');
  assert.ok(!JSON.stringify(st).includes('AIzaServerKey1234'), 'server key never in state');
  assert.strictEqual(st.features.google, true);

  // ---- profile: home address is looked up, private, and wake-up needs phone + home ---
  assert.strictEqual((await call('mike', 'POST', '/api/me', { name: 'Mike Buddy', venmo: '', home: 'Nowhere at all', phone: '' })).status, 400);
  assert.strictEqual((await call('mike', 'POST', '/api/me', { name: 'Mike Buddy', venmo: '', home: '', phone: '', wakeOk: true })).status, 400);
  assert.strictEqual((await call('mike', 'POST', '/api/me', { name: 'Mike Buddy', venmo: '', home: '123 Test St, Los Angeles, CA 90026', phone: '310 555 0123', arriveMins: 30, wakeOk: true, tee: 'White' })).status, 200);
  st = (await call('mike', 'GET', '/api/state')).data;
  assert.ok(st.me.homeSet && st.me.wakeOk && st.me.phone === '310 555 0123');
  const seenByCk = (await call('ck', 'GET', '/api/state')).data.users.find((u) => u.id === mike.id);
  assert.strictEqual(seenByCk.phone, undefined, "Mike's phone isn't shown to others");
  assert.strictEqual(seenByCk.home, undefined);

  // ---- the brief ---------------------------------------------------------------------
  const tomorrow7 = (() => { const t = Date.now() + 26 * HOUR; const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t); return Date.parse(`${p}T07:00:00-08:00`); })();
  const b = (await call('ck', 'POST', '/api/bookings', { course: 'Rancho Park', teeAt: tomorrow7, players: 2, holes: 18, bookerId: ck.id, cancelHours: 24 })).data.booking;
  const brief = (await call('mike', 'GET', `/api/bookings/${b.id}/brief`)).data;
  assert.strictEqual(brief.weather.status, 'hourly');
  assert.ok(brief.weather.at.temp >= 60 && brief.weather.windMax >= 8);
  assert.ok(brief.sun.sunrise && brief.sun.sunset && brief.sun.finish > b.teeAt);
  assert.strictEqual(brief.leave.status, 'ok');
  assert.strictEqual(brief.leave.minutes, 28);
  assert.strictEqual(brief.leave.at, tomorrow7 - 30 * MIN - 28 * MIN);
  assert.strictEqual(brief.course.info.par, 71);
  assert.strictEqual(brief.wake.on, true, 'on by default before 8 a.m.');
  assert.strictEqual(brief.wake.people.find((p) => p.userId === mike.id).ready, true);
  assert.strictEqual((await call('ck', 'GET', `/api/bookings/${b.id}/brief`)).data.leave.status, 'nohome', 'CK has no home address');
  const before = calls.length;
  await call('mike', 'GET', `/api/bookings/${b.id}/brief`);
  assert.strictEqual(calls.length, before, 'second look is served from the cache');

  // ---- wake-up call: planned, rung, retried, reported --------------------------------
  const pushes = [];
  const notify = async (ids, msg) => { pushes.push({ ids, msg }); return ids.length; };
  const leaveAt = brief.leave.at, callAt = leaveAt - 30 * MIN;
  await wakeTick(callAt - 5 * HOUR, { notify });
  assert.strictEqual(db.wakeLog(b.id)[mike.id].callAt, callAt);
  assert.strictEqual(pushes.length, 0);
  await wakeTick(callAt - 10 * MIN, { notify });
  assert.strictEqual(pushes.length, 0, 'not yet');
  // Twilio not set up yet: push only.
  await wakeTick(callAt + 10000, { notify });
  assert.strictEqual(pushes.length, 1);
  assert.deepStrictEqual(pushes[0].ids, [mike.id]);
  assert.match(pushes[0].msg.body, /Leave by/);
  assert.strictEqual(db.wakeLog(b.id)[mike.id].done, 'push-only');
  // With Twilio set up: call, no answer, call again, no answer, CK told.
  await call('ck', 'POST', '/api/admin/keys', { twilio_sid: 'ACtest', twilio_token: 'tok', twilio_from: '+13105550000' });
  await call('ck', 'POST', `/api/bookings/${b.id}/wake`, { wake: true });
  pushes.length = 0;
  await wakeTick(callAt - 5 * HOUR, { notify });
  await wakeTick(callAt + 1000, { notify });
  const placed = calls.filter((c) => c.host === 'api.twilio.com' && c.form);
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(placed[0].form.To, '+13105550123');
  assert.match(placed[0].form.Twiml, /Leave by/);
  await wakeTick(callAt + 2 * MIN, { notify });           // status: no answer
  await wakeTick(callAt + 7.5 * MIN, { notify });         // second call
  assert.strictEqual(calls.filter((c) => c.host === 'api.twilio.com' && c.form).length, 2);
  await wakeTick(callAt + 9.5 * MIN, { notify });         // still no answer: tell the others
  const told = pushes.find((p) => p.ids.includes(ck.id));
  assert.ok(told && /didn't pick up/.test(told.msg.title), 'CK hears that Mike missed it');
  assert.strictEqual(db.wakeLog(b.id)[mike.id].done, 'missed');
  // Switching it off stops everything.
  await call('ck', 'POST', `/api/bookings/${b.id}/wake`, { wake: false });
  const n = calls.length; await wakeTick(callAt + 1000, { notify }); assert.strictEqual(calls.length, n);

  // ---- ranges & simulators: within 30 miles, nearest first -----------------------------
  const pr = (await call('mike', 'GET', '/api/practice')).data;
  assert.deepStrictEqual(pr.places.map((p) => p.name), ['Near Range', 'Sim Spot']);
  assert.strictEqual(pr.places[1].kind, 'sim');

  // ---- shots ---------------------------------------------------------------------------
  const round = (await call('mike', 'POST', '/api/rounds', { course: 'Rancho Park', holes: 18, players: [ck.id, mike.id] })).data.round;
  assert.strictEqual(round.pars.join(','), '4,4,3,5,4,4,4,3,4,4,4,3,4,4,4,3,5,5', 'pars from the researched scorecard');
  const Y = 0.9144 / 111195;
  const at = (yds) => ({ lat: 34.036 + yds * Y, lon: -118.425 });
  assert.strictEqual((await call('mike', 'POST', `/api/rounds/${round.id}/shots`, { hole: 1, club: 'Dr', lat: 0, lon: 0 })).status, 400);
  await call('mike', 'POST', `/api/rounds/${round.id}/shots`, { hole: 1, club: 'Dr', ...at(0), acc: 4 });
  const s2 = (await call('mike', 'POST', `/api/rounds/${round.id}/shots`, { hole: 1, club: '9i', ...at(250), acc: 4 })).data.shot;
  await call('mike', 'POST', `/api/rounds/${round.id}/shots`, { hole: 1, kind: 'pin', ...at(370), acc: 3 });
  let sh = (await call('mike', 'GET', `/api/rounds/${round.id}/shots`)).data;
  assert.strictEqual(sh.shots.length, 3);
  const h1 = sh.holes.find((h) => h.hole === 1);
  assert.ok(h1 && h1.tee && h1.green && h1.source === 'you', 'tee and green learned from the first round');
  assert.strictEqual((await call('ck', 'PUT', `/api/shots/${s2.id}`, { club: 'PW' })).status, 403, "can't edit someone else's shot");
  await call('mike', 'PUT', `/api/shots/${s2.id}`, { club: '8i' });
  const stats = (await call('mike', 'GET', '/api/shots/stats')).data;
  const dr = stats.clubs.find((c) => c.club === 'Dr'), i8 = stats.clubs.find((c) => c.club === '8i');
  assert.ok(Math.abs(dr.avg - 250) <= 2 && Math.abs(i8.avg - 120) <= 2, JSON.stringify(stats.clubs));
  // a photo (a tiny JPEG) attaches to a shot; anything else is refused
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString('base64');
  assert.strictEqual((await call('mike', 'POST', `/api/shots/${s2.id}/photo`, { data: 'data:image/png;base64,AAAA' })).status, 400);
  assert.strictEqual((await call('mike', 'POST', `/api/shots/${s2.id}/photo`, { data: jpeg })).status, 200);
  const ph = await realFetch(`${base}/api/photos/${s2.id}`, { headers: { Cookie: jar.ck } });
  assert.strictEqual(ph.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual((await realFetch(`${base}/api/photos/${s2.id}`)).status, 401, 'photos need a login');

  // ---- the bag -----------------------------------------------------------------------------
  const look = (await call('mike', 'GET', '/api/gear/lookup?upc=084984561337')).data.item;
  assert.strictEqual(look.model, 'PRO V1');
  const ball = (await call('mike', 'POST', '/api/gear', { kind: 'ball', brand: 'Titleist', model: 'Pro V1', upc: '084984561337' })).data.gear;
  await call('mike', 'POST', '/api/gear', { kind: 'glove', brand: 'FootJoy', model: 'StaSof' });
  st = (await call('mike', 'GET', '/api/state')).data;
  assert.strictEqual(st.gear.length, 2);
  assert.strictEqual(st.support[ball.id].phone, '(800) 333-4200');
  assert.strictEqual((await call('ck', 'GET', '/api/state')).data.gear.length, 0, 'gear is per person');
  assert.strictEqual((await call('ck', 'DELETE', `/api/gear/${ball.id}`)).status, 404);
  assert.deepStrictEqual((await call('mike', 'PUT', '/api/gear/clubs', { clubs: ['Dr', '5W', '4H', '5i', '7i', 'PW', 'SW', 'Pt'] })).data.clubs.length, 8);
  assert.strictEqual((await call('mike', 'PUT', `/api/rounds/${round.id}/gear`, { ball: ball.id })).status, 200);
  assert.strictEqual((await call('mike', 'GET', `/api/rounds/${round.id}/shots`)).data.gear[mike.id].ball, ball.id);

  // ---- nothing above reached a real outside service, and no key was logged ------------
  assert.ok(calls.every((c) => !String(c.path).includes('AIza')), 'keys go in headers, not URLs');
  server.close();
  console.log('v2: ok');
})().catch((e) => { console.error(e); process.exit(1); });
