'use strict';
// What a round costs at the L.A. City courses, from the City's published green fees
// (golf.lacity.gov/rates, checked Nov 25 2026) and its twilight schedule (golf.lacity.gov/?p=261).
//
// Rules, as the City publishes them:
// - Weekends and City holidays use the weekend column; weekend tee times before 9:00 a.m. pay the
//   "premium" rate.
// - Twilight and super twilight start at set times that change with the season. A Player Card
//   moves twilight an hour earlier ("1 hour early twilight rates").
// - The $10-per-player booking deposit counts toward the green fee at check-in.
// - Riding: electric carts are priced per seat (a half cart). Push-cart rental is separate.
//   Bringing your own push cart costs nothing.

const TZ = 'America/Los_Angeles';
const CHECKED = '2026-11-25';
const SOURCE = 'https://golf.lacity.gov/rates/';

// Rates in cents: [weekday, weekend, weekend before 9 a.m.]. null = not offered.
const C = (d) => Math.round(d * 100);
const R = (wd, we, prem = we) => [C(wd), C(we), C(prem)];
const COURSES = {
  'Rancho Park': { holes: 18, r18: R(42, 53, 58), r9: R(23, 29), tw: R(28, 35), stw: R(19, 24) },
  'Griffith Park - Wilson': { holes: 18, r18: R(41, 52, 57), r9: null, tw: R(27, 35), stw: R(19, 23) },
  'Griffith Park - Harding': { holes: 18, r18: R(38, 49, 54), r9: null, tw: R(25, 33), stw: R(17, 22) },
  Roosevelt: { holes: 9, r9: R(19, 24, 27), tw: R(13, 16), stw: null },
};
const CART = { full: C(18), tw: C(13), stw: C(11) };   // per seat; 9 holes and twilight share the $13 rate
const PUSH = { 18: C(8), 9: C(6) };
const DEPOSIT_PER_PLAYER = C(10);

