'use strict';
// GolfHomie: shared tee times, who-owes-who, scorecards. Plain Node HTTP server, no packages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { parseConfirmation, laTime, laParts, fmtWhen } = require('./parse');
const { vapidKeys, sendPush } = require('./push');
const svc = require('./services');
const { brief, wakeOn } = require('./brief');
const { wakeTick, e164, twilioReady, placeCall } = require('./wake');
const track = require('./track');
const rates = require('./rates');
const { readEmail } = require('./mail');
const { placeOf } = require('./brief');

const PORT = Number(process.env.PORT || 8790);
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const HOUR = 3600000;
// How long before the free-cancellation deadline the "still in?" reminder goes out.
const REMIND_HOURS = Number(process.env.REMIND_HOURS || 12);
const VAPID = vapidKeys(db);
const PUSH_SUBJECT = process.env.PUBLIC_URL && /^https:\/\//.test(process.env.PUBLIC_URL) ? process.env.PUBLIC_URL : 'mailto:golfhomie@juno.nexus';

if (!db.getSetting('inbound_key')) db.setSetting('inbound_key', crypto.randomBytes(24).toString('hex'));
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
const RSVP_ACTIONS = [{ action: 'in', title: "✅ I'm in" }, { action: 'out', title: "❌ I'm out" }];

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
  const ride = ['walk', 'push', 'cart'].includes(body.ride) ? body.ride : prev?.ride || 'walk';
  let balanceBy = body.balanceBy === undefined ? prev?.balanceBy ?? null : body.balanceBy ? Number(body.balanceBy) : null;
  if (balanceBy && !known.has(balanceBy)) balanceBy = null;
  return {
    b: { course, address: str(body.address, 200), phone: str(body.phone, 30), teeAt, players, holes, bookerId, confirmation: str(body.confirmation, 60),
      total, deposit, cancelHours, cancelAt: teeAt - cancelHours * HOUR, notes: str(body.notes, 2000), source: str(body.source, 30) || 'Manual' },
    roster, ride, balanceBy,
    // An empty total on an L.A. City course is filled in from the published rates (and kept up to date).
    autoPrice: body.total === '' || body.total == null || !!body.autoPrice,
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

// What's left after the deposit, paid at the course by one person and shared by everyone on the
// booking. Like the deposit, it's one ledger line that follows the booking's total and roster.
function syncBalance(id) {
  const b = db.bookingById(id);
  const cur = db.autoExpense(id, 'balance');
  const ids = b.roster.map((r) => r.userId);
  const amount = Math.max(0, b.total - b.deposit);
  if (!b.balanceBy || !amount || !ids.length || b.status === 'cancelled') { if (cur) db.deleteExpense(cur.id); return; }
  const e = { paidBy: b.balanceBy, amount, category: 'Green fees', description: `${b.course} · paid at the course${b.deposit ? ' (after the deposit)' : ''}`, split: evenSplit(amount, ids) };
  if (cur) db.updateExpense(cur.id, e);
  else db.addExpense({ ...e, ts: Date.now(), bookingId: id, auto: 'balance', createdBy: b.balanceBy });
}
// Each person's Player Card (for twilight pricing), keyed by id.
const cardMap = () => Object.fromEntries(db.users().map((u) => [u.id, u.card]));
// Fill in an L.A. City booking's total from the published rates, if it's set to automatic.
function syncPrice(id) {
  const b = db.bookingById(id);
  const raw = db.raw.prepare('SELECT price_auto FROM bookings WHERE id=?').get(id);
  if (!raw?.price_auto) return;
  const q = rates.quoteBooking(b, cardMap());
  if (q && !q.unavailable && q.total !== b.total) db.setPrice(id, q.total, true);
}
function afterSave(id, r) {
  db.raw.prepare('UPDATE bookings SET ride=?, balance_by=? WHERE id=?').run(r.ride, r.balanceBy || null, id);
  const b = db.bookingById(id);
  if (r.autoPrice && rates.isLaCity(b.course)) db.setPrice(id, b.total, true);
  else if (!r.autoPrice) db.setPrice(id, b.total, false);
  syncPrice(id);
  syncDeposit(id);
  syncBalance(id);
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
  afterSave(id, r);
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
  afterSave(id, r);
  const saved = db.bookingById(id);
  if (moved || b.course !== prev.course) {
    notify(others(me.id, r.roster), { title: `✏️ Tee time changed: ${saved.course}`, body: `${firstName(me.id)} updated it: ${bookingLine(saved)}`, url: bookingUrl(id), tag: `b${id}` });
  }
  return { booking: saved };
}

// ---- reminders (checked every minute) ---------------------------------------
// ---- weather -------------------------------------------------------------------
// Rain or wind worth a heads-up, and when it has cleared again.
const WX_BAD = { pop: 40, wind: 20 };
const WX_GOOD = { pop: 25, wind: 15 };
async function forecast(b) {
  try {
    const place = await placeOf(db.courseById(b.courseId), b);
    if (place?.lat == null) return null;
    const w = await svc.weatherFor(place.lat, place.lon, b.teeAt, b.holes === 9 ? 2.25 : 4.5);
    return w?.at ? w : null;
  } catch { return null; }
}
function wxLine(w) {
  if (!w) return '';
  const pop = w.popMax ?? w.at.pop ?? 0, wind = w.windMax ?? w.at.wind ?? 0;
  return `${w.at.temp}°, ${w.at.sky.toLowerCase()}${pop >= 20 ? `, ${pop}% chance of rain` : ''}${wind >= 12 ? `, wind to ${wind} mph` : ''}`;
}
const wxLevel = (w) => {
  const pop = w.popMax ?? w.at.pop ?? 0, wind = w.windMax ?? w.at.wind ?? 0;
  return pop >= WX_BAD.pop || wind >= WX_BAD.wind ? 'bad' : pop < WX_GOOD.pop && wind < WX_GOOD.wind ? 'good' : 'meh';
};
// Every half hour: for tee times in the next 5 days, alert once when the forecast turns bad,
// and once more if it clears up again afterwards.
async function weatherTick(now = Date.now(), getWx = forecast) {
  for (const b of db.upcoming(now + HOUR, now + 5 * 24 * HOUR)) {
    const w = await getWx(b);
    if (!w) continue;
    const level = wxLevel(w), prev = db.wxState(b.id) || {};
    const going = b.roster.filter((r) => r.rsvp !== 'out').map((r) => r.userId);
    const pop = w.popMax ?? w.at.pop ?? 0, wind = w.windMax ?? w.at.wind ?? 0;
    const free = now < b.cancelAt ? ` Free cancel until ${fmtWhen(b.cancelAt)}.` : '';
    if (level === 'bad' && prev.level !== 'bad') {
      db.setWxState(b.id, { level, at: now, pop, wind });
      await notify(going, { title: `${pop >= WX_BAD.pop ? '🌧️ Rain' : '💨 Wind'} in the forecast: ${b.course}`, body: `${fmtWhen(b.teeAt)}: ${wxLine(w)}.${free}`,
        url: bookingUrl(b.id), tag: `wx${b.id}`, bookingId: b.id, actions: now < b.cancelAt ? RSVP_ACTIONS : undefined });
    } else if (level === 'good' && prev.level === 'bad') {
      db.setWxState(b.id, { level, at: now, pop, wind });
      await notify(going, { title: `☀️ Forecast cleared: ${b.course}`, body: `${fmtWhen(b.teeAt)}: now ${wxLine(w)}.`, url: bookingUrl(b.id), tag: `wx${b.id}` });
    } else if (!prev.level) db.setWxState(b.id, { level, at: now, pop, wind });
  }
}

async function reminderTick(now = Date.now(), getWx = forecast) {
  for (const b of db.remindersDue()) {
    const roster = db.roster(b.id);
    const going = roster.filter((r) => r.rsvp !== 'out').map((r) => r.userId);
    if (!b.cancelReminded && now >= cancelReminderAt(b)) {
      db.markReminded(b.id, 'cancel');
      if (now < b.cancelAt) {
        const hrs = Math.max(1, Math.round((b.cancelAt - now) / HOUR));
        const w = wxLine(await getWx(b));
        await notify(going, { title: `⏰ Last call to cancel: ${b.course}`, body: `Tee time ${fmtWhen(b.teeAt)}.${w ? ` Forecast: ${w}.` : ''} Free cancellation ends ${fmtWhen(b.cancelAt)} (about ${hrs}h). Still in?`,
          url: bookingUrl(b.id), tag: `b${b.id}`, bookingId: b.id, actions: RSVP_ACTIONS, requireInteraction: true });
      }
    }
    if (!b.eveReminded && now >= eveAt(b)) {
      db.markReminded(b.id, 'eve');
      const w = wxLine(await getWx(b));
      if (now < b.teeAt) await notify(going, { title: `🏌️ Tomorrow: ${b.course}`, body: `${fmtWhen(b.teeAt)}.${w ? ` ${w[0].toUpperCase()}${w.slice(1)}.` : ''} Tap for the details and directions.`, url: bookingUrl(b.id), tag: `b${b.id}` });
    }
  }
  // Fifteen minutes before tee time: "start your scorecard?", for anyone without a card going yet.
  for (const b of db.teeNudgesDue(now)) {
    db.markTeeNudged(b.id);
    if (now > b.teeAt + 30 * 60000 || db.rounds(500).some((r) => r.bookingId === b.id)) continue;
    const going = b.roster.filter((r) => r.rsvp !== 'out').map((r) => r.userId);
    await notify(going, { title: `⛳ ${fmtWhen(b.teeAt).split(', ').pop()} at ${b.course}`, body: 'Tap to start the scorecard for the group.', url: `/#/b/${b.id}/score`, tag: `t${b.id}` });
  }
  // Player Card renewal: two weeks' notice, once per expiry date.
  for (const u of db.allUsersRaw()) {
    if (!u.card_exp || u.card_reminded === u.card_exp) continue;
    const exp = Date.parse(`${u.card_exp}T12:00:00-08:00`);
    if (Number.isFinite(exp) && now >= exp - 14 * 24 * HOUR) {
      db.markCardReminded(u.id, u.card_exp);
      await notify([u.id], { title: '🪪 Player Card renewal', body: `Your L.A. City Player Card ${now > exp ? 'expired' : 'expires'} ${fmtWhen(exp).split(',').slice(0, 2).join(',')}. Renew with any L.A. City starter ($25 a year).`, url: '/#/me', tag: 'card' });
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
  const fromInfo = c?.info?.holes?.map((h) => h.par);
  if (fromInfo?.length === 9 && holes === 9) return fromInfo;
  const all = c && Array.isArray(c.pars) && c.pars.length === 18 ? c.pars : fromInfo?.length === 18 ? fromInfo : null;
  const from = startHole === 10 ? 9 : 0;
  return Array.from({ length: holes }, (_, i) => (all ? all[from + i] : 4));
}
function okStrokes(a, holes) { return Array.isArray(a) && a.length <= holes && a.every((x) => x == null || (Number.isInteger(x) && x >= 1 && x <= 20)); }

// ---- confirmations (pasted, shared or emailed) ------------------------------------
function readConfirmation(text) {
  const r = parseConfirmation(text, db.courses());
  if (r.course) {
    const c = db.courseByName(r.course) || db.courseByName(r.course.replace(/\s*\(.*\)\s*$/, ''));
    if (c) { r.address = r.address || c.address; if (r.cancelHours == null) r.cancelHours = c.cancelHours; }
  }
  if (r.booker) {
    const first = r.booker.toLowerCase().split(/\s+/)[0];
    const u = db.users().find((x) => x.name.toLowerCase() === r.booker.toLowerCase() || x.name.toLowerCase().split(/\s+/)[0] === first || x.username.toLowerCase() === first);
    if (u) r.bookerId = u.id;
  }
  return r;
}
function inboundLog(entry) {
  const log = JSON.parse(db.getSetting('inbound_log') || '[]');
  log.unshift({ at: Date.now(), ...entry });
  db.setSetting('inbound_log', JSON.stringify(log.slice(0, 15)));
}
// An email forwarded to GolfHomie: a confirmation becomes a tee time, a cancellation cancels one,
// and Gmail's "confirm forwarding" email is shown to the admin so the code can be typed into Gmail.
async function inbound(payload) {
  const mail = readEmail(String(payload.raw || ''));
  const envelope = String(payload.from || '').toLowerCase();
  const users = db.allUsersRaw();
  const sender = users.find((u) => String(u.fwd || '').toLowerCase().split(/[\s,;]+/).filter(Boolean).includes(envelope)) || users.find((u) => u.is_admin) || users[0];
  if (!sender) return { result: 'no accounts yet' };
  if (/forwarding confirmation|confirm.*forward/i.test(mail.subject) || /forwarding-noreply@google\.com/i.test(mail.from)) {
    const code = mail.text.match(/Confirmation code:\s*(\d+)/i)?.[1] || mail.subject.match(/#(\d+)/)?.[1] || null;
    const link = mail.text.match(/https:\/\/mail[^\s]*google\.com\/mail\/[^\s]+/i)?.[0] || null;
    db.setSetting('gmail_confirm', JSON.stringify({ at: Date.now(), code, link, for: mail.subject }));
    await notify(users.filter((u) => u.is_admin).map((u) => u.id), { title: '📬 Gmail forwarding code', body: code ? `Code ${code}: type it into Gmail's forwarding settings.` : 'Open Me › Admin to finish.', url: '/#/me', tag: 'gmail' });
    return { result: 'gmail confirmation', code };
  }
  const r = readConfirmation(`${mail.subject}\n${mail.text}`);
  const same = (b) => (r.confirmation && b.confirmation === r.confirmation) || (r.course && r.teeAt && b.teeAt === r.teeAt && b.course.toLowerCase() === r.course.toLowerCase());
  const existing = db.bookings(Date.now() - 2 * 24 * HOUR).find(same);
  if (/cancel/i.test(mail.subject) || /has been cancel+ed|cancellation confirm/i.test(mail.text.slice(0, 600))) {
    if (!existing) return { result: 'cancellation for a tee time not in the app' };
    if (existing.status !== 'cancelled') {
      db.setBookingStatus(existing.id, 'cancelled'); syncBalance(existing.id);
      await notify(existing.roster.map((x) => x.userId), { title: `🚫 Cancelled: ${existing.course}`, body: `${fmtWhen(existing.teeAt)}. From a cancellation email.`, url: bookingUrl(existing.id), tag: `b${existing.id}` });
    }
    return { result: 'cancelled', bookingId: existing.id };
  }
  if (!r.course || !r.teeAt) {
    await notify([sender.id], { title: '📬 Couldn’t read that email', body: `“${mail.subject.slice(0, 80)}” didn’t look like a tee time. Paste it in the app instead.`, url: '/#/new', tag: 'inbound' });
    return { result: 'not a tee time', missing: r.missing };
  }
  if (existing) return { result: 'already in the app', bookingId: existing.id };
  const out = createBooking({ course: r.course, teeAt: r.teeAt, players: r.players || 2, holes: r.holes || 18, bookerId: r.bookerId || sender.id, total: r.total != null ? r.total / 100 : '',
    deposit: r.deposit != null ? r.deposit / 100 : '', cancelHours: r.cancelHours ?? 24, confirmation: r.confirmation || '', address: r.address || '', notes: r.notes || '', source: `Email · ${r.source || 'confirmation'}` }, sender);
  if (out.err) return { result: `not added: ${out.err}` };
  await notify([sender.id], { title: `📬 Added from email: ${out.booking.course}`, body: `${bookingLine(out.booking)}. Check it over in the app.`, url: bookingUrl(out.booking.id), tag: `b${out.booking.id}` });
  return { result: 'added', bookingId: out.booking.id };
}

// ---- the API ------------------------------------------------------------------
// ---- who can see what: your own tee times, rounds and money, and your Homies -------------------
const onBooking = (b, id) => b.createdBy === id || b.roster.some((r) => r.userId === id);
const onRound = (r, id) => r.createdBy === id || r.scores.some((s) => s.userId === id);
const inExpense = (e, id) => e.paidBy === id || e.createdBy === id || e.split[id] != null;
// What you and each other person owe each other, counted pair by pair (so nobody is ever told to pay
// someone they never played with). Positive = they owe you.
function pairwise(meId) {
  const net = new Map();
  const add = (id, x) => { if (id !== meId) net.set(id, (net.get(id) || 0) + x); };
  for (const e of db.expenses(100000)) {
    if (e.paidBy === meId) for (const [uid, share] of Object.entries(e.split)) add(Number(uid), share);
    else if (e.split[meId] != null) add(e.paidBy, -e.split[meId]);
  }
  for (const s of db.settlements(100000)) { if (s.fromId === meId) add(s.toId, s.amount); else if (s.toId === meId) add(s.fromId, -s.amount); }
  return net;
}
function state(me) {
  const homies = new Set(db.homiesOf(me.id));
  const bookings = db.bookings(Date.now() - 180 * 24 * HOUR).filter((b) => onBooking(b, me.id));
  const rounds = db.rounds().filter((r) => onRound(r, me.id));
  const expenses = db.expenses().filter((e) => inExpense(e, me.id));
  const settlements = db.settlements().filter((s) => [s.fromId, s.toId, s.createdBy].includes(me.id));
  const seen = new Set([me.id, ...homies]);
  for (const b of bookings) b.roster.forEach((r) => seen.add(r.userId));
  for (const r of rounds) r.scores.forEach((s) => seen.add(s.userId));
  for (const e of expenses) { seen.add(e.paidBy); Object.keys(e.split).forEach((k) => seen.add(Number(k))); }
  for (const s of settlements) { seen.add(s.fromId); seen.add(s.toId); }
  const net = pairwise(me.id);
  const owed = [...net].filter(([, x]) => x).map(([id, x]) => (x > 0 ? { fromId: id, toId: me.id, amount: x } : { fromId: me.id, toId: id, amount: -x }));
  // Your total, and each other person's standing with you (for a twosome, the same as their total).
  const balances = [{ userId: me.id, balance: [...net.values()].reduce((a, x) => a + x, 0) }, ...[...net].map(([id, x]) => ({ userId: id, balance: -x }))];
  return {
    me: db.ownProfile(me), users: db.users().filter((u) => seen.has(u.id)).map((u) => ({ ...u, homie: homies.has(u.id) })), courses: db.courses(),
    bookings, expenses, settlements,
    balances, transfers: owed, rounds, categories: CATEGORIES,
    push: { key: VAPID.publicKey, mine: db.subCount(me.id) }, remindHours: REMIND_HOURS,
    invite: me.is_admin ? INVITE : undefined,
    // The browser key is meant to be public (it only works on this site); the server key never leaves the server.
    mapsKey: svc.key('google_browser_key') || null,
    features: { google: !!svc.key('google_server_key'), calls: twilioReady() },
    wakeOn: Object.fromEntries(bookings.filter((b) => b.teeAt > Date.now() - 6 * HOUR).map((b) => [b.id, wakeOn(b)])),
    ...track.stateFor(me),
    // Published-rate price for each L.A. City tee time, so the app can show where a total comes from.
    quotes: Object.fromEntries(bookings.filter((b) => rates.isLaCity(b.course)).map((b) => [b.id, rates.quoteBooking(b, cardMap())])),
  };
}

async function api(req, res, url, me) {
  const p = url.pathname, m = req.method;
  const seg = p.split('/').filter(Boolean); // ['api', thing, id, action]
  const id = Number(seg[2]);
  const big = /^\/api\/shots\/\d+\/photo$/.test(p);
  const body = m === 'GET' || m === 'DELETE' ? {} : await readJson(req, big ? 6e6 : 200000);
  const bad = (msg, code = 400) => send(res, code, { error: msg });

  if (p === '/api/state' && m === 'GET') return send(res, 200, state(me));

  // Tee times and rounds you're not part of don't exist, as far as you're concerned.
  if (seg[1] === 'bookings' && seg[2] && !Number.isNaN(id)) { const b = db.bookingById(id); if (b && !onBooking(b, me.id)) return bad('That tee time no longer exists', 404); }
  if (seg[1] === 'rounds' && seg[2]) { const r = db.roundById(id); if (r && !onRound(r, me.id)) return bad('That scorecard no longer exists', 404); }

  if (seg[1] === 'homies') {
    if (seg[2] === 'code') return send(res, 200, { code: db.homieCode(me.id, m === 'POST' && body.fresh) });
    if (m === 'POST' && seg.length === 2) {
      const u = db.userByHomieCode(body.code);
      if (!u) return bad('That code didn’t match anyone. Ask them to show it again.', 404);
      if (u.id === me.id) return bad('That’s your own code');
      const added = db.link(me.id, u.id);
      if (added) notify([u.id], { title: `🤝 ${firstName(me.id)} is your Homie now`, body: 'You can add each other to tee times and scorecards.', url: '/#/me', tag: `h${me.id}` });
      return send(res, 200, { homie: db.pubUser(u), added });
    }
    if (m === 'DELETE' && seg[2]) { db.unlink(me.id, Number(seg[2])); return send(res, 200, { ok: true }); }
  }

  // Shot tracking, photos, hole layouts and the gear closet (server/track.js).
  if (['shots', 'photos', 'gear'].includes(seg[1]) || (seg[1] === 'rounds' && ['shots', 'gear'].includes(seg[3])) || (seg[1] === 'courses' && seg[3] === 'holes')) {
    const done = await track.handle(req, res, url, me, body, { send, bad });
    if (done !== false) return;
  }

  if (p === '/api/me/theme' && m === 'POST') {
    if (!['augusta', 'ivory', 'onyx'].includes(body.theme)) return bad('Augusta, Ivory or Onyx?');
    db.setTheme(me.id, body.theme); return send(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'POST') {
    const name = str(body.name, 30) || me.username;
    const venmo = str(body.venmo, 40).replace(/^@/, '');
    if (venmo && !/^[A-Za-z0-9_-]{2,40}$/.test(venmo)) return bad('Venmo usernames are letters, numbers, - and _');
    db.setProfile(me.id, name, venmo);
    if ('home' in body || 'phone' in body) {
      // Home address (for "leave by" times) and phone (for wake-up calls): private to this person.
      const home = str(body.home, 200);
      const phone = str(body.phone, 30);
      if (phone && !e164(phone)) return bad('Phone: a US number like (310) 555-0123');
      const arriveMins = Math.round(Number(body.arriveMins ?? 30));
      if (!(arriveMins >= 0 && arriveMins <= 120)) return bad('Arrive between 0 and 120 minutes early');
      let homeLat = me.home_lat, homeLon = me.home_lon;
      if (home !== (me.home || '')) {
        homeLat = homeLon = null;
        if (home) {
          const g = await svc.geocode(home).catch(() => null);
          if (!g) return bad("Couldn't find that address. Try the full street, city and ZIP.");
          homeLat = g.lat; homeLon = g.lon;
        }
      }
      const wakeOk = !!body.wakeOk;
      if (wakeOk && (!phone || homeLat == null)) return bad('Wake-up calls need your phone number and home address');
      db.setTravel(me.id, { phone, home, homeLat, homeLon, arriveMins, wakeOk, tee: str(body.tee, 30) });
    }
    if ('fwd' in body) {
      // The Gmail address(es) this person forwards confirmations from, so emailed tee times are theirs.
      const fwd = str(body.fwd, 200).toLowerCase();
      if (fwd && !fwd.split(/[\s,;]+/).filter(Boolean).every((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e))) return bad('Forwarding address: an email address, or several separated by commas');
      db.raw.prepare('UPDATE users SET fwd=? WHERE id=?').run(fwd || null, me.id);
    }
    if ('hcp' in body) {
      // Handicap Index, for the GHIN posting screen. Blank = none yet. Plus handicaps are entered as negatives.
      const h = body.hcp === '' || body.hcp == null ? null : Number(String(body.hcp).replace('+', '-'));
      if (h != null && !(h >= -10 && h <= 54)) return bad('Handicap Index is between +10 and 54');
      db.setHcp(me.id, h == null ? null : Math.round(h * 10) / 10);
    }
    if ('cardNo' in body || 'card' in body) {
      const cardNo = str(body.cardNo, 24);
      const cardExp = str(body.cardExp, 10);
      if (cardExp && !/^\d{4}-\d{2}-\d{2}$/.test(cardExp)) return bad('Card expiry: pick a date');
      db.setCard(me.id, { card: body.card !== false, cardNo, cardExp });
      for (const b of db.upcoming(Date.now(), Date.now() + 60 * 24 * HOUR)) syncPrice(b.id), syncBalance(b.id);
    }
    if (body.newPassword) {
      if (!db.checkPassword(String(body.password || ''), me.pass)) return bad('Current password is wrong');
      if (String(body.newPassword).length < 6) return bad('New password needs at least 6 characters');
      db.setPassword(me.id, String(body.newPassword));
    }
    return send(res, 200, { ok: true });
  }

  if (p === '/api/parse' && m === 'POST') return send(res, 200, readConfirmation(str(body.text, 100000)));
  if (seg[1] === 'admin' && seg[2] === 'inbound' && me.is_admin) {
    // Bookings by email: the key the Cloudflare email worker sends, and what has arrived lately.
    if (m === 'POST' && body.rotate) db.setSetting('inbound_key', crypto.randomBytes(24).toString('hex'));
    return send(res, 200, { key: db.getSetting('inbound_key'), log: JSON.parse(db.getSetting('inbound_log') || '[]'), gmail: JSON.parse(db.getSetting('gmail_confirm') || 'null') });
  }

  if (seg[1] === 'bookings') {
    if (p === '/api/bookings' && m === 'POST') { const r = createBooking(body, me); return r.err ? bad(r.err) : send(res, 200, r); }
    const b = db.bookingById(id);
    if (!b) return bad('That tee time no longer exists', 404);
    if (m === 'PUT' && seg.length === 3) { const r = updateBooking(id, body, me); return r.err ? bad(r.err, r.code) : send(res, 200, r); }
    if (m === 'GET' && seg[3] === 'brief') return send(res, 200, await brief(b, me));
    if (m === 'POST' && seg[3] === 'ride') {
      if (!['walk', 'push', 'cart'].includes(body.ride)) return bad('Walk, push cart or riding cart?');
      db.setRide(id, body.ride); syncPrice(id); syncBalance(id);
      return send(res, 200, { booking: db.bookingById(id) });
    }
    if (m === 'POST' && seg[3] === 'price') {
      // Use the published rate (auto), or keep a total typed by hand.
      if (body.auto) { if (!rates.isLaCity(b.course)) return bad('Rates are only known for L.A. City courses'); db.setPrice(id, b.total, true); syncPrice(id); }
      else { const t = toCents(body.total); if (!(t >= 0 && t <= 1e7)) return bad('Enter a total'); db.setPrice(id, t, false); }
      syncDeposit(id); syncBalance(id);
      return send(res, 200, { booking: db.bookingById(id) });
    }
    if (m === 'POST' && seg[3] === 'paid') {
      // Who paid what was left at the course. null = not yet.
      const by = body.by ? Number(body.by) : null;
      if (by && !b.roster.some((r) => r.userId === by) && !db.userById(by)) return bad('Who paid?');
      if (by && !(b.total > b.deposit)) return bad('Add the total cost first');
      db.setBalanceBy(id, by); syncBalance(id);
      const saved = db.bookingById(id);
      if (by) notify(others(me.id, b.roster.map((r) => r.userId)), { title: `💵 ${firstName(by)} paid at ${b.course}`, body: `${money(saved.total - saved.deposit)} after the ${money(saved.deposit)} deposit, split ${b.roster.length} ways. ${firstName(me.id)} recorded it.`, url: bookingUrl(id), tag: `p${id}` });
      return send(res, 200, { booking: saved });
    }
    if (m === 'POST' && seg[3] === 'wake') {
      db.setWake(id, body.wake == null ? null : !!body.wake);
      db.setWakeLog(id, {}); // plan again from scratch
      return send(res, 200, { wake: wakeOn(db.bookingById(id)) });
    }
    if (m === 'POST' && seg[3] === 'rsvp') {
      const rsvp = body.rsvp === 'out' ? 'out' : 'in';
      const prev = b.roster.find((r) => r.userId === me.id)?.rsvp;
      db.setRsvp(id, me.id, rsvp);
      if (prev !== rsvp) {
        notify(others(me.id, b.roster.map((r) => r.userId)), { title: rsvp === 'in' ? `✅ ${firstName(me.id)} is in` : `❌ ${firstName(me.id)} is out`,
          body: `${b.course} · ${fmtWhen(b.teeAt)}${rsvp === 'out' && Date.now() < b.cancelAt ? `\nFree cancel until ${fmtWhen(b.cancelAt)}` : ''}`, url: bookingUrl(id), tag: `b${id}` });
      }
      return send(res, 200, { booking: db.bookingById(id) });
    }
    if (m === 'POST' && (seg[3] === 'cancel' || seg[3] === 'restore')) {
      const cancel = seg[3] === 'cancel';
      db.setBookingStatus(id, cancel ? 'cancelled' : 'active');
      syncBalance(id);
      notify(others(me.id, b.roster.map((r) => r.userId)), { title: cancel ? `🚫 Cancelled: ${b.course}` : `↩️ Back on: ${b.course}`, body: `${firstName(me.id)} ${cancel ? 'cancelled' : 'restored'} ${fmtWhen(b.teeAt)}`, url: bookingUrl(id), tag: `b${id}` });
      return send(res, 200, { booking: db.bookingById(id) });
    }
    if (m === 'DELETE' && seg.length === 3) {
      if (b.createdBy !== me.id && !me.is_admin) return bad('Only whoever added it can delete it', 403);
      for (const kind of ['deposit', 'balance']) { const e = db.autoExpense(id, kind); if (e) db.deleteExpense(e.id); }
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
    const c = { name, address: str(body.address, 200), phone: str(body.phone, 30), cancelHours, bookUrl: str(body.bookUrl, 300), pars, notes: str(body.notes, 1000), website: str(body.website, 300) };
    if (body.bookUrl && !/^https?:\/\//i.test(c.bookUrl)) return bad('Booking link should start with https://');
    if (body.website && !/^https?:\/\//i.test(c.website)) return bad('Website should start with https://');
    // Keep the course's map position, unless the address changed (then look it up again).
    const prev = id ? db.courseById(id) : null;
    if (prev && prev.address === c.address) { c.lat = prev.lat; c.lon = prev.lon; }
    else if (c.address) { const g = await svc.geocode(c.address).catch(() => null); if (g) { c.lat = g.lat; c.lon = g.lon; } }
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
    if (m === 'GET') return send(res, 200, { round: r });
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
      const n = await notify([me.id], { title: '⛳ GolfHomie notifications work', body: "You'll get new tee times, cancellation reminders and ledger updates here.", url: '/' });
      return send(res, 200, { sent: n });
    }
  }

  if (p === '/api/quote' && m === 'GET') {
    // Live price while filling in a tee time (L.A. City courses only).
    const qp = url.searchParams;
    const b = { course: qp.get('course'), teeAt: Number(qp.get('teeAt')), holes: Number(qp.get('holes')) === 9 ? 9 : 18, players: Math.min(8, Math.max(1, Number(qp.get('players')) || 2)),
      ride: qp.get('ride'), roster: String(qp.get('roster') || '').split(',').filter(Boolean).map((x) => ({ userId: Number(x) })) };
    if (!Number.isFinite(b.teeAt)) return bad('Pick the date and time');
    return send(res, 200, { quote: rates.quoteBooking(b, cardMap()) });
  }

  if (p === '/api/me/test-call' && m === 'POST') {
    // A short call to your own phone, to check the wake-up calls work.
    if (!twilioReady()) return bad('Add the Twilio details in Me › Admin first');
    const to = e164(me.phone);
    if (!to) return bad('Add your mobile number in Me first');
    if (limited({ headers: { 'cf-connecting-ip': `call:${me.id}` }, socket: {} }, 3, HOUR)) return bad('That’s 3 test calls this hour. Try again later.', 429);
    try {
      const sid = await placeCall(to, `<Response><Pause length="1"/><Say voice="Polly.Joanna">Hi ${String(firstName(me.id)).replace(/[<>&'"]/g, '')}. This is a GolfHomie test call. Your wake-up calls are working. Goodbye.</Say></Response>`);
      return send(res, 200, { ok: true, sid });
    } catch (e) { return bad(e.message, 502); }
  }

  if (p === '/api/practice' && m === 'GET') {
    // Driving ranges and simulators within 30 miles of where you are (or home).
    let near = { lat: Number(url.searchParams.get('lat')), lon: Number(url.searchParams.get('lon')) };
    if (!Number.isFinite(near.lat) || !Number.isFinite(near.lon) || !near.lat) near = me.home_lat != null ? { lat: me.home_lat, lon: me.home_lon } : null;
    if (!near) return bad('Share your location or add your home address in Me');
    if (!svc.key('google_server_key')) return bad('Add the Google key in Me › Admin first');
    try { return send(res, 200, { near, places: await svc.practiceNear(near, 30) }); } catch (e) { return bad(e.message, 502); }
  }

  if (seg[1] === 'admin' && me.is_admin) {
    if (seg[2] === 'keys') {
      // Keys are write-only: the page shows whether each is set and its last 4 characters, never the key.
      if (m === 'POST') {
        for (const k of svc.KEY_NAMES) if (typeof body[k] === 'string') db.setSetting(k, body[k].trim().slice(0, 300));
      }
      const view = Object.fromEntries(svc.KEY_NAMES.map((k) => { const v = svc.key(k); return [k, v ? `…${v.slice(-4)}` : '']; }));
      return send(res, 200, { keys: view });
    }
    if (seg[2] === 'test-google' && m === 'POST') {
      try { const r = await svc.placesText('Rancho Park Golf Course Los Angeles', null, 1, 'places.displayName'); return send(res, 200, { ok: true, found: r[0]?.displayName?.text || null }); }
      catch (e) { return bad(e.message, 502); }
    }
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
        // Either the group invite code, or a Homie's QR code (which links you with them).
        const via = db.userByHomieCode(b.homie);
        if (!via && String(b.invite || '').trim() !== INVITE) return send(res, 403, { error: 'Wrong invite code' });
        if (db.userByName(username)) return send(res, 409, { error: 'That username is taken' });
        const u = db.createUser(username, String(b.password), str(b.name, 30) || username, db.userCount() === 0);
        if (via) db.link(u.id, via.id);
        else for (const a of db.allUsersRaw().filter((x) => x.is_admin && x.id !== u.id)) db.link(u.id, a.id);
        return send(res, 200, { me: db.pubUser(u) }, { 'Set-Cookie': sessionCookie(req, db.createSession(u.id)) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (limited(req)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
        const b = await readJson(req);
        const u = db.userByName(str(b.username, 24));
        if (!u || !db.checkPassword(String(b.password || ''), u.pass)) return send(res, 401, { error: 'Wrong username or password' });
        return send(res, 200, { me: db.pubUser(u) }, { 'Set-Cookie': sessionCookie(req, db.createSession(u.id)) });
      }
      if (p === '/api/inbound' && req.method === 'POST') {
        // From the Cloudflare email worker. Not behind a login (the worker can't sign in), so it
        // needs the shared key, compared in constant time.
        const key = db.getSetting('inbound_key') || '';
        const got = Buffer.from(String(req.headers['x-inbound-key'] || ''));
        if (!key || got.length !== key.length || !crypto.timingSafeEqual(got, Buffer.from(key))) return send(res, 403, { error: 'Wrong key' });
        if (limited(req, 60, HOUR)) return send(res, 429, { error: 'Too many' });
        const payload = await readJson(req, 3e6);
        const out = await inbound(payload);
        inboundLog({ subject: readEmail(String(payload.raw || '')).subject.slice(0, 100), ...out });
        return send(res, 200, out);
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
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : ext === '.png' ? 'public, max-age=86400' : 'no-cache' };
  if (file.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'Server error' }); } catch { /* already sent */ } }));
if (require.main === module) {
  server.listen(PORT, () => console.log(`GolfHomie on http://localhost:${PORT}`));
  setInterval(() => reminderTick().catch((e) => console.error('reminders:', e)), 60000);
  setInterval(() => wakeTick(Date.now(), { notify }).catch((e) => console.error('wake-up calls:', e)), 60000);
  setInterval(() => db.cachePrune(), 6 * HOUR);
  setInterval(() => weatherTick().catch((e) => console.error('weather alerts:', e)), 30 * 60000);
  setTimeout(() => weatherTick().catch(() => {}), 60000);
  setTimeout(() => reminderTick().catch(() => {}), 5000);
}

module.exports = { server, reminderTick, weatherTick, transfers, evenSplit, eveAt, notify, wxLevel };
