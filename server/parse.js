'use strict';
// Reads a tee-time confirmation that was pasted or shared into the app and pulls out the
// booking details. Knows the three formats you get in practice:
//   - L.A. City courses (EZLinks, sent from alerts@teetimeinfo.com)
//   - Courses whose booking runs on GolfNow / "powered by NBC Sports Next" (e.g. Los Verdes)
//   - foreUP courses (e.g. Soule Park), sent from no-reply@foreupsoftware.com
// Anything else gets a best guess from whatever dates, times and dollar amounts it can find.
// The result only pre-fills the form; you always see and confirm it before it is saved.

const TZ = 'America/Los_Angeles';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Milliseconds since 1970 for a wall-clock time in Los Angeles (handles daylight saving).
function laTime(y, mo, d, h = 0, mi = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - tzOffset(t);
  return t;
}
function tzOffset(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(t / 60000) * 60000;
}
// The Los Angeles calendar date and clock of a moment, as numbers.
function laParts(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: p.weekday };
}
function fmtWhen(t) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t));
}

const cents = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
function monthNo(s) { const i = MONTHS.indexOf(String(s).slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; }
function clock(s) {
  const m = String(s).match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'p') h += 12;
  return { h, mi: Number(m[2] || 0) };
}
function year4(y) { y = Number(y); return y < 100 ? 2000 + y : y; }

// "Tuesday, March 03, 2026" / "March 3, 2026" / "9/4/26" -> {y, mo, d}
function findDate(s) {
  let m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
  if (m) return { y: Number(m[3]), mo: monthNo(m[1]), d: Number(m[2]) };
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) return { y: year4(m[3]), mo: Number(m[1]), d: Number(m[2]) };
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  return null;
}

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/<https?:[^>\s]*>/g, '') // link targets the mail app pasted in
    .replace(/<#[^>]*>/g, '')
    .replace(/&#146;?/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[* ]/g, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{2,}/g, '\n')
    // Drop the header block of a forwarded email, so its "Date:" is not taken for the tee date.
    .replace(/^-+ ?Forwarded message ?-+\n(?:(?:From|Date|Subject|To|Cc):[^\n]*\n)+/im, '\n');
}
// "Label: value" on a line of its own.
const after = (s, label) => { const m = s.match(new RegExp('^' + label + '[ \\t]*:[ \\t]*([^\\n]+)', 'im')); return m ? m[1].trim() : null; };
// GolfNow mails put the value on the line after its label.
const nextLine = (s, label) => { const m = s.match(new RegExp('^' + label + '\\s*\\n([^\\n]+)', 'im')); return m ? m[1].trim() : null; };

function laCity(s) {
  const full = after(s, 'Course');
  const nine = (full || '').match(/\((back|front) 9\)/i);
  const course = full && full.replace(/\s*\([^)]*\)\s*$/, '');
  const date = findDate(after(s, 'Date of Play') || '');
  const time = clock(after(s, 'Time of Play') || '');
  const players = Number(after(s, 'Number of Players')) || null;
  const out = {
    source: 'L.A. City Golf', course, players, booker: after(s, 'Reservation Name'), confirmation: after(s, 'Confirmation Number'),
    holes: nine ? 9 : 18, cancelHours: 24,
    notes: [],
  };
  if (/back 9 tee times are walking only/i.test(s)) out.notes.push('Back 9: walking only, no carts');
  else if (nine) out.notes.push(`${nine[1][0].toUpperCase()}${nine[1].slice(1).toLowerCase()} 9`);
  out.notes.push('$10/player deposit is credited to green fees at check-in and lost if you cancel. Cancel or move 24h+ ahead to avoid the $10/player no-show fee.');
  if (players) out.deposit = players * 1000;
  const addr = s.match(/\n\s*(\d+[^\n]*,\s*Los Angeles,\s*CA\s*\d{5})/i);
  if (addr) out.address = addr[1].trim();
  const phone = s.match(/Phone:\s*(\(\d{3}\)\s*\d{3}-\d{4})/);
  if (phone) out.phone = phone[1];
  return finish(out, date, time);
}

