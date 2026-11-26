'use strict';
// Bookings by email: a confirmation forwarded from Gmail becomes a tee time; the same email again
// does nothing; a cancellation cancels it; Gmail's forwarding code is captured; a wrong key is refused.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golfhomie-v4-'));
process.env.INVITE_CODE = 'fore';
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (new URL(url).hostname === '127.0.0.1') return realFetch(url, opts);
  throw new Error('unexpected outside call: ' + url);
};
const { server } = require('../server/index');
const db = require('../server/db');
const { readEmail } = require('../server/mail');

// A confirmation for a date in the future, as L.A. City's sender writes it (quoted-printable HTML + text).
const d = new Date(Date.now() + 10 * 86400000);
const longDate = d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' });
const body = fs.readFileSync(path.join(__dirname, 'fixtures', 'lacity.txt'), 'utf8')
  .replace(/Date of Play: .*/, `Date of Play: ${longDate}`).replace('Rancho Park (Back 9)', 'Rancho Park').replace('Reservation Name: Mike Buddy', 'Reservation Name: Mike Buddy');
const qp = (s) => s.replace(/=/g, '=3D').replace(/(.{70})/g, '$1=\n');
const mime = (subject, text, html = `<p>${text.replace(/\n/g, '<br>')}</p>`) => [
  'From: CK <ck@example.com>', `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '',
  '--b1', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable', '', qp(text), '',
  '--b1', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(html).toString('base64'), '', '--b1--', ''].join('\r\n');

{
  const m = readEmail(mime('=?UTF-8?Q?Fwd:_Tee_Time_Confirmation?=', 'Course: Rancho Park\nPrice =3D $10'));
  assert.strictEqual(m.subject, 'Fwd: Tee Time Confirmation');
  assert.ok(m.text.includes('Course: Rancho Park'));
  const htmlOnly = readEmail(['Subject: x', 'Content-Type: text/html', '', '<div>Course: Wilson</div><div>Players: 2</div>'].join('\r\n'));
  assert.strictEqual(htmlOnly.text, 'Course: Wilson\nPlayers: 2');
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, p, b, headers = {}) {
    const res = await realFetch(base + p, { method, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: b ? JSON.stringify(b) : undefined });
    const set = res.headers.get('set-cookie'); if (set) jar[who] = set.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data };
  }
  const ck = (await call('ck', 'POST', '/api/register', { username: 'ck', password: 'secret1', name: 'CK', invite: 'fore' })).data.me;
  const mike = (await call('mike', 'POST', '/api/register', { username: 'mike', password: 'secret2', name: 'Mike Buddy', invite: 'fore' })).data.me;
  await call('ck', 'POST', '/api/me', { name: 'CK', venmo: '', fwd: 'CK@Example.com' });
  assert.strictEqual((await call('mike', 'GET', '/api/admin/inbound')).status, 404, 'admin only');
  const key = (await call('ck', 'GET', '/api/admin/inbound')).data.key;
  assert.ok(/^[0-9a-f]{48}$/.test(key));
  const send = (raw, k = key, from = 'ck@example.com') => call('worker', 'POST', '/api/inbound', { from, to: 'bookings@juno.nexus', raw }, { 'X-Inbound-Key': k });

  assert.strictEqual((await send(mime('Tee Time Confirmation', body), 'nope')).status, 403);
  let r = await send(mime('Fwd: Tee Time Confirmation', body));
  assert.strictEqual(r.data.result, 'added', JSON.stringify(r.data));
  const b = db.bookingById(r.data.bookingId);
  assert.strictEqual(b.course, 'Rancho Park');
  assert.strictEqual(b.bookerId, mike.id, 'booker matched from the reservation name');
  assert.strictEqual(b.deposit, 2000);
  assert.strictEqual(b.confirmation, '640000001');
  assert.ok(b.total > 0 && b.priceAuto, 'priced from the City rates');
  assert.match(b.source, /^Email/);
  assert.strictEqual((await send(mime('Fwd: Tee Time Confirmation', body))).data.result, 'already in the app');
  // Cancellation email for the same confirmation number.
  r = await send(mime('Tee Time Cancellation', body.replace('Course:', 'Your tee time has been cancelled.\nCourse:')));
  assert.strictEqual(r.data.result, 'cancelled');
  assert.strictEqual(db.bookingById(b.id).status, 'cancelled');
  // Not a tee time.
  assert.strictEqual((await send(mime('Lunch?', 'Want to grab lunch'))).data.result, 'not a tee time');
  // Gmail's forwarding confirmation: the code is kept for the admin.
  r = await send(mime('(#123456789) Gmail Forwarding Confirmation - Receive Mail from ck@gmail.com', 'ck@gmail.com has requested to automatically forward mail to your email address bookings@juno.nexus.\nConfirmation code: 123456789\n'), key, 'forwarding-noreply@google.com');
  assert.strictEqual(r.data.code, '123456789');
  const admin = (await call('ck', 'GET', '/api/admin/inbound')).data;
  assert.strictEqual(admin.gmail.code, '123456789');
  assert.ok(admin.log.length >= 5 && admin.log[0].subject.includes('Gmail Forwarding'));
  // A new key retires the old one.
  const k2 = (await call('ck', 'POST', '/api/admin/inbound', { rotate: true })).data.key;
  assert.notStrictEqual(k2, key);
  assert.strictEqual((await send(mime('x', 'y'))).status, 403);

  server.close();
  console.log('v4: ok');
})().catch((e) => { console.error(e); process.exit(1); });
