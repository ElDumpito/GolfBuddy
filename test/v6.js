'use strict';
// Camera reading: photos go to Anthropic only once a key is set; what comes back is checked and
// trimmed; a scorecard read knows the round's players and holes; and each person has a daily cap.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golfhomie-v6-'));
process.env.INVITE_CODE = 'fore';
const realFetch = global.fetch;
let reply = '{}', sent = null, calls = 0;
global.fetch = async (url, opts) => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  if (u.hostname === 'api.anthropic.com') {
    calls++; sent = { headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: reply }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('unexpected outside call: ' + url);
};
const { server } = require('../server/index');
const IMG = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64');

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
  const ck = (await call('ck', 'POST', '/api/register', { username: 'ck', password: 'secret1', name: 'CK Nelson', invite: 'fore' })).data.me;
  const mike = (await call('mike', 'POST', '/api/register', { username: 'mike', password: 'secret1', name: 'Mike Cunjak', invite: 'fore' })).data.me;

  // No key: nothing leaves the NAS.
  assert.strictEqual((await call('ck', 'GET', '/api/state')).data.features.vision, false);
  const nokey = await call('ck', 'POST', '/api/read', { kind: 'receipt', image: IMG });
  assert.strictEqual(nokey.status, 400); assert.match(nokey.data.error, /Anthropic key/); assert.strictEqual(calls, 0);
  // Only the admin can set it, and it's shown as the last 4 characters.
  await call('mike', 'POST', '/api/admin/keys', { anthropic_key: 'sk-ant-mike' });
  assert.strictEqual(calls, 0);
  const keys = (await call('ck', 'POST', '/api/admin/keys', { anthropic_key: 'sk-ant-test-1234' })).data.keys;
  assert.strictEqual(keys.anthropic_key, '…1234');
  assert.strictEqual((await call('ck', 'GET', '/api/state')).data.features.vision, true);

  // Receipt: money becomes cents, a made-up category becomes Other, a bad date is dropped.
  reply = 'Here you go:\n```json\n{"merchant":"Rancho Park Grill","total":"23.47","date":"Nov 24","category":"Snacks","note":"2 burgers"}\n```';
  let r = (await call('ck', 'POST', '/api/read', { kind: 'receipt', image: IMG })).data.read;
  assert.deepStrictEqual(r, { merchant: 'Rancho Park Grill', note: '2 burgers', total: 2347, date: null, category: 'Other' });
  assert.strictEqual(sent.headers['x-api-key'], 'sk-ant-test-1234');
  assert.strictEqual(sent.body.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.match(sent.body.messages[0].content[1].text, /Food & drinks/);

  // Gear: unknown kind becomes other.
  reply = '{"kind":"fairway wood","brand":"TaylorMade","model":"Qi35","detail":"15°"}';
  r = (await call('ck', 'POST', '/api/read', { kind: 'gear', image: IMG })).data.read;
  assert.deepStrictEqual(r, { kind: 'other', brand: 'TaylorMade', model: 'Qi35', detail: '15°' });

  // Player Card.
  reply = '{"cardNo":"PC 0041-2290","cardExp":"2027-03-31"}';
  r = (await call('ck', 'POST', '/api/read', { kind: 'card', image: IMG })).data.read;
  assert.deepStrictEqual(r, { cardNo: 'PC0041-2290', cardExp: '2027-03-31' });

  // Scorecard: the prompt knows the round; impossible numbers become blanks; rows are cut to the round's length.
  const round = (await call('ck', 'POST', '/api/rounds', { course: 'Rancho Park', holes: 9, startHole: 10, players: [ck.id, mike.id] })).data.round;
  reply = JSON.stringify({ pars: [4, 4, 3, 5, 4, 4, 3, 4, 5, 72], players: [{ name: 'Mike', strokes: [5, 4, 3, 6, 5, 4, 4, 5, 6, 42] }, { name: 'CK', strokes: [4, 'x', 47, 5, 4, null, 3, 4, 5] }, { name: 'TOTAL', strokes: [] }] });
  r = (await call('ck', 'POST', '/api/read', { kind: 'scorecard', image: IMG, roundId: round.id })).data.read;
  assert.match(sent.body.messages[0].content[1].text, /9 holes starting at hole 10/);
  assert.match(sent.body.messages[0].content[1].text, /CK Nelson, Mike Cunjak/);
  assert.deepStrictEqual(r.pars, [4, 4, 3, 5, 4, 4, 3, 4, 5]);
  assert.strictEqual(r.players.length, 2);
  assert.deepStrictEqual(r.players[1].strokes, [4, null, null, 5, 4, null, 3, 4, 5]);
  // Nothing was saved by reading.
  assert.ok((await call('ck', 'GET', `/api/rounds/${round.id}`)).data.round.scores.every((s) => !s.strokes.some(Boolean)));
  // Someone not on the round can't read against it.
  await call('tam', 'POST', '/api/register', { username: 'tam', password: 'secret1', name: 'Tammer', homie: (await call('ck', 'GET', '/api/homies/code')).data.code });
  assert.strictEqual((await call('tam', 'POST', '/api/read', { kind: 'scorecard', image: IMG, roundId: round.id })).status, 404);

  // Garbage in: a bad image or a reply with no JSON are errors, not crashes.
  assert.strictEqual((await call('ck', 'POST', '/api/read', { kind: 'receipt', image: 'http://x/y.jpg' })).status, 400);
  reply = 'Sorry, I cannot see a receipt.';
  assert.match((await call('ck', 'POST', '/api/read', { kind: 'receipt', image: IMG })).data.error, /Could not read/);
  assert.strictEqual((await call('ck', 'POST', '/api/read', { kind: 'selfie', image: IMG })).status, 400);

  // Daily cap: 40 photos per person per day.
  reply = '{"cardNo":"1"}';
  let last;
  for (let i = 0; i < 40; i++) last = await call('mike', 'POST', '/api/read', { kind: 'card', image: IMG });
  assert.strictEqual(last.status, 200);
  assert.strictEqual((await call('mike', 'POST', '/api/read', { kind: 'card', image: IMG })).status, 429);
  assert.strictEqual((await call('tam', 'POST', '/api/read', { kind: 'card', image: IMG })).status, 200, 'caps are per person');

  server.close();
  console.log('v6: ok');
})().catch((e) => { console.error(e); process.exit(1); });