// Parts of a moment in Los Angeles time.
function la(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: p.weekday };
}
// nth weekday (0=Sun) of a month; n = -1 for the last one.
function nthWeekday(y, m, wd, n) {
  if (n > 0) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((wd - first + 7) % 7) + (n - 1) * 7; }
  const last = new Date(Date.UTC(y, m, 0)); return last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7);
}
// City of Los Angeles holidays that use weekend rates (the City's own list for 2025, golf.lacity.gov/?p=264:
// it does not include César Chávez Day or Indigenous Peoples' Day).
// The weekday rules make this work for any year; observed-day shifts for weekend holidays don't
// matter here because those days already use weekend rates.
function holiday(y, m, d) {
  const list = [[1, 1, "New Year's Day"], [1, nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day'], [2, nthWeekday(y, 2, 1, 3), "Presidents' Day"],
    [5, nthWeekday(y, 5, 1, -1), 'Memorial Day'], [6, 19, 'Juneteenth'], [7, 4, 'Independence Day'],
    [9, nthWeekday(y, 9, 1, 1), 'Labor Day'], [11, 11, 'Veterans Day'],
    [11, nthWeekday(y, 11, 4, 4), 'Thanksgiving'], [11, nthWeekday(y, 11, 4, 4) + 1, 'Day after Thanksgiving'], [12, 25, 'Christmas Day']];
  return list.find(([hm, hd]) => hm === m && hd === d)?.[2] || null;
}
// Twilight and super twilight start (24h clock) for a date, for 18-hole courses. The posted schedule
// changes on Jan 1, the start of daylight time, May 1, Sep 1 and the end of daylight time.
// 9-hole courses start twilight when 18-hole courses start super twilight.
function twilightStarts(y, m, d) {
  const dstStart = nthWeekday(y, 3, 0, 2), dstEnd = nthWeekday(y, 11, 0, 1);
  const k = m * 100 + d;
  if (k < 300 + dstStart) return { tw: 13, stw: 15 };
  if (k < 501) return { tw: 15, stw: 17 };
  if (k < 901) return { tw: 16, stw: 18 };
  if (k < 1100 + dstEnd) return { tw: 15, stw: 17 };
  return { tw: 14, stw: 16 };
}

const courseKey = (name) => {
  const n = String(name || '').toLowerCase();
  if (/rancho/.test(n) && !/par.?3|9.hole/.test(n)) return 'Rancho Park';
  if (/wilson/.test(n)) return 'Griffith Park - Wilson';
  if (/harding/.test(n)) return 'Griffith Park - Harding';
  if (/roosevelt/.test(n)) return 'Roosevelt';
  return null;
};
const isLaCity = (name) => !!courseKey(name);

// Price per player for a tee time. card: does this player have a Player Card.
// ride: 'walk' (own cart or carry), 'push' (rent a push cart), 'cart' (seat in an electric cart).
function quote({ course, teeAt, holes = 18, card = true, ride = 'walk' }) {
  const key = courseKey(course);
  if (!key) return null;
  const c = COURSES[key];
  const t = la(teeAt);
  const hol = holiday(t.y, t.m, t.d);
  const weekend = hol || t.wd === 'Sat' || t.wd === 'Sun';
  const col = weekend ? (t.h < 9 ? 2 : 1) : 0;
  const s = twilightStarts(t.y, t.m, t.d);
  const nine = c.holes === 9 || holes === 9;
  // 9-hole courses' twilight lines up with the 18-hole super twilight.
  let twAt = nine && c.holes === 9 ? s.stw : s.tw;
  const stwAt = nine && c.holes === 9 ? null : s.stw;
  if (card) twAt -= 1;
  const hour = t.h + t.mi / 60;
  let band = 'regular';
  if (stwAt != null && c.stw && hour >= stwAt) band = 'stw';
  else if (c.tw && hour >= twAt) band = 'tw';
  let fee, label;
  if (band === 'stw') { fee = c.stw[col === 2 ? 1 : col]; label = 'Super twilight'; }
  else if (band === 'tw') { fee = c.tw[col === 2 ? 1 : col]; label = card && hour < twAt + 1 ? 'Twilight (Player Card hour)' : 'Twilight'; }
  else if (nine) {
    const r = c.r9 || null;
    if (!r) return { course: key, unavailable: true, note: `${key} has no 9-hole rate listed` };
    fee = r[col]; label = c.holes === 9 ? '9 holes' : '9 holes';
  } else { fee = c.r18[col]; label = '18 holes'; }
  const day = hol ? `${hol} (holiday rates)` : weekend ? 'Weekend' : 'Weekday';
  const ridePrice = ride === 'cart' ? (c.holes === 9 ? null : band === 'stw' ? CART.stw : band === 'tw' || nine ? CART.tw : CART.full)
    : ride === 'push' ? PUSH[c.holes === 9 ? 9 : 18] : 0;
  return {
    course: key, green: fee, ride, rideFee: ridePrice ?? 0, rideNote: ridePrice == null ? 'No cart rates listed for this course' : '',
    each: fee + (ridePrice ?? 0), label: `${day} · ${label}${col === 2 ? ' · before 9 a.m.' : ''}`,
    twilightAt: twAt, superTwilightAt: stwAt, deposit: DEPOSIT_PER_PLAYER, checked: CHECKED, source: SOURCE,
  };
}

// The whole booking: everyone's green fees (and rides) and the deposit that counts toward them.
function quoteBooking(b, cards = {}) {
  const players = Math.max(1, b.players || 1);
  const ids = (b.roster || []).map((r) => r.userId);
  let total = 0, first = null;
  for (let i = 0; i < players; i++) {
    // Each of you is priced with your own card; anyone else in the group is assumed to have one too.
    const card = i < ids.length ? cards[ids[i]] !== false : true;
    const q = quote({ course: b.course, teeAt: b.teeAt, holes: b.holes, card, ride: b.ride || 'walk' });
    if (!q || q.unavailable) return q;
    first = first || q;
    total += q.each;
  }
  return { ...first, players, total };
}

module.exports = { quote, quoteBooking, isLaCity, courseKey, holiday, twilightStarts, DEPOSIT_PER_PLAYER, CHECKED, SOURCE };
