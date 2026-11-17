'use strict';
// GolfBuddy: shared tee times, who-owes-who, scorecards. Plain Node HTTP server, no packages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { parseConfirmation, laTime, laParts, fmtWhen } = require('./parse');
const { vapidKeys, sendPush } = require('./push');

const PORT = Number(process.env.PORT || 8790);
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };
const HOUR = 3600000;
// How long before the free-cancellation deadline the "still in?" reminder goes out.
const REMIND_HOURS = Number(process.env.REMIND_HOURS || 12);
const VAPID = vapidKeys(db);
const PUSH_SUBJECT = process.env.PUBLIC_URL && /^https:\/\//.test(process.env.PUBLIC_URL) ? process.env.PUBLIC_URL : 'mailto:golfbuddy@juno.nexus';

let INVITE = process.env.INVITE_CODE && process.env.INVITE_CODE !== 'change-me' ? process.env.INVITE_CODE : db.getSetting('invite');
if (!INVITE) { INVITE = crypto.randomBytes(4).toString('hex'); db.setSetting('invite', INVITE); }
if (!db.userCount()) console.log(`\n  No accounts yet. Register with invite code: ${INVITE}\n  The first account created becomes the admin.\n`);

// ---- small helpers ---------------------------------------------------------
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readJson(req, max = 200000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const attempts = new Map();
function limited(req, max = 20, windowMs = 600000) {
  const ip = clientIp(req), now = Date.now(), a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + windowMs }); return false; }
  return ++a.n > max;
}
function sessionCookie(req, token, maxAge = 60 * 60 * 24 * 365) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
const money = (c) => `$${(c / 100).toFixed(2)}`;
const toCents = (x) => { const n = Number(String(x ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const str = (x, max = 200) => String(x ?? '').trim().slice(0, max);
const userIds = () => db.users().map((u) => u.id);
const nameOf = (id) => db.pubUser(db.userById(id))?.name || 'Someone';
const firstName = (id) => nameOf(id).split(/\s+/)[0];

// Split cents as evenly as possible; leftover cents go to the first people listed.
function evenSplit(amount, ids) {
  const out = {}, base = Math.floor(amount / ids.length);
  let extra = amount - base * ids.length;
  for (const id of ids) { out[id] = base + (extra > 0 ? 1 : 0); extra--; }
  return out;
}
// Who should pay whom so every balance returns to zero.
function transfers(balances) {
  const debt = balances.filter((b) => b.balance < 0).map((b) => ({ id: b.userId, amt: -b.balance })).sort((a, b) => b.amt - a.amt);
  const cred = balances.filter((b) => b.balance > 0).map((b) => ({ id: b.userId, amt: b.balance })).sort((a, b) => b.amt - a.amt);
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].amt, cred[j].amt);
    if (x > 0) out.push({ fromId: debt[i].id, toId: cred[j].id, amount: x });
    debt[i].amt -= x; cred[j].amt -= x;
    if (!debt[i].amt) i++;
    if (!cred[j].amt) j++;
  }
  return out;
}

// ---- push -------------------------------------------------------------------
async function notify(ids, msg) {
  const subs = db.subsFor(ids);
  await Promise.all(subs.map(async (s) => {
    try { if ((await sendPush(s, msg, VAPID, PUSH_SUBJECT)) === 'gone') db.dropSub(s.endpoint); }
    catch (e) { console.warn('push failed:', e.message); }
  }));
  return subs.length;
}
const others = (me, ids = userIds()) => ids.filter((id) => id !== me);
const bookingUrl = (id) => `/#/b/${id}`;
const RSVP_ACTIONS = [{ action: 'in', title: "✅ I'm in" }, { action: 'out', title: "❌ Can't make it" }];

// ---- bookings ---------------------------------------------------------------
function cancelReminderAt(b) { return b.cancelAt - REMIND_HOURS * HOUR; }
function eveAt(b) { const p = laParts(b.teeAt - 24 * HOUR); return laTime(p.y, p.mo, p.d, 18, 0); }

