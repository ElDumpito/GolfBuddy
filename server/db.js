'use strict';
// SQLite storage (Node's built-in driver, so there is nothing to install or compile).
// Money is stored in cents. Times are stored as milliseconds since 1970 (UTC); the app shows
// them in Los Angeles time.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'golfbuddy.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, pass TEXT, name TEXT, venmo TEXT,
  is_admin INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, address TEXT, phone TEXT,
  cancel_hours INTEGER DEFAULT 24, book_url TEXT, pars TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY, course_id INTEGER, course TEXT, address TEXT, tee_at INTEGER,
  players INTEGER DEFAULT 2, holes INTEGER DEFAULT 18, booker_id INTEGER, confirmation TEXT,
  total INTEGER DEFAULT 0, deposit INTEGER DEFAULT 0, cancel_at INTEGER, notes TEXT, source TEXT,
  status TEXT DEFAULT 'active', created_by INTEGER, created INTEGER, updated INTEGER,
  cancel_reminded INTEGER DEFAULT 0, eve_reminded INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS booking_players (booking_id INTEGER, user_id INTEGER, rsvp TEXT DEFAULT 'in', PRIMARY KEY(booking_id, user_id));
-- One row per thing somebody paid for. split is {"userId": cents, ...} and adds up to amount.
-- auto marks the deposit row a booking keeps up to date by itself.
CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, ts INTEGER, booking_id INTEGER, paid_by INTEGER, amount INTEGER,
  category TEXT, description TEXT, split TEXT, auto TEXT, created_by INTEGER, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS settlements (id INTEGER PRIMARY KEY, ts INTEGER, from_id INTEGER, to_id INTEGER, amount INTEGER,
  method TEXT, note TEXT, created_by INTEGER, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER, p256dh TEXT, auth TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY, booking_id INTEGER, course_id INTEGER, course TEXT, played_on INTEGER,
  holes INTEGER DEFAULT 18, start_hole INTEGER DEFAULT 1, pars TEXT, created_by INTEGER, created INTEGER, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS scores (round_id INTEGER, user_id INTEGER, strokes TEXT, PRIMARY KEY(round_id, user_id));
-- Homies: two people who play together and can see each other (a < b).
CREATE TABLE IF NOT EXISTS homies (a INTEGER, b INTEGER, created INTEGER, PRIMARY KEY(a, b));
-- Answers from outside services (weather, drive times, places), kept until exp.
CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
CREATE INDEX IF NOT EXISTS bookings_tee ON bookings(tee_at);
CREATE INDEX IF NOT EXISTS expenses_booking ON expenses(booking_id);
`);

const q = (sql) => db.prepare(sql);

// Columns added after the first release. SQLite can add a column but not "add if missing",
// so check first; this runs on every start and does nothing once the columns exist.
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumns('courses', [['website', 'TEXT'], ['lat', 'REAL'], ['lon', 'REAL'], ['info', 'TEXT']]);
// home/phone are only used for the drive-time and wake-up call features, and only once the person fills them in.
addColumns('users', [['phone', 'TEXT'], ['home', 'TEXT'], ['home_lat', 'REAL'], ['home_lon', 'REAL'], ['arrive_mins', 'INTEGER DEFAULT 30'],
  ['wake_ok', 'INTEGER DEFAULT 0'], ['tee', 'TEXT'],
  // L.A. City Player Card: whether they have one (it moves twilight pricing an hour earlier), and the
  // card number and renewal date kept for safe keeping (only shown to the card's owner).
  ['card', 'INTEGER DEFAULT 1'], ['card_no', 'TEXT'], ['card_exp', 'TEXT'], ['card_reminded', 'TEXT'],
  ['theme', 'TEXT'], ['hcp', 'REAL'], ['fwd', 'TEXT'], ['homie_code', 'TEXT']]);
// Everyone who used the app before Homies existed already played together: link them all once.
if (!q('SELECT COUNT(*) c FROM homies').get().c) {
  const ids = q('SELECT id FROM users ORDER BY id').all().map((u) => u.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) q('INSERT OR IGNORE INTO homies(a, b, created) VALUES(?,?,?)').run(ids[i], ids[j], Date.now());
}
// wake: NULL = automatic (on for tee times before 8 a.m.), 0 = off, 1 = on. wake_log: what the caller did, per person.
addColumns('bookings', [['wake', 'INTEGER'], ['wake_log', 'TEXT'], ['tee_nudged', 'INTEGER DEFAULT 0'],
  // ride: walk | push | cart. price_auto: the total comes from the course's published rates.
  // balance_by: who paid what was left at the course (total minus deposit). wx: last weather alert sent.
  ['ride', "TEXT DEFAULT 'walk'"], ['price_auto', 'INTEGER DEFAULT 0'], ['balance_by', 'INTEGER'], ['wx', 'TEXT']]);
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Courses the two of you have actually played, so the first bookings already know their address
// and cancellation window. Everything here can be edited in the app.
const SEED_COURSES = [
  ['Rancho Park', '10460 W Pico Blvd, Los Angeles, CA 90064', '(310) 838-7373', 24, 'https://golf.lacity.gov/'],
  ['Griffith Park - Harding', '4730 Crystal Springs Dr, Los Angeles, CA 90027', '(323) 663-2555', 24, 'https://golf.lacity.gov/'],
  ['Griffith Park - Wilson', '4730 Crystal Springs Dr, Los Angeles, CA 90027', '(323) 663-2555', 24, 'https://golf.lacity.gov/'],
  ['Roosevelt', 'Roosevelt Golf Course, Los Angeles, CA', '', 24, 'https://golf.lacity.gov/'],
  ['Los Verdes Golf Course', '7000 W Los Verdes Dr, Rancho Palos Verdes, CA 90275', '(310) 377-7888', 48, ''],
  ['Soule Park Golf Course', '1033 E Ojai Ave, Ojai, CA 93023', '(805) 646-5633', 24, ''],
];
if (!q("SELECT v FROM settings WHERE k='seeded'").get()) {
  const ins = q('INSERT OR IGNORE INTO courses(name, address, phone, cancel_hours, book_url) VALUES(?,?,?,?,?)');
  for (const c of SEED_COURSES) ins.run(...c);
  q("INSERT INTO settings(k,v) VALUES('seeded','1')").run();
}

// Scorecards, tees, coordinates and notes researched for the courses above (server/course-data.json).
// Filled into a course only where it has nothing yet, so anything edited in the app is kept.
const COURSE_DATA = require('./course-data.json');
for (const [name, d] of Object.entries(COURSE_DATA)) {
  const c = q('SELECT * FROM courses WHERE name=?').get(name);
  if (!c || c.info) continue;
  const info = { tees: d.tees, holes: d.holes, notes: d.notes, source: d.source, built: d.built, par: d.par };
  const pars = d.holes.length === 18 ? JSON.stringify(d.holes.map((h) => h.par)) : c.pars;
  const vague = !c.address || !/\d/.test(c.address);
  q('UPDATE courses SET website=?, lat=?, lon=?, info=?, pars=COALESCE(pars, ?), phone=COALESCE(NULLIF(phone, \'\'), ?), address=? WHERE id=?')
    .run(d.website, d.lat, d.lon, JSON.stringify(info), pars, d.phone, vague ? d.address : c.address, c.id);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const pubUser = (u) => u && { id: u.id, username: u.username, name: u.name || u.username, venmo: u.venmo || '', admin: !!u.is_admin, tee: u.tee || '', card: u.card !== 0 };
// The private part of a profile: only ever sent to that person.
const ownProfile = (u) => u && ({ ...pubUser(u), phone: u.phone || '', home: u.home || '', homeSet: u.home_lat != null, arriveMins: u.arrive_mins ?? 30, wakeOk: !!u.wake_ok,
  cardNo: u.card_no || '', cardExp: u.card_exp || '', theme: u.theme || 'augusta', hcp: u.hcp ?? null, fwd: u.fwd || '' });
const bookingRow = (b) => b && ({
  id: b.id, courseId: b.course_id, course: b.course, address: b.address || '', teeAt: b.tee_at, players: b.players, holes: b.holes,
  bookerId: b.booker_id, confirmation: b.confirmation || '', total: b.total, deposit: b.deposit, cancelAt: b.cancel_at,
  notes: b.notes || '', source: b.source || '', status: b.status, createdBy: b.created_by, created: b.created, updated: b.updated,
  wake: b.wake == null ? null : !!b.wake, ride: b.ride || 'walk', priceAuto: !!b.price_auto, balanceBy: b.balance_by || null,
});
const expenseRow = (e) => ({ id: e.id, ts: e.ts, bookingId: e.booking_id, paidBy: e.paid_by, amount: e.amount, category: e.category,
  description: e.description || '', split: json(e.split, {}), auto: e.auto || null, createdBy: e.created_by });
const courseRow = (c) => c && ({ id: c.id, name: c.name, address: c.address || '', phone: c.phone || '', cancelHours: c.cancel_hours,
  bookUrl: c.book_url || '', pars: json(c.pars, null), notes: c.notes || '', website: c.website || '', lat: c.lat, lon: c.lon, info: json(c.info, null) });

const api = {
  raw: db, dataDir: DATA, hashPassword, checkPassword, pubUser, ownProfile,
  cacheGet: (k) => { const r = q('SELECT v, exp FROM cache WHERE k=?').get(k); return r ? { v: json(r.v, null), exp: r.exp } : null; },
  cacheSet: (k, v, exp) => q('INSERT INTO cache(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp').run(k, JSON.stringify(v), exp),
  cachePrune: () => q('DELETE FROM cache WHERE exp < ?').run(Date.now() - 30 * 86400000),
  getSetting: (k) => q('SELECT v FROM settings WHERE k=?').get(k)?.v,
  setSetting: (k, v) => q('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)),

  // ---- people ----
  userCount: () => q('SELECT COUNT(*) c FROM users').get().c,
  userByName: (n) => q('SELECT * FROM users WHERE username=?').get(n),
  userById: (id) => q('SELECT * FROM users WHERE id=?').get(id),
  users: () => q('SELECT * FROM users ORDER BY id').all().map(pubUser),
  createUser(username, pw, name, admin) {
    const r = q('INSERT INTO users(username, pass, name, is_admin, created) VALUES(?,?,?,?,?)').run(username, hashPassword(pw), name || username, admin ? 1 : 0, Date.now());
    return api.userById(Number(r.lastInsertRowid));
  },
  setProfile: (id, name, venmo) => q('UPDATE users SET name=?, venmo=? WHERE id=?').run(name, venmo || null, id),
  setTravel: (id, t) => q('UPDATE users SET phone=?, home=?, home_lat=?, home_lon=?, arrive_mins=?, wake_ok=?, tee=? WHERE id=?')
    .run(t.phone || null, t.home || null, t.homeLat ?? null, t.homeLon ?? null, t.arriveMins, t.wakeOk ? 1 : 0, t.tee || null, id),
  setPassword: (id, pw) => q('UPDATE users SET pass=? WHERE id=?').run(hashPassword(pw), id),
  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions(token, user_id, created) VALUES(?,?,?)').run(token, userId, Date.now());
    return token;
  },
  sessionUser: (t) => (t ? q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t) || null : null),
  dropSession: (t) => q('DELETE FROM sessions WHERE token=?').run(t),
  dropUserSessions: (id) => q('DELETE FROM sessions WHERE user_id=?').run(id),

  // ---- courses ----
  courses: () => q('SELECT * FROM courses ORDER BY name').all().map(courseRow),
  courseById: (id) => courseRow(q('SELECT * FROM courses WHERE id=?').get(id)),
  courseByName: (n) => courseRow(q('SELECT * FROM courses WHERE name=?').get(String(n || '').trim())),
  saveCourse(c) {
    const info = c.info ? JSON.stringify(c.info) : null;
    if (c.id) {
      q('UPDATE courses SET name=?, address=?, phone=?, cancel_hours=?, book_url=?, pars=?, notes=?, website=?, lat=?, lon=?, info=COALESCE(?, info) WHERE id=?')
        .run(c.name, c.address || '', c.phone || '', c.cancelHours, c.bookUrl || '', c.pars ? JSON.stringify(c.pars) : null, c.notes || '', c.website || '', c.lat ?? null, c.lon ?? null, info, c.id);
      return api.courseById(c.id);
    }
    const r = q('INSERT INTO courses(name, address, phone, cancel_hours, book_url, pars, notes, website, lat, lon, info) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(c.name, c.address || '', c.phone || '', c.cancelHours, c.bookUrl || '', c.pars ? JSON.stringify(c.pars) : null, c.notes || '', c.website || '', c.lat ?? null, c.lon ?? null, info);
    return api.courseById(Number(r.lastInsertRowid));
  },

  // ---- bookings ----
  bookingById: (id) => {
    const b = bookingRow(q('SELECT * FROM bookings WHERE id=?').get(id));
    if (b) b.roster = api.roster(b.id);
    return b;
  },
  roster: (bookingId) => q('SELECT user_id userId, rsvp FROM booking_players WHERE booking_id=? ORDER BY user_id').all(bookingId),
  bookings(since) {
    const rows = q('SELECT * FROM bookings WHERE tee_at>=? ORDER BY tee_at').all(since).map(bookingRow);
    const all = q('SELECT booking_id b, user_id userId, rsvp FROM booking_players').all();
    for (const b of rows) b.roster = all.filter((r) => r.b === b.id).map(({ userId, rsvp }) => ({ userId, rsvp }));
    return rows;
  },
  insertBooking(b) {
    const now = Date.now();
    const r = q(`INSERT INTO bookings(course_id, course, address, tee_at, players, holes, booker_id, confirmation, total, deposit, cancel_at, notes, source,
      created_by, created, updated, cancel_reminded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.courseId, b.course, b.address, b.teeAt, b.players, b.holes, b.bookerId, b.confirmation, b.total, b.deposit, b.cancelAt, b.notes, b.source,
        b.createdBy, now, now, b.cancelReminded ? 1 : 0);
    return Number(r.lastInsertRowid);
  },
  updateBooking(id, b) {
    q(`UPDATE bookings SET course_id=?, course=?, address=?, tee_at=?, players=?, holes=?, booker_id=?, confirmation=?, total=?, deposit=?, cancel_at=?,
       notes=?, updated=?, cancel_reminded=?, eve_reminded=? WHERE id=?`)
      .run(b.courseId, b.course, b.address, b.teeAt, b.players, b.holes, b.bookerId, b.confirmation, b.total, b.deposit, b.cancelAt, b.notes, Date.now(),
        b.cancelReminded ? 1 : 0, b.eveReminded ? 1 : 0, id);
  },
  setRide: (id, ride) => q('UPDATE bookings SET ride=?, updated=? WHERE id=?').run(ride, Date.now(), id),
  setPrice: (id, total, auto) => q('UPDATE bookings SET total=?, price_auto=? WHERE id=?').run(total, auto ? 1 : 0, id),
  setBalanceBy: (id, uid) => q('UPDATE bookings SET balance_by=? WHERE id=?').run(uid || null, id),
  wxState: (id) => json(q('SELECT wx FROM bookings WHERE id=?').get(id)?.wx, null),
  setWxState: (id, v) => q('UPDATE bookings SET wx=? WHERE id=?').run(JSON.stringify(v), id),
  // ---- homies ----
  homiesOf: (id) => q('SELECT b x FROM homies WHERE a=? UNION SELECT a x FROM homies WHERE b=?').all(id, id).map((r) => r.x),
  link: (x, y) => { if (x === y) return false; const [a, b] = x < y ? [x, y] : [y, x]; return q('INSERT OR IGNORE INTO homies(a, b, created) VALUES(?,?,?)').run(a, b, Date.now()).changes > 0; },
  unlink: (x, y) => { const [a, b] = x < y ? [x, y] : [y, x]; q('DELETE FROM homies WHERE a=? AND b=?').run(a, b); },
  // The code in someone's QR: random, and can be replaced if it gets passed around.
  homieCode(id, fresh) {
    let c = q('SELECT homie_code FROM users WHERE id=?').get(id)?.homie_code;
    if (!c || fresh) { c = crypto.randomBytes(9).toString('base64url'); q('UPDATE users SET homie_code=? WHERE id=?').run(c, id); }
    return c;
  },
  userByHomieCode: (c) => (c ? q('SELECT * FROM users WHERE homie_code=?').get(String(c)) || null : null),
  setHcp: (id, h) => q('UPDATE users SET hcp=? WHERE id=?').run(h, id),
  teeNudgesDue: (now) => q("SELECT * FROM bookings WHERE status='active' AND tee_nudged=0 AND tee_at BETWEEN ? AND ?").all(now - 3600000, now + 15 * 60000).map((b) => ({ ...bookingRow(b), roster: api.roster(b.id) })),
  markTeeNudged: (id) => q('UPDATE bookings SET tee_nudged=1 WHERE id=?').run(id),
  setTheme: (id, t) => q('UPDATE users SET theme=? WHERE id=?').run(t, id),
  setCard: (id, c) => q('UPDATE users SET card=?, card_no=?, card_exp=? WHERE id=?').run(c.card ? 1 : 0, c.cardNo || null, c.cardExp || null, id),
  markCardReminded: (id, exp) => q('UPDATE users SET card_reminded=? WHERE id=?').run(exp, id),
  allUsersRaw: () => q('SELECT * FROM users').all(),
  setWake: (id, v) => q('UPDATE bookings SET wake=? WHERE id=?').run(v == null ? null : v ? 1 : 0, id),
  wakeLog: (id) => json(q('SELECT wake_log FROM bookings WHERE id=?').get(id)?.wake_log, {}),
  setWakeLog: (id, log) => q('UPDATE bookings SET wake_log=? WHERE id=?').run(JSON.stringify(log), id),
  upcoming: (from, to) => q("SELECT * FROM bookings WHERE status='active' AND tee_at BETWEEN ? AND ?").all(from, to).map((b) => ({ ...bookingRow(b), roster: api.roster(b.id) })),
  setBookingStatus: (id, status) => q('UPDATE bookings SET status=?, updated=? WHERE id=?').run(status, Date.now(), id),
  setRoster(bookingId, userIds) {
    const keep = new Map(api.roster(bookingId).map((r) => [r.userId, r.rsvp]));
    q('DELETE FROM booking_players WHERE booking_id=?').run(bookingId);
    const ins = q('INSERT INTO booking_players(booking_id, user_id, rsvp) VALUES(?,?,?)');
    for (const id of userIds) ins.run(bookingId, id, keep.get(id) || 'in');
  },
  setRsvp: (bookingId, userId, rsvp) => q(`INSERT INTO booking_players(booking_id, user_id, rsvp) VALUES(?,?,?)
    ON CONFLICT(booking_id, user_id) DO UPDATE SET rsvp=excluded.rsvp`).run(bookingId, userId, rsvp),
  remindersDue: () => q("SELECT * FROM bookings WHERE status='active' AND (cancel_reminded=0 OR eve_reminded=0) AND tee_at>?").all(Date.now()).map((b) => ({ ...bookingRow(b), cancelReminded: !!b.cancel_reminded, eveReminded: !!b.eve_reminded })),
  markReminded: (id, which) => q(`UPDATE bookings SET ${which === 'eve' ? 'eve_reminded' : 'cancel_reminded'}=1 WHERE id=?`).run(id),

  // ---- money ----
  expenses: (limit = 300) => q('SELECT * FROM expenses WHERE deleted=0 ORDER BY ts DESC, id DESC LIMIT ?').all(limit).map(expenseRow),
  expenseById: (id) => { const e = q('SELECT * FROM expenses WHERE id=? AND deleted=0').get(id); return e ? expenseRow(e) : null; },
  autoExpense: (bookingId, kind) => { const e = q('SELECT * FROM expenses WHERE booking_id=? AND auto=? AND deleted=0').get(bookingId, kind); return e ? expenseRow(e) : null; },
  addExpense(e) {
    const r = q('INSERT INTO expenses(ts, booking_id, paid_by, amount, category, description, split, auto, created_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(e.ts || Date.now(), e.bookingId || null, e.paidBy, e.amount, e.category, e.description || '', JSON.stringify(e.split), e.auto || null, e.createdBy);
    return Number(r.lastInsertRowid);
  },
  updateExpense: (id, e) => q('UPDATE expenses SET paid_by=?, amount=?, category=?, description=?, split=? WHERE id=?')
    .run(e.paidBy, e.amount, e.category, e.description || '', JSON.stringify(e.split), id),
  deleteExpense: (id) => q('UPDATE expenses SET deleted=1 WHERE id=?').run(id),
  settlements: (limit = 200) => q(`SELECT id, ts, from_id fromId, to_id toId, amount, method, note, created_by createdBy FROM settlements
    WHERE deleted=0 ORDER BY ts DESC, id DESC LIMIT ?`).all(limit),
  settlementById: (id) => q('SELECT id, from_id fromId, to_id toId, amount, created_by createdBy FROM settlements WHERE id=? AND deleted=0').get(id),
  addSettlement: (s) => Number(q('INSERT INTO settlements(ts, from_id, to_id, amount, method, note, created_by) VALUES(?,?,?,?,?,?,?)')
    .run(Date.now(), s.fromId, s.toId, s.amount, s.method || '', s.note || '', s.createdBy).lastInsertRowid),
  deleteSettlement: (id) => q('UPDATE settlements SET deleted=1 WHERE id=?').run(id),
  // Net per person: what they paid for others minus what others paid for them, adjusted by
  // money that has already changed hands. Positive means the group owes them.
  balances() {
    const net = new Map(api.users().map((u) => [u.id, 0]));
    const add = (id, x) => net.set(id, (net.get(id) || 0) + x);
    for (const e of q('SELECT paid_by, amount, split FROM expenses WHERE deleted=0').all()) {
      add(e.paid_by, e.amount);
      for (const [uid, share] of Object.entries(json(e.split, {}))) add(Number(uid), -share);
    }
    for (const s of q('SELECT from_id, to_id, amount FROM settlements WHERE deleted=0').all()) { add(s.from_id, s.amount); add(s.to_id, -s.amount); }
    return [...net].map(([userId, balance]) => ({ userId, balance }));
  },

  // ---- push ----
  addSub: (userId, s) => q(`INSERT INTO push_subs(endpoint, user_id, p256dh, auth, created) VALUES(?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`).run(s.endpoint, userId, s.p256dh, s.auth, Date.now()),
  dropSub: (endpoint) => q('DELETE FROM push_subs WHERE endpoint=?').run(endpoint),
  subsFor: (userIds) => {
    const all = q('SELECT endpoint, user_id userId, p256dh, auth FROM push_subs').all();
    return userIds ? all.filter((s) => userIds.includes(s.userId)) : all;
  },
  subCount: (userId) => q('SELECT COUNT(*) c FROM push_subs WHERE user_id=?').get(userId).c,

  // ---- scorecards ----
  rounds(limit = 60) {
    const rs = q('SELECT * FROM rounds WHERE deleted=0 ORDER BY played_on DESC, id DESC LIMIT ?').all(limit);
    const sc = q('SELECT round_id r, user_id userId, strokes FROM scores').all();
    return rs.map((r) => ({ id: r.id, bookingId: r.booking_id, courseId: r.course_id, course: r.course, playedOn: r.played_on, holes: r.holes,
      startHole: r.start_hole, pars: json(r.pars, []), createdBy: r.created_by,
      scores: sc.filter((s) => s.r === r.id).map((s) => ({ userId: s.userId, strokes: json(s.strokes, []) })) }));
  },
  roundById: (id) => api.rounds(100000).find((r) => r.id === id) || null,
  addRound: (r) => Number(q('INSERT INTO rounds(booking_id, course_id, course, played_on, holes, start_hole, pars, created_by, created) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(r.bookingId || null, r.courseId || null, r.course, r.playedOn, r.holes, r.startHole, JSON.stringify(r.pars), r.createdBy, Date.now()).lastInsertRowid),
  setRoundPars: (id, pars) => q('UPDATE rounds SET pars=? WHERE id=?').run(JSON.stringify(pars), id),
  setScores: (roundId, userId, strokes) => q(`INSERT INTO scores(round_id, user_id, strokes) VALUES(?,?,?)
    ON CONFLICT(round_id, user_id) DO UPDATE SET strokes=excluded.strokes`).run(roundId, userId, JSON.stringify(strokes)),
  deleteRound: (id) => q('UPDATE rounds SET deleted=1 WHERE id=?').run(id),
};

module.exports = api;