function golfNow(s) {
  const course = (s.match(/reservation at\s+([^!\n]+?)\s*!/i) || [])[1] || null;
  const dateLine = (s.match(/^(?:mon|tues|wednes|thurs|fri|satur|sun)day,\s+[a-z]+\s+\d{1,2},\s+\d{4}$/im) || [])[0];
  const timeLine = (s.match(/^\d{1,2}:\d{2}\s*[ap]m$/im) || [])[0];
  const players = Number((s.match(/^(\d+)\s*Player\(s\)/im) || [])[1]) || null;
  const holes = Number((s.match(/Player\(s\)\s*\n(9|18)\s*$/im) || [])[1]) || 18;
  const conf = (s.match(/Confirmation\s*#\s*:?\s*\n?\s*([A-Z0-9-]+)/i) || [])[1] || null;
  const total = cents(nextLine(s, 'Green Fees') || '');
  const paid = cents(nextLine(s, 'Paid Online') || '') || 0;
  const addr = (s.match(/^(\d+[^\n]*,\s*CA\s*\d{5})(?:,\s*US)?$/im) || [])[1] || null;
  const phone = (s.match(/call us at\s*(\(\d{3}\)\s*\d{3}-\d{4})/i) || [])[1] || null;
  const out = {
    source: 'GolfNow', course: course && course.trim(), players, holes, confirmation: conf, total, deposit: paid,
    booker: (s.match(/^Hi\s+([^,\n]+),/im) || [])[1] || null, address: addr, phone, notes: [],
  };
  const due = cents(nextLine(s, 'Total Due at Course') || '');
  if (due != null) out.notes.push(`Due at the course: $${(due / 100).toFixed(2)}`);
  return finish(out, dateLine ? findDate(dateLine) : null, timeLine ? clock(timeLine) : null);
}

function foreUp(s) {
  let course = (s.match(/Facility\s*\n([^\n]+)/i) || [])[1] || null;
  if (course) course = course.replace(/\s*Details\s*$/i, '').trim();
  const total = cents(after(s, 'Total') || '');
  const out = {
    source: 'foreUP', course, players: Number(after(s, 'Players')) || null, holes: Number(after(s, 'Holes')) || 18,
    confirmation: after(s, 'Confirmation #') || null, total, deposit: /Paid with|Paid on/i.test(s) ? total : 0,
    booker: (s.match(/Billing Info\s*\n([^\n]+)/i) || [])[1] || null, notes: [],
  };
  const carts = Number(after(s, 'Carts'));
  if (Number.isFinite(carts)) out.notes.push(carts ? `${carts} cart(s) included` : 'Walking (no carts booked)');
  if (out.deposit && out.deposit === total) out.notes.push('Paid in full online');
  return finish(out, findDate(after(s, 'Date') || ''), clock(after(s, 'Time') || ''));
}

function generic(s) {
  const body = s;
  const time = clock((body.match(/\b\d{1,2}:\d{2}\s*[ap]\.?m\.?/i) || [])[0] || '');
  const players = Number((body.match(/(\d+)\s*(?:players?|golfers?)\b/i) || body.match(/players?\s*:?\s*(\d+)/i) || [])[1]) || null;
  const dollars = [...body.matchAll(/\$\s?(\d[\d,]*(?:\.\d{2})?)/g)].map((m) => cents(m[1]));
  return finish({ source: 'Other', players, total: dollars.length ? Math.max(...dollars) : null, notes: [] }, findDate(body), time);
}

function finish(out, date, time) {
  if (date && time) out.teeAt = laTime(date.y, date.mo, date.d, time.h, time.mi);
  else if (date) out.date = `${date.y}-${String(date.mo).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  out.notes = (out.notes || []).join('\n');
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

// knownCourses: [{name}] from the database, used to recognise a course in an unfamiliar email.
function parseConfirmation(text, knownCourses = []) {
  const s = clean(text);
  let r;
  if (/teetimeinfo\.com|golf\.lacity\.(org|gov)|Date of Play:/i.test(s)) r = laCity(s);
  else if (/Player\(s\)/i.test(s) && /reservation at/i.test(s)) r = golfNow(s);
  else if (/foreupsoftware|Reservation Details[\s\S]*Facility/i.test(s)) r = foreUp(s);
  else r = generic(s);
  if (!r.course) {
    const hit = knownCourses.find((c) => c.name && s.toLowerCase().includes(c.name.toLowerCase().replace(/\s*golf course$/i, '')));
    if (hit) r.course = hit.name;
  }
  r.missing = ['course', 'teeAt', 'players'].filter((k) => r[k] == null);
  return r;
}

module.exports = { parseConfirmation, laTime, laParts, fmtWhen, TZ, cents };