function readBooking(body, prev) {
  const course = str(body.course, 80);
  if (!course) return { err: 'Which course?' };
  const teeAt = Number(body.teeAt);
  if (!Number.isFinite(teeAt) || teeAt < Date.UTC(2020, 0, 1)) return { err: 'Pick the date and tee time' };
  const players = Math.floor(Number(body.players));
  if (!(players >= 1 && players <= 8)) return { err: 'Players must be 1 to 8' };
  const holes = Number(body.holes) === 9 ? 9 : 18;
  const bookerId = Number(body.bookerId);
  if (!db.userById(bookerId)) return { err: 'Who booked it?' };
  const total = body.total === '' || body.total == null ? 0 : toCents(body.total);
  const deposit = body.deposit === '' || body.deposit == null ? 0 : toCents(body.deposit);
  if (!(total >= 0) || !(deposit >= 0) || total > 1e7 || deposit > 1e7) return { err: 'Amounts must be zero or more' };
  const cancelHours = Number(body.cancelHours);
  if (!(cancelHours >= 0 && cancelHours <= 336)) return { err: 'Cancellation window must be 0 to 336 hours' };
  const known = new Set(userIds());
  let roster = Array.isArray(body.roster) ? [...new Set(body.roster.map(Number))].filter((id) => known.has(id)) : (prev ? prev.roster.map((r) => r.userId) : [...known]);
  if (!roster.includes(bookerId)) roster.unshift(bookerId);
  return {
    b: { course, address: str(body.address, 200), phone: str(body.phone, 30), teeAt, players, holes, bookerId, confirmation: str(body.confirmation, 60),
      total, deposit, cancelHours, cancelAt: teeAt - cancelHours * HOUR, notes: str(body.notes, 2000), source: str(body.source, 30) || 'Manual' },
    roster,
  };
}

function upsertCourse(b) {
  let c = db.courseByName(b.course);
  if (!c) c = db.saveCourse({ name: b.course, address: b.address, phone: b.phone, cancelHours: b.cancelHours });
  else if ((!c.address && b.address) || (!c.phone && b.phone)) c = db.saveCourse({ ...c, address: c.address || b.address, phone: c.phone || b.phone });
  return c;
}

// The deposit the booker put down is shared by everyone on the booking. It is kept as one
// ledger line that follows the booking: change the deposit or who is playing and it updates.
function syncDeposit(id) {
  const b = db.bookingById(id);
  const cur = db.autoExpense(id, 'deposit');
  const ids = b.roster.map((r) => r.userId);
  if (!b.deposit || !ids.length) { if (cur) db.deleteExpense(cur.id); return; }
  const e = { paidBy: b.bookerId, amount: b.deposit, category: 'Deposit', description: `${b.course} · ${fmtWhen(b.teeAt)}`, split: evenSplit(b.deposit, ids) };
  if (cur) db.updateExpense(cur.id, e);
  else db.addExpense({ ...e, ts: b.created, bookingId: id, auto: 'deposit', createdBy: b.createdBy });
}

function bookingLine(b) {
  return `${fmtWhen(b.teeAt)} · ${b.players} player${b.players === 1 ? '' : 's'} · booked by ${firstName(b.bookerId)}`;
}

function createBooking(body, me) {
  const r = readBooking(body);
  if (r.err) return r;
  const c = upsertCourse(r.b);
  const now = Date.now();
  const b = { ...r.b, courseId: c.id, address: r.b.address || c.address, createdBy: me.id };
  b.cancelReminded = now >= cancelReminderAt(b); // the "new booking" alert already carries the deadline
  const id = db.insertBooking(b);
  if (now >= eveAt(b)) db.markReminded(id, 'eve');
  db.setRoster(id, r.roster);
  db.setRsvp(id, me.id, 'in');
  syncDeposit(id);
  const saved = db.bookingById(id);
  const free = saved.cancelAt > now ? `\nFree cancel until ${fmtWhen(saved.cancelAt)}` : '';
  notify(others(me.id, r.roster), { title: `⛳ New tee time: ${saved.course}`, body: bookingLine(saved) + free, url: bookingUrl(id), tag: `b${id}`, bookingId: id, actions: RSVP_ACTIONS });
  return { booking: saved };
}

function updateBooking(id, body, me) {
  const prev = db.bookingById(id);
  if (!prev) return { err: 'That tee time no longer exists', code: 404 };
  const r = readBooking(body, prev);
  if (r.err) return r;
  const c = upsertCourse(r.b);
  const b = { ...r.b, courseId: c.id, address: r.b.address || c.address };
  const now = Date.now();
  const moved = b.teeAt !== prev.teeAt || b.cancelAt !== prev.cancelAt;
  const old = db.remindersDue().find((x) => x.id === id) || { cancelReminded: true, eveReminded: true };
  b.cancelReminded = moved ? now >= cancelReminderAt(b) : old.cancelReminded;
  b.eveReminded = moved ? now >= eveAt(b) : old.eveReminded;
  db.updateBooking(id, b);
  db.setRoster(id, r.roster);
  syncDeposit(id);
  const saved = db.bookingById(id);
  if (moved || b.course !== prev.course) {
    notify(others(me.id, r.roster), { title: `✏️ Tee time changed: ${saved.course}`, body: `${firstName(me.id)} updated it: ${bookingLine(saved)}`, url: bookingUrl(id), tag: `b${id}` });
  }
  return { booking: saved };
}

// ---- reminders (checked every minute) ---------------------------------------
async function reminderTick(now = Date.now()) {
  for (const b of db.remindersDue()) {
    const roster = db.roster(b.id);
    const going = roster.filter((r) => r.rsvp !== 'out').map((r) => r.userId);
    if (!b.cancelReminded && now >= cancelReminderAt(b)) {
      db.markReminded(b.id, 'cancel');
      if (now < b.cancelAt) {
        const hrs = Math.max(1, Math.round((b.cancelAt - now) / HOUR));
        await notify(going, { title: `⏰ Last call to cancel: ${b.course}`, body: `Tee time ${fmtWhen(b.teeAt)}. Free cancellation ends ${fmtWhen(b.cancelAt)} (about ${hrs}h). Still in?`,
          url: bookingUrl(b.id), tag: `b${b.id}`, bookingId: b.id, actions: RSVP_ACTIONS, requireInteraction: true });
      }
    }
    if (!b.eveReminded && now >= eveAt(b)) {
      db.markReminded(b.id, 'eve');
      if (now < b.teeAt) await notify(going, { title: `🏌️ Tomorrow: ${b.course}`, body: `${fmtWhen(b.teeAt)}. Tap for the details and directions.`, url: bookingUrl(b.id), tag: `b${b.id}` });
    }
  }
}

// ---- expenses and settling up ----------------------------------------------
const CATEGORIES = ['Green fees', 'Deposit', 'Cart', 'Food & drinks', 'Pro shop', 'Range', 'Other'];
function readExpense(body) {
  const amount = toCents(body.amount);
  if (!(amount > 0 && amount <= 1e7)) return { err: 'Enter an amount' };
  const paidBy = Number(body.paidBy);
  if (!db.userById(paidBy)) return { err: 'Who paid?' };
  const category = CATEGORIES.includes(body.category) ? body.category : 'Other';
  const known = new Set(userIds());
  const sp = body.split || {};
  let split;
  if (sp.mode === 'custom') {
    split = {};
    for (const [k, v] of Object.entries(sp.shares || {})) { const c = toCents(v); if (c > 0 && known.has(Number(k))) split[Number(k)] = c; }
    const sum = Object.values(split).reduce((a, c) => a + c, 0);
    if (sum !== amount) return { err: `The shares add up to ${money(sum)}, not ${money(amount)}` };
  } else if (sp.mode === 'full') {
    const id = Number(sp.id);
    if (!known.has(id)) return { err: 'Who is it for?' };
    split = { [id]: amount };
  } else {
    const ids = [...new Set((sp.ids || []).map(Number))].filter((id) => known.has(id));
    if (!ids.length) return { err: 'Pick who it was for' };
    split = evenSplit(amount, ids);
  }
  const bookingId = body.bookingId ? Number(body.bookingId) : null;
  if (bookingId && !db.bookingById(bookingId)) return { err: 'That tee time no longer exists' };
  return { e: { amount, paidBy, category, description: str(body.description, 120), split, bookingId } };
}

// ---- scorecards -------------------------------------------------------------
function coursePars(courseId, holes, startHole) {
  const c = courseId && db.courseById(courseId);
  const all = c && Array.isArray(c.pars) && c.pars.length === 18 ? c.pars : null;
  const from = startHole === 10 ? 9 : 0;
  return Array.from({ length: holes }, (_, i) => (all ? all[from + i] : 4));
}
function okStrokes(a, holes) { return Array.isArray(a) && a.length <= holes && a.every((x) => x == null || (Number.isInteger(x) && x >= 1 && x <= 20)); }

// ---- the API ------------------------------------------------------------------
function state(me) {
  const balances = db.balances();
  return {
    me: db.pubUser(me), users: db.users(), courses: db.courses(),
    bookings: db.bookings(Date.now() - 180 * 24 * HOUR), expenses: db.expenses(), settlements: db.settlements(),
    balances, transfers: transfers(balances), rounds: db.rounds(), categories: CATEGORIES,
    push: { key: VAPID.publicKey, mine: db.subCount(me.id) }, remindHours: REMIND_HOURS,
    invite: me.is_admin ? INVITE : undefined,
  };
}

async function api(req, res, url, me) {
  const p = url.pathname, m = req.method;
  const seg = p.split('/').filter(Boolean); // ['api', thing, id, action]
  const id = Number(seg[2]);
  const body = m === 'GET' || m === 'DELETE' ? {} : await readJson(req);
  const bad = (msg, code = 400) => send(res, code, { error: msg });

  if (p === '/api/state' && m === 'GET') return send(res, 200, state(me));

  if (p === '/api/me' && m === 'POST') {
    const name = str(body.name, 30) || me.username;
    const venmo = str(body.venmo, 40).replace(/^@/, '');
    if (venmo && !/^[A-Za-z0-9_-]{2,40}$/.test(venmo)) return bad('Venmo usernames are letters, numbers, - and _');
    db.setProfile(me.id, name, venmo);
    if (body.newPassword) {
      if (!db.checkPassword(String(body.password || ''), me.pass)) return bad('Current password is wrong');
      if (String(body.newPassword).length < 6) return bad('New password needs at least 6 characters');
      db.setPassword(me.id, String(body.newPassword));
    }
    return send(res, 200, { ok: true });
  }

  if (p === '/api/parse' && m === 'POST') {
    const r = parseConfirmation(str(body.text, 100000), db.courses());
    if (r.course) {
      const c = db.courseByName(r.course) || db.courseByName(r.course.replace(/\s*\(.*\)\s*$/, ''));
      if (c) { r.address = r.address || c.address; if (r.cancelHours == null) r.cancelHours = c.cancelHours; }
    }
    if (r.booker) {
      const first = r.booker.toLowerCase().split(/\s+/)[0];
      const u = db.users().find((x) => x.name.toLowerCase() === r.booker.toLowerCase() || x.name.toLowerCase().split(/\s+/)[0] === first || x.username.toLowerCase() === first);
      if (u) r.bookerId = u.id;
    }
    return send(res, 200, r);
  }

  if (seg[1] === 'bookings') {
    if (p === '/api/bookings' && m === 'POST') { const r = createBooking(body, me); return r.err ? bad(r.err) : send(res, 200, r); }
    const b = db.bookingById(id);
    if (!b) return bad('That tee time no longer exists', 404);
    if (m === 'PUT' && seg.length === 3) { const r = updateBooking(id, body, me); return r.err ? bad(r.err, r.code) : send(res, 200, r); }
    if (m === 'POST' && seg[3] === 'rsvp') {
      const rsvp = body.rsvp === 'out' ? 'out' : 'in';
      const prev = b.roster.find((r) => r.userId === me.id)?.rsvp;
      db.setRsvp(id, me.id, rsvp);
      if (prev !== rsvp) {
        notify(others(me.id, b.roster.map((r) => r.userId)), { title: rsvp === 'in' ? `✅ ${firstName(me.id)} is in` : `❌ ${firstName(me.id)} can't make it`,
          body: `${b.course} · ${fmtWhen(b.teeAt)}${rsvp === 'out' && Date.now() < b.cancelAt ? `\nFree cancel until ${fmtWhen(b.cancelAt)}` : ''}`, url: bookingUrl(id), tag: `b${id}` });
      }
      return send(res, 200, { booking: db.bookingById(id) });
    }
    if (m === 'POST' && (seg[3] === 'cancel' || seg[3] === 'restore')) {
      const cancel = seg[3] === 'cancel';
      db.setBookingStatus(id, cancel ? 'cancelled' : 'active');
      notify(others(me.id, b.roster.map((r) => r.userId)), { title: cancel ? `🚫 Cancelled: ${b.course}` : `↩️ Back on: ${b.course}`, body: `${firstName(me.id)} ${cancel ? 'cancelled' : 'restored'} ${fmtWhen(b.teeAt)}`, url: bookingUrl(id), tag: `b${id}` });
      return send(res, 200, { booking: db.bookingById(id) });
    }
    if (m === 'DELETE' && seg.length === 3) {
      if (b.createdBy !== me.id && !me.is_admin) return bad('Only whoever added it can delete it', 403);
      const dep = db.autoExpense(id, 'deposit');
      if (dep) db.deleteExpense(dep.id);
      db.raw.prepare('DELETE FROM booking_players WHERE booking_id=?').run(id);
      db.raw.prepare('DELETE FROM bookings WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  if (seg[1] === 'expenses') {
    if (m === 'POST' && seg.length === 2) {
      const r = readExpense(body);
      if (r.err) return bad(r.err);
      const eid = db.addExpense({ ...r.e, createdBy: me.id });
      const b = r.e.bookingId && db.bookingById(r.e.bookingId);
      const where = b ? ` at ${b.course}` : '';
      for (const [uid, share] of Object.entries(r.e.split)) {
        const u = Number(uid);
        if (u === me.id) continue;
        const owes = u !== r.e.paidBy ? ` · your share ${money(share)}` : '';
        notify([u], { title: `💵 ${firstName(me.id)} added ${r.e.category}${where}`, body: `${money(r.e.amount)} paid by ${firstName(r.e.paidBy)}${owes}${r.e.description ? `\n${r.e.description}` : ''}`, url: '/#/ledger', tag: `e${eid}` });
      }
      return send(res, 200, { id: eid });
    }
    const e = db.expenseById(id);
    if (!e) return bad('Already deleted', 404);
    if (e.auto) return bad('This is the booking deposit. Change it on the tee time instead.');
    if (m === 'PUT') { const r = readExpense(body); if (r.err) return bad(r.err); db.updateExpense(id, r.e); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') {
      if (![e.createdBy, e.paidBy].includes(me.id) && !me.is_admin) return bad('Only whoever added it can delete it', 403);
      db.deleteExpense(id); return send(res, 200, { ok: true });
    }
  }

  if (seg[1] === 'settlements') {
    if (m === 'POST' && seg.length === 2) {
      const fromId = Number(body.fromId || me.id), toId = Number(body.toId), amount = toCents(body.amount);
      if (!db.userById(fromId) || !db.userById(toId) || fromId === toId) return bad('Pick who paid whom');
      if (fromId !== me.id && toId !== me.id && !me.is_admin) return bad('You can only record payments you sent or received', 403);
      if (!(amount > 0 && amount <= 1e7)) return bad('Enter an amount');
      const method = ['venmo', 'cash', 'zelle', 'other'].includes(body.method) ? body.method : 'venmo';
      const sid = db.addSettlement({ fromId, toId, amount, method, note: str(body.note, 120), createdBy: me.id });
      const other = fromId === me.id ? toId : fromId;
      notify([other], { title: `🤝 ${money(amount)} settled`, body: `${firstName(me.id)} recorded ${firstName(fromId)} → ${firstName(toId)} by ${method === 'venmo' ? 'Venmo' : method}`, url: '/#/ledger', tag: `s${sid}` });
      return send(res, 200, { id: sid });
    }
    const s = db.settlementById(id);
    if (!s) return bad('Already deleted', 404);
    if (m === 'DELETE') {
      if (![s.createdBy, s.fromId, s.toId].includes(me.id) && !me.is_admin) return bad('Not yours to undo', 403);
      db.deleteSettlement(id); return send(res, 200, { ok: true });
    }
  }

  if (seg[1] === 'courses') {
    const name = str(body.name, 80);
    if (!name) return bad('Course name?');
    const cancelHours = Number(body.cancelHours ?? 24);
    if (!(cancelHours >= 0 && cancelHours <= 336)) return bad('Cancellation window must be 0 to 336 hours');
    let pars = null;
    if (Array.isArray(body.pars) && body.pars.length) {
      if (body.pars.length !== 18 || !body.pars.every((x) => [3, 4, 5, 6].includes(Number(x)))) return bad('Pars must be 18 holes of 3, 4, 5 or 6');
      pars = body.pars.map(Number);
    }
    const c = { name, address: str(body.address, 200), phone: str(body.phone, 30), cancelHours, bookUrl: str(body.bookUrl, 300), pars, notes: str(body.notes, 1000) };
    if (body.bookUrl && !/^https?:\/\//i.test(c.bookUrl)) return bad('Booking link should start with https://');
    try {
      if (m === 'POST' && seg.length === 2) return send(res, 200, { course: db.saveCourse(c) });
      if (m === 'PUT' && db.courseById(id)) return send(res, 200, { course: db.saveCourse({ ...c, id }) });
    } catch { return bad('There is already a course with that name'); }
  }

  if (seg[1] === 'rounds') {
    if (m === 'POST' && seg.length === 2) {
      const b = body.bookingId ? db.bookingById(Number(body.bookingId)) : null;
      const course = str(body.course, 80) || b?.course;
      if (!course) return bad('Which course?');
      const c = db.courseByName(course) || db.courseById(b?.courseId);
      const holes = Number(body.holes) === 9 ? 9 : 18;
      const startHole = holes === 9 && Number(body.startHole) === 10 ? 10 : 1;
      const known = new Set(userIds());
      const players = [...new Set((body.players || []).map(Number))].filter((x) => known.has(x));
      if (!players.length) return bad('Who is playing?');
      const rid = db.addRound({ bookingId: b?.id, courseId: c?.id, course: c?.name || course, playedOn: Number(body.playedOn) || b?.teeAt || Date.now(), holes, startHole,
        pars: coursePars(c?.id, holes, startHole), createdBy: me.id });
      for (const u of players) db.setScores(rid, u, []);
      return send(res, 200, { round: db.roundById(rid) });
    }
    const r = db.roundById(id);
    if (!r) return bad('That scorecard no longer exists', 404);
    if (m === 'PUT') {
      if (body.pars) {
        if (!Array.isArray(body.pars) || body.pars.length !== r.holes || !body.pars.every((x) => [3, 4, 5, 6].includes(Number(x)))) return bad('Pars must be 3 to 6');
        const pars = body.pars.map(Number);
        db.setRoundPars(id, pars);
        // Remember the pars on the course so the next card there starts right.
        const c = r.courseId && db.courseById(r.courseId);
        if (c) {
          const all = Array.isArray(c.pars) && c.pars.length === 18 ? [...c.pars] : Array(18).fill(4);
          pars.forEach((x, i) => { all[(r.startHole === 10 ? 9 : 0) + i] = x; });
          db.saveCourse({ ...c, pars: all });
        }
      }
      for (const [uid, strokes] of Object.entries(body.scores || {})) {
        const u = Number(uid);
        if (!r.scores.some((s) => s.userId === u) && !db.userById(u)) continue;
        if (!okStrokes(strokes, r.holes)) return bad('Scores must be whole numbers 1 to 20');
        db.setScores(id, u, strokes);
      }
      return send(res, 200, { round: db.roundById(id) });
    }
    if (m === 'DELETE') { db.deleteRound(id); return send(res, 200, { ok: true }); }
  }

  if (seg[1] === 'push') {
    if (seg[2] === 'subscribe' && m === 'POST') {
      const s = body.subscription || {};
      if (!/^https:\/\//.test(s.endpoint || '') || !s.keys?.p256dh || !s.keys?.auth) return bad('That subscription looks incomplete');
      db.addSub(me.id, { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });
      return send(res, 200, { ok: true });
    }
    if (seg[2] === 'unsubscribe' && m === 'POST') { if (body.endpoint) db.dropSub(String(body.endpoint)); return send(res, 200, { ok: true }); }
    if (seg[2] === 'test' && m === 'POST') {
      const n = await notify([me.id], { title: '⛳ GolfBuddy notifications work', body: "You'll get new tee times, cancellation reminders and ledger updates here.", url: '/' });
      return send(res, 200, { sent: n });
    }
  }

  if (seg[1] === 'admin' && me.is_admin) {
    if (seg[2] === 'password' && m === 'POST') {
      const u = db.userById(Number(body.userId));
      if (!u || String(body.password || '').length < 6) return bad('Pick a person and a password of 6+ characters');
      db.setPassword(u.id, String(body.password)); db.dropUserSessions(u.id);
      return send(res, 200, { ok: true });
    }
  }
  return bad('Not found', 404);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/healthz') return send(res, 200, { ok: true });

  if (p.startsWith('/api/')) {
    // Every write is JSON (a form on another site cannot send JSON without the browser asking first);
    // DELETE carries no body, and a plain form cannot send one.
    if ((req.method === 'POST' || req.method === 'PUT') && !String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'JSON only' });
    try {
      if (p === '/api/register' && req.method === 'POST') {
        if (limited(req)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
        const b = await readJson(req);
        const username = str(b.username, 24);
        if (!/^[A-Za-z0-9_.-]{2,24}$/.test(username)) return send(res, 400, { error: 'Username: 2 to 24 letters or numbers' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Password needs at least 6 characters' });
        if (String(b.invite || '').trim() !== INVITE) return send(res, 403, { error: 'Wrong invite code' });
        if (db.userByName(username)) return send(res, 409, { error: 'That username is taken' });
        const u = db.createUser(username, String(b.password), str(b.name, 30) || username, db.userCount() === 0);
        return send(res, 200, { me: db.pubUser(u) }, { 'Set-Cookie': sessionCookie(req, db.createSession(u.id)) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (limited(req)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
        const b = await readJson(req);
        const u = db.userByName(str(b.username, 24));
        if (!u || !db.checkPassword(String(b.password || ''), u.pass)) return send(res, 401, { error: 'Wrong username or password' });
        return send(res, 200, { me: db.pubUser(u) }, { 'Set-Cookie': sessionCookie(req, db.createSession(u.id)) });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        db.dropSession(cookies(req).sid);
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      }
      const me = db.sessionUser(cookies(req).sid);
      if (!me) return send(res, 401, { error: 'Log in first', needInvite: true });
      return await api(req, res, url, me);
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: 'Something went wrong on the server' });
    }
  }

  // Static files; every other address is the app itself (it reads the rest of the URL).
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache' };
  if (file.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'Server error' }); } catch { /* already sent */ } }));
if (require.main === module) {
  server.listen(PORT, () => console.log(`GolfBuddy on http://localhost:${PORT}`));
  setInterval(() => reminderTick().catch((e) => console.error('reminders:', e)), 60000);
  setTimeout(() => reminderTick().catch(() => {}), 5000);
}

module.exports = { server, reminderTick, transfers, evenSplit, eveAt };
