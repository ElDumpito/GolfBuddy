'use strict';
// GolfBuddy client. One page; the part after # in the address picks the screen.
// Shot tracking and the gear closet live in track.js, which plugs into the same render loop.
const TZ = 'America/Los_Angeles';
const HOUR = 3600000, MIN = 60000;
let S = null;            // everything from /api/state
let installEvt = null;   // Chrome's "install this app" prompt, saved for the button in Me
const ui = { form: null, exp: null, round: null, hole: {}, pendingPay: null, showPast: false, shareText: null, saving: {}, briefs: {}, tee: {}, practice: null, keys: null };
const extraViews = {};   // route name -> view function, filled in by track.js

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);
const dollars = (c) => (c ? (c / 100).toFixed(2).replace(/\.00$/, '') : '');
const user = (id) => S.users.find((u) => u.id === id) || { id, name: 'Someone', venmo: '' };
const first = (id) => (id === S.me.id ? 'You' : user(id).name.split(/\s+/)[0]);
const fmt = (t, o) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o }).format(new Date(t));
const fDay = (t) => fmt(t, { weekday: 'short', month: 'short', day: 'numeric' });
const fLongDay = (t) => fmt(t, { weekday: 'long', month: 'long', day: 'numeric' });
const fTime = (t) => fmt(t, { hour: 'numeric', minute: '2-digit' });
const fWhen = (t) => `${fDay(t)}, ${fTime(t)}`;
function laParts(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, '0')}:${p.minute}` };
}
function laTime(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number), [h, mi] = (timeStr || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const off = (t) => { const p = laParts(t); const [Y, M, D] = p.date.split('-').map(Number), [H, Mi] = p.time.split(':').map(Number); return Date.UTC(Y, M - 1, D, H, Mi) - Math.floor(t / 60000) * 60000; };
  let t = wall; for (let i = 0; i < 3; i++) t = wall - off(t);
  return t;
}
function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 && h < 10 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function until(t) {
  const now = Date.now(), days = Math.round((laTime(laParts(t).date, '12:00') - laTime(laParts(now).date, '12:00')) / (24 * HOUR));
  if (t < now) return 'Under way';
  if (days === 0) return t - now < 3 * HOUR ? `In ${dur(t - now)}` : 'Today';
  if (days === 1) return 'Tomorrow';
  return days < 7 ? fmt(t, { weekday: 'long' }) : `In ${days} days`;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2800); }
async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* the login wall may answer with a page */ }
  if (res.status === 401) { S = null; render(); throw new Error(data.error || 'Log in first'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
function route() {
  const [p, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const seg = p.split('/').filter(Boolean);
  return { seg, q: new URLSearchParams(qs || '') };
}
const myBalance = () => (S.balances.find((b) => b.userId === S.me.id) || { balance: 0 }).balance;
const courseOf = (b) => S.courses.find((x) => x.id === b.courseId) || S.courses.find((x) => x.name === b.course) || {};
const mapsUrl = (b) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(b.address || b.course)}&travelmode=driving`;
const telUrl = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
function gcalUrl(b) {
  const z = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = b.teeAt + (b.holes === 9 ? 2.5 : 4.75) * HOUR;
  const details = [`${b.players} players · ${b.holes} holes · booked by ${user(b.bookerId).name}`, b.confirmation && `Confirmation #${b.confirmation}`,
    b.cancelAt > Date.now() && `Free cancel until ${fWhen(b.cancelAt)}`, `${location.origin}/#/b/${b.id}`].filter(Boolean).join('\n');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('⛳ ' + b.course)}&dates=${z(b.teeAt)}/${z(end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(b.address || b.course)}`;
}
const venmoUrl = (to, amount, note, txn = 'pay') => `https://venmo.com/${encodeURIComponent(to)}?txn=${txn}&amount=${(amount / 100).toFixed(2)}&note=${encodeURIComponent(note)}`;

// ---------- icons (simple line drawings, so the app looks the same on every phone) ----------
const ICONS = {
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r=".8"/>',
  card: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  nav: '<path d="M3 11l18-8-8 18-2-8z"/>',
  phone: '<path d="M5 4h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 3.5 6 3.5 9s-1 6-3.5 9c-2.5-3-3.5-6-3.5-9s1-6 3.5-9"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  sunset: '<path d="M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0M12 3v6M9 6.5l3 3 3-3"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.1 4.5 4.5 0 0 0 7 18z"/>',
  rain: '<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 6.1 4.5 4.5 0 0 0 7 15z"/><path d="M8 21l1-3M12 21l1-3M16 21l1-3"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8"/>',
  car: '<path d="M4 15l1.6-5.1A2 2 0 0 1 7.5 8.5h9a2 2 0 0 1 1.9 1.4L20 15v3a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1h-9v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 15h16M7.5 12h.01M16.5 12h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alarm: '<circle cx="12" cy="13" r="7"/><path d="M12 10v3l2 1.5M5 4L3 6M19 4l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  bag: '<path d="M8 8V6a4 4 0 0 1 8 0v2"/><rect x="5" y="8" width="14" height="13" rx="3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
};
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const skyIcon = (sky) => (/thunder|rain|shower|drizzle/i.test(sky || '') ? 'rain' : /cloud|overcast|fog|haze|smoke/i.test(sky || '') ? 'cloud' : 'sun');
const TEE_COLORS = { black: '#111', blue: '#3b6fd6', white: '#f4f1e8', red: '#c84a3c', yellow: '#e8c547', gold: '#d4a73c', green: '#3e8a57', orange: '#e58a2b',
  oak: '#6b4a2b', avocado: '#5d7b2f', lime: '#9cc94b', lemon: '#efe26a', combo: '#bdb8a7' };
const teeDot = (name) => { const k = String(name).toLowerCase().split('/')[0].trim(); return `<span class="dot" style="background:${TEE_COLORS[k] || '#888'}"></span>`; };

// ---------- frame ----------
function frame({ title, back, right = '', body, tab, wordmark }) {
  const tabs = [['tee', '#/', 'flag', 'Tee times'], ['money', '#/money', 'wallet', 'Money'], ['scores', '#/scores', 'card', 'Rounds'], ['me', '#/me', 'user', 'Me']];
  return `<header class="top">${back ? `<a class="btn back" href="${back}" aria-label="Back">${icon('back')}</a>` : ''}
    ${wordmark ? `<span class="wordmark grow">Golf<b>Buddy</b></span>` : `<h1 class="grow">${esc(title)}</h1>`}${right}</header>
  <main class="page">${body}</main>
  <nav class="nav">${tabs.map(([k, h, i, l]) => `<a href="${h}" class="${tab === k ? 'on' : ''}">${icon(i)}${l}</a>`).join('')}</nav>`;
}
function balanceChip() {
  const b = myBalance();
  if (!b) return `<a class="pill ok" href="#/money">All square</a>`;
  return `<a class="pill ${b > 0 ? 'ok' : 'warn'} num" href="#/money">${b > 0 ? `Owed ${money(b)}` : `You owe ${money(-b)}`}</a>`;
}

// ---------- the Round Brief (fetched per tee time, kept for 10 minutes) ----------
function loadBrief(id, force) {
  const cur = ui.briefs[id];
  if (cur && (cur.loading || (!force && Date.now() - cur.at < 10 * MIN))) return cur.data;
  ui.briefs[id] = { ...cur, loading: true, at: Date.now() };
  api('GET', `/api/bookings/${id}/brief`).then((d) => { ui.briefs[id] = { data: d, at: Date.now() }; if (!busyForm()) render(); })
    .catch(() => { ui.briefs[id] = { data: cur?.data || null, at: Date.now(), failed: true }; });
  return cur?.data;
}

// ---------- tee times ----------
function deadlinePill(b) {
  const now = Date.now();
  if (b.status === 'cancelled') return `<span class="pill bad">Cancelled</span>`;
  if (b.teeAt < now) return `<span class="pill">Played</span>`;
  if (now < b.cancelAt) {
    const left = b.cancelAt - now;
    return `<span class="pill ${left < S.remindHours * HOUR ? 'warn' : 'ok'}">Free cancel · ${dur(left)} left</span>`;
  }
  return `<span class="pill">Locked in</span>`;
}
function rosterChips(b) {
  return b.roster.map((r) => `<span class="pill ${r.rsvp === 'out' ? 'bad' : 'ok'}">${r.rsvp === 'out' ? '✕' : icon('check', 'sm')} ${esc(first(r.userId))}</span>`).join('');
}
function teeRow(b) {
  const off = b.status === 'cancelled' || b.teeAt < Date.now() - 5 * HOUR;
  return `<a class="tee ${off ? 'off' : ''}" href="#/b/${b.id}">
    <div class="date"><div class="wd">${fmt(b.teeAt, { weekday: 'short' })}</div><div class="d">${fmt(b.teeAt, { day: 'numeric' })}</div><div class="m">${fmt(b.teeAt, { month: 'short' })}</div></div>
    <div class="grow"><div class="name">${esc(b.course)}</div>
      <div class="meta">${fTime(b.teeAt)} · ${b.holes} holes · ${b.roster.filter((r) => r.rsvp !== 'out').map((r) => esc(first(r.userId))).join(' & ')}</div></div>
    <span class="chev">${icon('chev')}</span></a>`;
}
function glance(b, br) {
  const w = br?.weather, l = br?.leave, sun = br?.sun;
  const cell = (k, ic, v, s) => `<div><div class="k">${icon(ic, 'sm')}${k}</div><div class="v">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`;
  const wx = !br ? cell('Weather', 'sun', '<span class="faint">…</span>')
    : w?.at ? cell('Weather', skyIcon(w.at.sky), `${w.at.temp}°`, w.at.pop >= 20 ? `${w.at.pop}% rain` : esc(w.at.sky))
    : w?.status === 'later' ? cell('Weather', 'cloud', '<span class="faint">—</span>', `Forecast ${fDay(w.opensAt)}`) : cell('Weather', 'cloud', '<span class="faint">—</span>', 'Unavailable');
  const lv = !br ? cell('Leave by', 'car', '<span class="faint">…</span>')
    : l?.status === 'ok' ? cell('Leave by', 'car', fTime(l.at), `${l.minutes} min drive`)
    : l?.status === 'nohome' ? cell('Leave by', 'car', '<span class="faint">—</span>', 'Add home in Me')
    : l?.status === 'nokey' ? cell('Leave by', 'car', '<span class="faint">—</span>', 'Needs Google key') : cell('Leave by', 'car', '<span class="faint">—</span>', 'Unavailable');
  const dl = !sun ? cell('Daylight', 'sunset', '<span class="faint">—</span>')
    : sun.beforeSunrise ? cell('Sunrise', 'sun', fTime(sun.sunrise), `Tee ${dur(sun.sunrise - b.teeAt)} before`)
    : cell('Sunset', 'sunset', fTime(sun.sunset), sun.pastDark ? 'Finish after dark' : sun.pastSunset ? 'Finish near dusk' : `Done ~${fTime(sun.finish).replace(/\s?[AP]M$/, '')}`);
  return `<div class="glance">${wx}${lv}${dl}</div>`;
}
function viewTeeTimes() {
  const now = Date.now();
  const up = S.bookings.filter((b) => b.status === 'active' && b.teeAt > now - 5 * HOUR).sort((a, b) => a.teeAt - b.teeAt);
  const past = S.bookings.filter((b) => !up.includes(b)).sort((a, b) => b.teeAt - a.teeAt);
  const next = up[0];
  const br = next && loadBrief(next.id);
  const pushHint = !S.push.mine && 'Notification' in window ? `<div class="card row"><span class="ic brass">${icon('bell')}</span><span class="grow small-text">Turn on notifications to hear about new tee times and cancellation deadlines.</span><button class="primary small-btn chip" data-act="push-on">Turn on</button></div>` : '';
  return frame({
    wordmark: true, tab: 'tee', right: balanceChip(),
    body: `${pushHint}
    ${next ? `<a class="card hero" href="#/b/${next.id}" style="color:inherit">
      <div class="row"><span class="over grow">Next round · ${esc(until(next.teeAt))}</span>${deadlinePill(next)}</div>
      <div class="course">${esc(next.course)}</div>
      <div class="when">${fLongDay(next.teeAt)} at ${fTime(next.teeAt)}</div>
      ${glance(next, br)}</a>`
      : `<section class="card hero"><div class="over">No round on the books</div><div class="course">Where to next?</div><div class="when">Paste a confirmation email and the rest fills itself in.</div></section>`}
    <a class="btn primary block" href="#/new">${icon('plus')} Add a tee time</a>
    ${up.length > 1 ? `<section class="card"><div class="card-head"><h2>Also coming up</h2></div><div class="list">${up.slice(1).map(teeRow).join('')}</div></section>` : ''}
    <section class="card flush list">
      <a class="link-row" href="#/practice"><span class="ic">${icon('target')}</span><span class="grow"><b>Ranges &amp; simulators</b><div class="small-text dim">Within 30 miles of you</div></span><span class="faint">${icon('chev')}</span></a>
      <a class="link-row" href="#/bag"><span class="ic">${icon('bag')}</span><span class="grow"><b>Your bag</b><div class="small-text dim">Clubs, balls, gloves and shoes</div></span><span class="faint">${icon('chev')}</span></a>
    </section>
    ${past.length ? `<section class="card"><div class="card-head"><h2>Past &amp; cancelled</h2><button class="quiet chip" data-act="toggle-past">${ui.showPast ? 'Hide' : `Show ${past.length}`}</button></div>
      ${ui.showPast ? `<div class="list">${past.slice(0, 40).map(teeRow).join('')}</div>` : ''}</section>` : ''}`,
  });
}

// --- the brief sections on a tee time ---
function briefWeather(b, w) {
  if (!w) return `<div class="bline"><span class="ic">${icon('cloud')}</span><div class="grow dim small-text">Checking the forecast…</div></div>`;
  if (w.status === 'later') return `<div class="bline"><span class="ic">${icon('cloud')}</span><div class="grow"><div class="mid">Forecast opens ${fDay(w.opensAt)}</div><div class="small-text dim">The National Weather Service forecasts 7 days out.</div></div></div>`;
  if (w.status === 'error' || !w.at) return `<div class="bline"><span class="ic">${icon('cloud')}</span><div class="grow small-text dim">Weather is unavailable right now.</div></div>`;
  const a = w.at;
  return `<div class="bline"><span class="ic">${icon(skyIcon(a.sky))}</span><div class="grow">
      <div class="row"><span class="big">${a.temp}°</span><span class="dim grow">${esc(a.sky)}</span></div>
      <div class="small-text dim" style="margin-top:4px">${w.lo != null && w.lo !== w.hi ? `${w.lo}–${w.hi}° over the round · ` : ''}${icon('wind', 'sm')} ${w.windMax ?? a.wind ?? '?'} mph ${esc(a.dir || '')} · ${w.popMax ?? a.pop ?? 0}% chance of rain</div></div></div>
    ${w.hours?.length > 1 ? `<div class="hours">${w.hours.slice(0, 6).map((h) => `<div>${fmt(h.s, { hour: 'numeric' })}<b>${h.t}°</b>${h.p >= 20 ? `${h.p}%` : `${h.w ?? ''} mph`}</div>`).join('')}</div>` : ''}
    ${w.text ? `<p class="small-text dim" style="margin:10px 0 0">${esc(w.text)}</p>` : ''}`;
}
function briefDaylight(b, s) {
  if (!s) return '';
  const span = s.lastLight - s.firstLight, pct = (t) => Math.max(0, Math.min(100, ((t - s.firstLight) / span) * 100));
  const warn = s.pastDark ? `A ${b.holes}-hole round from ${fTime(b.teeAt)} runs until about ${fTime(s.finish)}, after dark (${fTime(s.lastLight)}).`
    : s.pastSunset ? `You'll likely finish around sunset; last light is ${fTime(s.lastLight)}.`
    : s.beforeSunrise ? `You tee off ${dur(s.sunrise - b.teeAt)} before sunrise; first light is ${fTime(s.firstLight)}.` : '';
  return `<div class="bline"><span class="ic">${icon('sunset')}</span><div class="grow">
      <div class="row"><span class="mid grow">${fTime(s.sunrise)} – ${fTime(s.sunset)}</span><span class="small-text dim">last light ${fTime(s.lastLight)}</span></div>
      <div class="daybar"><span class="span" style="left:${pct(b.teeAt)}%;width:${Math.max(2, pct(s.finish) - pct(b.teeAt))}%"></span></div>
      <div class="row tiny faint"><span class="grow">First light ${fTime(s.firstLight)}</span><span>Your round ${fTime(b.teeAt)}–${fTime(s.finish)}</span></div>
      ${warn ? `<div class="note ${s.pastDark ? 'warn-note' : ''}" style="margin-top:10px">${warn}</div>` : ''}</div></div>`;
}
function briefLeave(b, l) {
  if (!l) return `<div class="bline"><span class="ic">${icon('car')}</span><div class="grow dim small-text">Working out the drive…</div></div>`;
  if (l.status === 'nohome') return `<div class="bline"><span class="ic">${icon('car')}</span><div class="grow"><div class="mid">When to leave</div><div class="small-text dim">Add your home address in <a href="#/me">Me</a> to see when to leave, with traffic for that time of day.</div></div></div>`;
  if (l.status === 'nokey') return `<div class="bline"><span class="ic">${icon('car')}</span><div class="grow"><div class="mid">When to leave</div><div class="small-text dim">Turns on once the Google key is added in Me › Admin.</div></div></div>`;
  if (l.status !== 'ok') return `<div class="bline"><span class="ic">${icon('car')}</span><div class="grow small-text dim">Drive time unavailable right now.</div></div>`;
  const extra = l.minutes - l.usual;
  return `<div class="bline"><span class="ic">${icon('car')}</span><div class="grow">
    <div class="row"><span class="over grow">Leave home by</span></div>
    <div class="row"><span class="big">${fTime(l.at)}</span><span class="dim small-text grow">to arrive ${fTime(l.arrive)}, ${Math.round((b.teeAt - l.arrive) / MIN)} min early</span></div>
    <div class="small-text dim" style="margin-top:4px">${l.minutes} min · ${l.miles} mi in expected traffic${extra > 4 ? ` (${extra} min more than an empty road)` : ''}. Checked ${fTime(l.checked)}.</div></div></div>`;
}
function briefWake(b, w) {
  if (!w || b.teeAt < Date.now()) return '';
  const people = w.people.filter((p) => !p.out);
  const line = (p) => {
    const nm = p.userId === S.me.id ? 'You' : esc(user(p.userId).name.split(/\s+/)[0]);
    if (!p.ready) return `<div class="small-text dim">${nm}: not set up${p.userId === S.me.id ? ` (<a href="#/me">phone, home and the wake-up switch in Me</a>)` : ''}</div>`;
    const st = p.done === 'answered' ? 'answered ✓' : p.done === 'missed' ? 'didn’t pick up' : p.done === 'push-only' ? 'notified (no call: phone service not set up)'
      : p.skipped ? 'skipped, booked too late' : p.tries ? `called ${p.tries}×` : p.callAt ? `rings at ${fTime(p.callAt)}${p.estimate ? ' (estimate)' : ''}` : 'will ring 30 min before leave-by';
    return `<div class="small-text">${nm}: <span class="dim">${st}</span></div>`;
  };
  return `<div class="bline"><span class="ic">${icon('alarm')}</span><div class="grow">
    <div class="row"><span class="mid grow">Wake-up call</span><button class="switch ${w.on ? 'on' : ''}" data-act="wake-toggle" data-id="${b.id}" data-v="${w.on ? 0 : 1}" aria-label="Wake-up call"></button></div>
    <div class="tiny faint" style="margin:2px 0 8px">${w.auto ? `Automatic: ${w.on ? 'on because it’s before 8 a.m.' : 'off for tee times after 8 a.m.'}` : `Switched ${w.on ? 'on' : 'off'} for this tee time · <a href="#" data-act="wake-auto" data-id="${b.id}">reset</a>`}</div>
    ${w.on ? people.map(line).join('') : ''}${!S.features.calls && w.on ? `<div class="tiny faint" style="margin-top:6px">Until the phone service is set up, this arrives as a notification instead of a call.</div>` : ''}</div></div>`;
}
function scorecardTable(info, tee) {
  const holes = info.holes, t = info.tees.find((x) => x.name === tee) || info.tees[0];
  const n = holes.length, split = n === 18;
  const ys = t?.holes;
  const sum = (arr, a, z) => arr.slice(a, z).reduce((s, x) => s + (x || 0), 0);
  const cols = (fn, out, inn, tot) => holes.map((h, k) => `<td>${fn(h, k)}</td>${split && k === 8 ? `<td class="sum">${out}</td>` : ''}`).join('') + (split ? `<td class="sum">${inn}</td>` : '') + `<td class="sum">${tot}</td>`;
  const pars = holes.map((h) => h.par);
  return `<div class="cardtbl"><table>
    <tr><th>Hole</th>${holes.map((_, k) => `<th>${k + 1}</th>${split && k === 8 ? '<th class="sum">Out</th>' : ''}`).join('')}${split ? '<th class="sum">In</th>' : ''}<th class="sum">Tot</th></tr>
    ${ys ? `<tr><td>${teeDot(t.name)}${esc(t.name)}</td>${cols((h, k) => ys[k], sum(ys, 0, 9), sum(ys, 9, 18), sum(ys, 0, n))}</tr>` : ''}
    <tr><td>Par</td>${cols((h) => h.par, sum(pars, 0, 9), sum(pars, 9, 18), sum(pars, 0, n))}</tr>
    <tr><td class="faint">Hcp</td>${cols((h) => `<span class="faint">${h.hcp ?? ''}</span>`, '', '', '')}</tr>
  </table></div>`;
}
function briefCourse(b, c) {
  const info = c.info;
  if (!info) return `<div class="bline"><span class="ic">${icon('flag')}</span><div class="grow small-text dim">No scorecard on file for this course yet. Add pars and notes from <a href="#/course/${c.id}">the course page</a>.</div></div>`;
  const tee = ui.tee[c.id] || (info.tees.find((t) => t.name.toLowerCase() === (S.me.tee || '').toLowerCase()) || info.tees[Math.min(1, info.tees.length - 1)])?.name;
  const t = info.tees.find((x) => x.name === tee) || info.tees[0];
  const hardest = info.holes.reduce((a, h, k) => (h.hcp === 1 ? k + 1 : a), null);
  return `<div class="bline"><span class="ic">${icon('flag')}</span><div class="grow">
      <div class="row"><span class="mid grow">Par ${info.par}${t ? ` · ${t.yards.toLocaleString()} yds` : ''}</span>${t ? `<span class="small-text dim">${t.rating} / ${t.slope}</span>` : ''}</div>
      <div class="small-text dim">${info.holes.length} holes${info.built ? ` · opened ${info.built}` : ''}${hardest ? ` · hardest: #${hardest}` : ''}</div></div></div>
    ${info.tees.length ? `<div class="tees" style="margin-top:12px">${info.tees.map((x) => `<button class="${x.name === tee ? 'on' : ''}" data-act="pick-tee" data-c="${c.id}" data-v="${esc(x.name)}"><span>${teeDot(x.name)}${esc(x.name)}</span><b class="num">${x.yards.toLocaleString()}</b></button>`).join('')}</div>` : ''}
    <details style="margin-top:8px"><summary>Hole-by-hole scorecard</summary>${scorecardTable(info, tee)}</details>
    ${info.notes?.length ? `<div class="over" style="margin:14px 0 8px">Good to know</div><ul class="fyi">${info.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${info.source ? `<div class="tiny faint">Scorecard: ${esc(info.source)}</div>` : ''}`;
}

function viewBooking(id) {
  const b = S.bookings.find((x) => x.id === id);
  if (!b) return frame({ title: 'Tee time', back: '#/', tab: 'tee', body: `<div class="card empty">That tee time isn't here any more.</div>` });
  const c = courseOf(b);
  const br = loadBrief(b.id);
  const mine = b.roster.find((r) => r.userId === S.me.id);
  const exps = S.expenses.filter((e) => e.bookingId === b.id);
  const round = S.rounds.find((r) => r.bookingId === b.id);
  const ids = b.roster.map((r) => r.userId);
  const due = Math.max(0, b.total - b.deposit);
  const cancelled = b.status === 'cancelled';
  const upcoming = !cancelled && b.teeAt > Date.now() - 6 * HOUR;
  const website = c.website || c.bookUrl;
  return frame({
    title: '', back: '#/', tab: 'tee', right: `<a class="btn quiet" href="#/b/${b.id}/edit" aria-label="Edit">${icon('edit')}</a>`,
    body: `<section class="headline">
      <div class="row"><span class="over grow">${esc(until(b.teeAt))}</span>${deadlinePill(b)}</div>
      <div class="course">${esc(b.course)}</div>
      <div class="when">${fLongDay(b.teeAt)} · ${fTime(b.teeAt)}</div>
      <div class="small-text dim" style="margin-top:6px">${b.holes} holes · ${b.players} players · booked by ${esc(first(b.bookerId))}</div>
    </section>
    <section class="quick">
      <a class="btn" href="${mapsUrl(b)}" target="_blank" rel="noopener">${icon('nav')}Directions</a>
      ${c.phone ? `<a class="btn" href="${telUrl(c.phone)}">${icon('phone')}Call</a>` : `<button disabled>${icon('phone')}Call</button>`}
      ${website ? `<a class="btn" href="${esc(website)}" target="_blank" rel="noopener">${icon('globe')}Website</a>` : `<button disabled>${icon('globe')}Website</button>`}
      <a class="btn" href="${gcalUrl(b)}" target="_blank" rel="noopener">${icon('cal')}Calendar</a>
    </section>
    ${!cancelled && b.teeAt > Date.now() ? `<section class="card"><div class="row"><span class="grow"><b>Are you playing?</b></span></div>
      <div class="seg" style="margin-top:10px"><button data-act="rsvp" data-v="in" class="${mine && mine.rsvp !== 'out' ? 'on' : ''}">I'm in</button><button data-act="rsvp" data-v="out" class="${mine?.rsvp === 'out' ? 'on' : ''}">Can't make it</button></div>
      <div class="who" style="margin-top:10px">${rosterChips(b)}</div></section>` : ''}
    ${upcoming ? `<section class="card"><div class="card-head"><h2>Round brief</h2>${br ? `<button class="quiet chip" data-act="brief-refresh" data-id="${b.id}" aria-label="Refresh">↻</button>` : ''}</div>
      <div class="brief-sec">${briefWeather(b, br?.weather)}</div>
      ${br?.sun ? `<div class="brief-sec">${briefDaylight(b, br.sun)}</div>` : ''}
      ${b.teeAt > Date.now() ? `<div class="brief-sec">${briefLeave(b, br?.leave)}</div>` : ''}
      ${briefWake(b, br?.wake) ? `<div class="brief-sec">${briefWake(b, br?.wake)}</div>` : ''}
      <div class="brief-sec">${briefCourse(b, c)}</div>
    </section>` : c.info ? `<section class="card"><div class="card-head"><h2>The course</h2></div>${briefCourse(b, c)}</section>` : ''}
    ${bookingCard(b, ids, due)}
    <section class="card"><div class="card-head"><h2>Money</h2></div>
      <div class="list">${exps.length ? exps.map(expenseLine).join('') : `<div class="empty">Nothing yet.</div>`}</div>
      <div class="chips" style="margin-top:12px">
        <a class="btn chip" href="#/money/add?b=${b.id}&cat=${encodeURIComponent('Food & drinks')}">Food &amp; drinks</a>
        <a class="btn chip" href="#/money/add?b=${b.id}&cat=${encodeURIComponent('Pro shop')}">Pro shop</a>
        <a class="btn chip" href="#/money/add?b=${b.id}">Other</a>
      </div></section>
    <section class="card"><div class="card-head"><h2>Scorecard</h2></div>${round ? `${roundSummary(round)}<div class="row" style="margin-top:12px"><a class="btn grow" href="#/r/${round.id}">Open scorecard</a><a class="btn grow" href="#/r/${round.id}/shots">${icon('target')}Track shots</a></div>`
      : `<button class="block" data-act="start-round" data-id="${b.id}">${icon('card')}Start a scorecard</button>`}</section>
    <section class="row">
      ${cancelled ? `<button class="grow" data-act="restore" data-id="${b.id}">Un-cancel</button>` : `<button class="danger grow" data-act="cancel" data-id="${b.id}">Mark cancelled</button>`}
      ${b.createdBy === S.me.id || S.me.admin ? `<button class="quiet" data-act="delete-booking" data-id="${b.id}">Delete</button>` : ''}
    </section>`,
  });
}

// --- the booking: price (with where it comes from), walk or ride, deposit, and who paid the rest ---
const RIDES = [['walk', 'Walk'], ['push', 'Push cart'], ['cart', 'Riding cart']];
function bookingCard(b, ids, due) {
  const q = S.quotes?.[b.id];
  const priced = q && !q.unavailable;
  const rideNote = { walk: 'walking', push: 'renting push carts', cart: 'riding (a cart seat each)' }[b.ride] || 'walking';
  const upcoming = b.status !== 'cancelled';
  return `<section class="card"><div class="card-head"><h2>Booking</h2></div>
    <div class="kv">
      ${b.cancelAt ? `<span>Free cancel until</span><span>${fWhen(b.cancelAt)}</span>` : ''}
      ${b.confirmation ? `<span>Confirmation</span><span><button class="chip" data-act="copy" data-v="${esc(b.confirmation)}">${esc(b.confirmation)} ${icon('copy', 'sm')}</button></span>` : ''}
      <span>Total cost</span><span class="num">${b.total ? money(b.total) : '<span class="faint">not entered</span>'}${b.priceAuto ? ' <span class="pill ok">L.A. City rate</span>' : ''}</span>
      <span>Deposit</span><span>${b.deposit ? `${money(b.deposit)} by ${esc(first(b.bookerId))}${priced ? ', counts toward the total' : ''}` : '<span class="faint">none</span>'}</span>
      ${b.address ? `<span>Address</span><span>${esc(b.address)}</span>` : ''}
      ${b.source ? `<span>Added from</span><span>${esc(b.source)}</span>` : ''}
    </div>
    ${priced ? `<div class="note" style="margin-top:12px">${esc(q.label)}: <b class="num">${money(q.green)}</b> each${q.rideFee ? ` + ${money(q.rideFee)} ${b.ride === 'cart' ? 'cart seat' : 'push cart'}` : ''}, ${rideNote}${q.players > 1 ? ` × ${q.players}` : ''} = <b class="num">${money(q.total)}</b>.
      ${b.priceAuto ? '' : q.total !== b.total ? ` <button class="chip" data-act="use-rate" data-id="${b.id}">Use ${money(q.total)}</button>` : ''}
      <div class="tiny faint" style="margin-top:4px">From the City's published rates, checked ${esc(q.checked)}. Player Card twilight starts at ${q.twilightAt > 12 ? q.twilightAt - 12 : q.twilightAt} p.m. that day.${q.rideNote ? ' ' + esc(q.rideNote) + '.' : ''}</div></div>` : ''}
    ${upcoming ? `<div class="over" style="margin:16px 0 8px">Getting around</div>
      <div class="seg">${RIDES.map(([k, l]) => `<button data-act="ride" data-id="${b.id}" data-v="${k}" class="${(b.ride || 'walk') === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
    ${b.total > b.deposit ? `<div class="over" style="margin:16px 0 8px">At the course: ${money(due)}${b.deposit ? ` after the ${money(b.deposit)} deposit` : ''}</div>
      <div class="seg"><button data-act="paid" data-id="${b.id}" data-v="" class="${!b.balanceBy ? 'on' : ''}">Not yet</button>${b.roster.map((r) => `<button data-act="paid" data-id="${b.id}" data-v="${r.userId}" class="${b.balanceBy === r.userId ? 'on' : ''}">${esc(first(r.userId))} paid</button>`).join('')}</div>
      <div class="tiny faint" style="margin-top:6px">${b.balanceBy ? `In Money as green fees paid by ${esc(first(b.balanceBy))}, split ${ids.length} ways. It follows the total if that changes.` : 'Tap who paid at check-in; it goes into Money split evenly.'}</div>` : ''}
    ${b.notes ? `<p class="small-text dim" style="white-space:pre-wrap;margin:12px 0 0">${esc(b.notes)}</p>` : ''}</section>`;
}

// ---------- add / edit a tee time ----------
function blankForm() {
  const tomorrow = laParts(Date.now() + 24 * HOUR).date;
  return { course: '', date: tomorrow, time: '07:00', players: 2, holes: 18, bookerId: S.me.id, roster: S.users.map((u) => u.id), total: '', deposit: '',
    cancelHours: 24, confirmation: '', address: '', phone: '', notes: '', source: 'Manual', paste: '', ride: 'walk', balanceBy: '', autoPrice: true };
}
function formFromBooking(b) {
  const p = laParts(b.teeAt);
  return { id: b.id, course: b.course, date: p.date, time: p.time, players: b.players, holes: b.holes, bookerId: b.bookerId, roster: b.roster.map((r) => r.userId),
    total: dollars(b.total), deposit: dollars(b.deposit), cancelHours: Math.round((b.teeAt - b.cancelAt) / HOUR), confirmation: b.confirmation, address: b.address,
    phone: '', notes: b.notes, source: b.source, ride: b.ride || 'walk', balanceBy: b.balanceBy || '', autoPrice: b.priceAuto };
}
// Ask the server what the City charges for what's in the form (debounced), then show it.
let quoteT = null;
function refreshFormQuote() {
  clearTimeout(quoteT);
  quoteT = setTimeout(async () => {
    const f = ui.form; if (!f || !$('#bf')) return;
    if (!isLaCityName(f.course) || !f.date || !f.time) { f.quote = null; paintQuote(); return; }
    const qs = new URLSearchParams({ course: f.course, teeAt: laTime(f.date, f.time), holes: f.holes, players: f.players, ride: f.ride, roster: f.roster.join(',') });
    try { f.quote = (await api('GET', `/api/quote?${qs}`)).quote; } catch { f.quote = null; }
    paintQuote();
  }, 250);
}
const isLaCityName = (n) => /rancho|wilson|harding|roosevelt/i.test(n || '');
function paintQuote() {
  const el = $('#f-quote'); if (!el) return;
  const q = ui.form.quote;
  el.innerHTML = q && !q.unavailable ? `${esc(q.label)}: ${money(q.green)} each${q.rideFee ? ` + ${money(q.rideFee)}` : ''} × ${q.players} = <b class="num">${money(q.total)}</b>` : '';
  const t = $('#f-total');
  if (t && ui.form.autoPrice && q && !q.unavailable) { t.value = dollars(q.total); }
}
function viewForm(id) {
  const editing = !!id;
  if (!ui.form || (ui.form.id || null) !== (id || null)) {
    const b = editing && S.bookings.find((x) => x.id === id);
    ui.form = b ? formFromBooking(b) : blankForm();
    if (!editing && ui.shareText) { ui.form.paste = ui.shareText; ui.shareText = null; setTimeout(() => readPaste(), 0); }
  }
  const f = ui.form;
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
  return frame({
    title: editing ? 'Edit tee time' : 'New tee time', back: editing ? `#/b/${id}` : '#/', tab: 'tee',
    body: `${editing ? '' : `<section class="card"><h2>Paste the confirmation</h2>
      <textarea id="paste" placeholder="Paste the confirmation email (L.A. City, GolfNow, foreUP or anything else) and tap Read it.">${esc(f.paste)}</textarea>
      <div class="row" style="margin-top:10px"><button class="primary" data-act="read-paste">Read it</button><button class="outline" data-act="paste-clip">Paste from clipboard</button></div>
      <p class="tiny faint" style="margin:10px 0 0">Tip: in Gmail, long-press the email text › Select all › Share › GolfBuddy.</p></section>`}
    <section class="card" id="bf">
      <label for="f-course" style="margin-top:0">Course</label><input id="f-course" list="courses" value="${esc(f.course)}" placeholder="Rancho Park" autocomplete="off">
      <datalist id="courses">${S.courses.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <div class="grid2"><div><label for="f-date">Date</label><input id="f-date" type="date" value="${esc(f.date)}"></div>
        <div><label for="f-time">Tee time</label><input id="f-time" type="time" value="${esc(f.time)}"></div></div>
      <div class="grid2"><div><label for="f-players">Players in the booking</label><select id="f-players">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => opt(n, f.players)).join('')}</select></div>
        <div><label>Holes</label><div class="seg"><button data-act="holes" data-v="18" class="${f.holes === 18 ? 'on' : ''}">18</button><button data-act="holes" data-v="9" class="${f.holes === 9 ? 'on' : ''}">9</button></div></div></div>
      <label for="f-booker">Booked (and deposit paid) by</label><select id="f-booker">${S.users.map((u) => opt(u.id, f.bookerId, u.name)).join('')}</select>
      <label>Who's splitting it</label><div class="chips">${S.users.map((u) => `<button class="chip ${f.roster.includes(u.id) ? 'on' : ''}" data-act="roster" data-v="${u.id}">${esc(u.name)}</button>`).join('')}</div>
      <label>Getting around</label><div class="seg">${RIDES.map(([k, l]) => `<button data-act="f-ride" data-v="${k}" class="${f.ride === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="grid2"><div><label for="f-total">Total cost ($)</label><input id="f-total" inputmode="decimal" value="${esc(f.total)}" placeholder="0" ${f.autoPrice && isLaCityName(f.course) ? 'readonly' : ''}></div>
        <div><label for="f-deposit">Deposit paid ($)</label><input id="f-deposit" inputmode="decimal" value="${esc(f.deposit)}" placeholder="0"></div></div>
      ${isLaCityName(f.course) ? `<div class="row" style="margin-top:8px"><span class="grow tiny faint" id="f-quote"></span><button class="chip ${f.autoPrice ? 'on' : ''}" data-act="f-auto">${f.autoPrice ? 'City rate ✓' : 'Use City rate'}</button></div>` : ''}
      <label for="f-balance">The rest, paid at the course by</label><select id="f-balance"><option value="">Not paid yet</option>${S.users.map((u) => opt(u.id, f.balanceBy, u.name)).join('')}</select>
      <div class="grid2"><div><label for="f-cancel">Free cancel (hours before)</label><input id="f-cancel" inputmode="numeric" value="${esc(f.cancelHours)}"></div>
        <div><label for="f-conf">Confirmation #</label><input id="f-conf" value="${esc(f.confirmation)}"></div></div>
      <label for="f-address">Address (for directions)</label><input id="f-address" value="${esc(f.address)}">
      <label for="f-notes">Notes</label><textarea id="f-notes" rows="3">${esc(f.notes)}</textarea>
      <button class="primary block" style="margin-top:16px" data-act="save-booking">${editing ? 'Save changes' : 'Add tee time'}</button>
      <p class="tiny faint" style="margin:10px 0 0">The deposit is split evenly among the people above and shows up in Money right away. Everyone else on it gets a notification.</p>
    </section>`,
  });
}
function readFormInputs() {
  const f = ui.form; if (!f || !$('#bf')) return;
  const v = (id) => $('#' + id)?.value ?? '';
  Object.assign(f, { course: v('f-course'), date: v('f-date'), time: v('f-time'), players: Number(v('f-players')), bookerId: Number(v('f-booker')),
    total: v('f-total'), deposit: v('f-deposit'), cancelHours: v('f-cancel'), confirmation: v('f-conf'), address: v('f-address'), notes: v('f-notes'), balanceBy: v('f-balance') });
  if ($('#paste')) f.paste = $('#paste').value;
}
async function readPaste() {
  readFormInputs();
  const text = ui.form.paste;
  if (!text.trim()) return toast('Paste the email text first');
  try {
    const r = await api('POST', '/api/parse', { text });
    const f = ui.form;
    if (r.course) f.course = r.course;
    if (r.teeAt) { const p = laParts(r.teeAt); f.date = p.date; f.time = p.time; } else if (r.date) f.date = r.date;
    if (r.players) f.players = r.players;
    if (r.holes) f.holes = r.holes;
    if (r.bookerId) f.bookerId = r.bookerId;
    if (!f.roster.includes(f.bookerId)) f.roster.push(f.bookerId);
    if (r.total != null) { f.total = dollars(r.total); f.autoPrice = false; }
    if (r.deposit != null) f.deposit = dollars(r.deposit);
    if (r.cancelHours != null) f.cancelHours = r.cancelHours;
    if (r.confirmation) f.confirmation = r.confirmation;
    if (r.address) f.address = r.address;
    if (r.notes) f.notes = r.notes;
    f.source = r.source || 'Pasted';
    render();
    toast(r.missing.length ? `Read it. Please fill in: ${r.missing.map((m) => ({ teeAt: 'date/time', course: 'course', players: 'players' }[m])).join(', ')}` : `Read it from ${r.source}. Check it over, then save.`);
  } catch (e) { toast(e.message); }
}
async function saveBooking() {
  readFormInputs();
  const f = ui.form;
  if (!f.date || !f.time) return toast('Pick the date and tee time');
  const auto = f.autoPrice && isLaCityName(f.course);
  const body = { course: f.course, teeAt: laTime(f.date, f.time), players: f.players, holes: f.holes, bookerId: f.bookerId, roster: f.roster, total: auto ? '' : f.total, deposit: f.deposit,
    cancelHours: Number(f.cancelHours), confirmation: f.confirmation, address: f.address, notes: f.notes, source: f.source, ride: f.ride, balanceBy: f.balanceBy ? Number(f.balanceBy) : null, autoPrice: auto };
  try {
    const r = f.id ? await api('PUT', `/api/bookings/${f.id}`, body) : await api('POST', '/api/bookings', body);
    ui.form = null; delete ui.briefs[r.booking.id];
    await refresh(false);
    toast(f.id ? 'Saved' : 'Tee time added');
    go(`#/b/${r.booking.id}`);
  } catch (e) { toast(e.message); }
}

// ---------- ranges & simulators ----------
function viewPractice() {
  const P = ui.practice || (ui.practice = { kind: 'all', data: null, loading: false, where: null });
  const list = (P.data?.places || []).filter((p) => P.kind === 'all' || p.kind === P.kind);
  const body = !S.features.google ? `<div class="card note">This needs the Google key, added once in Me › Admin.</div>`
    : `<section class="card"><div class="row"><span class="grow small-text dim">${P.where === 'here' ? 'Near where you are now' : P.where === 'home' ? 'Near your home' : 'Pick a starting point'}</span></div>
        <div class="row" style="margin-top:10px"><button class="grow ${P.where === 'here' ? 'primary' : ''}" data-act="practice-here">${icon('locate')}Near me</button>
        <button class="grow ${P.where === 'home' ? 'primary' : ''}" data-act="practice-home" ${S.me.homeSet ? '' : 'disabled'}>${icon('user')}Near home</button></div>
        ${S.me.homeSet ? '' : `<div class="tiny faint" style="margin-top:8px">Add your home address in <a href="#/me">Me</a> to search from home.</div>`}</section>
      ${P.data ? `<div class="seg"><button data-act="practice-kind" data-v="all" class="${P.kind === 'all' ? 'on' : ''}">All</button><button data-act="practice-kind" data-v="range" class="${P.kind === 'range' ? 'on' : ''}">Ranges</button><button data-act="practice-kind" data-v="sim" class="${P.kind === 'sim' ? 'on' : ''}">Simulators</button></div>
      <section class="card flush list">${list.length ? list.map((p) => `<a class="link-row" href="${esc(p.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + p.address)}`)}" target="_blank" rel="noopener">
        <span class="ic">${icon(p.kind === 'sim' ? 'target' : 'flag')}</span><span class="grow"><b>${esc(p.name)}</b><div class="small-text dim">${esc(p.address)}</div></span><span class="small-text brass nowrap num">${p.miles} mi</span></a>`).join('')
        : `<div class="empty">Nothing within 30 miles.</div>`}</section>` : P.loading ? `<div class="card empty">Looking…</div>` : ''}`;
  return frame({ title: 'Ranges & simulators', back: '#/', tab: 'tee', body });
}
async function loadPractice(where) {
  const P = ui.practice; P.where = where; P.loading = true; P.data = null; render();
  try {
    let qs = '';
    if (where === 'here') {
      const pos = await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * MIN }));
      qs = `?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`;
    }
    P.data = await api('GET', `/api/practice${qs}`);
  } catch (e) { toast(e.code === 1 ? 'Location is blocked for this site' : e.message || 'Could not get your location'); P.where = null; }
  P.loading = false; render();
}

// ---------- money ----------
function expenseLine(e) {
  const mine = e.split[S.me.id] || 0;
  const effect = (e.paidBy === S.me.id ? e.amount : 0) - mine;
  const b = e.bookingId && S.bookings.find((x) => x.id === e.bookingId);
  const who = Object.keys(e.split).map(Number);
  const canDel = !e.auto && (e.createdBy === S.me.id || e.paidBy === S.me.id || S.me.admin);
  return `<div class="line"><div class="grow"><div><b>${esc(e.category)}</b>${e.description && e.category !== 'Deposit' ? ` <span class="dim">· ${esc(e.description)}</span>` : ''}</div>
    <div class="tiny faint">${money(e.amount)} paid by ${esc(first(e.paidBy))} · for ${who.map((id) => esc(first(id))).join(', ')}${b ? ` · ${esc(b.course)} ${fDay(b.teeAt)}` : ` · ${fDay(e.ts)}`}</div></div>
    <div class="amt num ${effect > 0 ? 'pos' : effect < 0 ? 'neg' : 'faint'}">${effect ? (effect > 0 ? '+' : '') + money(effect) : '—'}</div>
    ${canDel ? `<button class="x" data-act="del-exp" data-id="${e.id}" aria-label="Delete">✕</button>` : '<span style="width:30px"></span>'}</div>`;
}
function settlementLine(s) {
  const effect = s.fromId === S.me.id ? s.amount : s.toId === S.me.id ? -s.amount : 0;
  return `<div class="line"><div class="grow"><div><b>Settled</b> <span class="dim">· ${esc(first(s.fromId))} → ${esc(first(s.toId))}</span></div>
    <div class="tiny faint">${money(s.amount)} by ${esc(s.method === 'venmo' ? 'Venmo' : s.method)} · ${fDay(s.ts)}</div></div>
    <div class="amt num ${effect > 0 ? 'pos' : effect < 0 ? 'neg' : 'faint'}">${effect ? (effect > 0 ? '+' : '') + money(effect) : '—'}</div>
    <button class="x" data-act="del-set" data-id="${s.id}" aria-label="Undo">✕</button></div>`;
}
function transferRow(t) {
  const iPay = t.fromId === S.me.id, iGet = t.toId === S.me.id;
  const note = '⛳ GolfBuddy settle-up';
  let buttons = '';
  if (iPay) {
    const v = user(t.toId).venmo;
    buttons = `${v ? `<a class="btn primary grow" href="${venmoUrl(v, t.amount, note)}" target="_blank" rel="noopener" data-act="venmo" data-from="${t.fromId}" data-to="${t.toId}" data-amt="${t.amount}">Pay with Venmo</a>` : `<span class="tiny faint grow">${esc(first(t.toId))} hasn't added a Venmo username yet</span>`}
      <button class="outline" data-act="mark-paid" data-from="${t.fromId}" data-to="${t.toId}" data-amt="${t.amount}">Mark paid</button>`;
  } else if (iGet) {
    const v = user(t.fromId).venmo;
    buttons = `${v ? `<a class="btn grow" href="${venmoUrl(v, t.amount, note, 'charge')}" target="_blank" rel="noopener">Request on Venmo</a>` : ''}
      <button class="outline" data-act="mark-paid" data-from="${t.fromId}" data-to="${t.toId}" data-amt="${t.amount}">Mark received</button>`;
  }
  return `<div class="owe"><div class="row"><span class="grow">${esc(first(t.fromId))} ${iPay ? 'owe' : 'owes'} ${esc(iGet ? 'you' : first(t.toId))}</span><span class="mid num">${money(t.amount)}</span></div>
    ${buttons ? `<div class="row">${buttons}</div>` : ''}</div>`;
}
function viewMoney() {
  const b = myBalance();
  const hist = [...S.expenses.map((e) => ({ ts: e.ts, html: expenseLine(e) })), ...S.settlements.map((s) => ({ ts: s.ts, html: settlementLine(s) }))].sort((a, b) => b.ts - a.ts);
  const p = ui.pendingPay;
  return frame({
    title: 'Money', tab: 'money',
    body: `${p ? `<section class="card"><b>Did the Venmo payment go through?</b><div class="small-text dim">${money(p.amount)} to ${esc(user(p.toId).name)}. GolfBuddy can't see Venmo, so tell it.</div>
      <div class="row" style="margin-top:12px"><button class="primary" data-act="pending-yes">Yes, mark paid</button><button class="outline" data-act="pending-no">Not yet</button></div></section>` : ''}
    <section class="card"><div class="over">Where you stand</div>
      <div class="balance num ${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}" style="margin:6px 0 4px">${b > 0 ? `You're owed ${money(b)}` : b < 0 ? `You owe ${money(-b)}` : 'All square'}</div>
      <div class="list">${S.transfers.map(transferRow).join('')}</div></section>
    <a class="btn primary block" href="#/money/add">${icon('plus')} Add an expense</a>
    <section class="card"><div class="card-head"><h2>History</h2></div><div class="list">${hist.length ? hist.map((h) => h.html).join('') : `<div class="empty">Deposits, green fees, food and pro-shop buys land here.</div>`}</div></section>`,
  });
}
function viewAddExpense(q) {
  if (!ui.exp) {
    const b = q.get('b') ? S.bookings.find((x) => x.id === Number(q.get('b'))) : null;
    ui.exp = { amount: q.get('amt') || '', category: q.get('cat') || 'Food & drinks', description: '', paidBy: S.me.id, mode: 'even',
      ids: b ? b.roster.map((r) => r.userId) : S.users.map((u) => u.id), full: S.users.find((u) => u.id !== S.me.id)?.id || S.me.id, shares: {}, bookingId: b ? b.id : '' };
  }
  const x = ui.exp;
  const recent = S.bookings.filter((b) => b.teeAt > Date.now() - 60 * 24 * HOUR).sort((a, b) => b.teeAt - a.teeAt);
  return frame({
    title: 'Add an expense', back: x.bookingId ? `#/b/${x.bookingId}` : '#/money', tab: 'money',
    body: `<section class="card" id="xf">
      <label style="margin-top:0">What for</label><div class="chips">${S.categories.filter((c) => c !== 'Deposit').map((c) => `<button class="chip ${x.category === c ? 'on' : ''}" data-act="x-cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="grid2"><div><label for="x-amt">Amount ($)</label><input id="x-amt" inputmode="decimal" value="${esc(x.amount)}" placeholder="0.00"></div>
        <div><label for="x-paid">Paid by</label><select id="x-paid">${S.users.map((u) => `<option value="${u.id}" ${u.id === x.paidBy ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div></div>
      <label for="x-desc">Note (optional)</label><input id="x-desc" value="${esc(x.description)}" placeholder="Burgers at the turn">
      <label>Split</label><div class="seg"><button data-act="x-mode" data-v="even" class="${x.mode === 'even' ? 'on' : ''}">Evenly</button><button data-act="x-mode" data-v="full" class="${x.mode === 'full' ? 'on' : ''}">All for one</button><button data-act="x-mode" data-v="custom" class="${x.mode === 'custom' ? 'on' : ''}">Amounts</button></div>
      <div style="margin-top:10px">${x.mode === 'even' ? `<div class="chips">${S.users.map((u) => `<button class="chip ${x.ids.includes(u.id) ? 'on' : ''}" data-act="x-id" data-v="${u.id}">${esc(u.name)}</button>`).join('')}</div>`
        : x.mode === 'full' ? `<label for="x-full">It was all for</label><select id="x-full">${S.users.map((u) => `<option value="${u.id}" ${u.id === x.full ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`
        : S.users.map((u) => `<label for="x-sh-${u.id}">${esc(u.name)}'s share ($)</label><input id="x-sh-${u.id}" data-share="${u.id}" inputmode="decimal" value="${esc(x.shares[u.id] || '')}">`).join('')}</div>
      <label for="x-b">Tee time (optional)</label><select id="x-b"><option value="">None</option>${recent.map((b) => `<option value="${b.id}" ${String(b.id) === String(x.bookingId) ? 'selected' : ''}>${esc(b.course)} · ${fDay(b.teeAt)}</option>`).join('')}</select>
      <button class="primary block" style="margin-top:16px" data-act="save-exp">Add it</button></section>`,
  });
}
function readExpInputs() {
  const x = ui.exp; if (!x || !$('#xf')) return;
  x.amount = $('#x-amt').value; x.paidBy = Number($('#x-paid').value); x.description = $('#x-desc').value; x.bookingId = $('#x-b').value;
  if ($('#x-full')) x.full = Number($('#x-full').value);
  $$('[data-share]').forEach((el) => { x.shares[el.dataset.share] = el.value; });
}
async function saveExpense() {
  readExpInputs();
  const x = ui.exp;
  const split = x.mode === 'even' ? { mode: 'even', ids: x.ids } : x.mode === 'full' ? { mode: 'full', id: x.full } : { mode: 'custom', shares: x.shares };
  try {
    await api('POST', '/api/expenses', { amount: x.amount, paidBy: x.paidBy, category: x.category, description: x.description, split, bookingId: x.bookingId || null });
    const back = x.bookingId ? `#/b/${x.bookingId}` : '#/money';
    ui.exp = null; await refresh(false); toast('Added'); go(back);
  } catch (e) { toast(e.message); }
}
async function markPaid(fromId, toId, amount) {
  try { await api('POST', '/api/settlements', { fromId, toId, amount: amount / 100, method: 'venmo' }); ui.pendingPay = null; await refresh(); toast('Marked as settled'); }
  catch (e) { toast(e.message); }
}

// ---------- scorecards ----------
function totals(r, s) {
  let strokes = 0, par = 0, n = 0;
  s.strokes.forEach((x, i) => { if (x) { strokes += x; par += r.pars[i] || 4; n++; } });
  return { strokes, toPar: strokes - par, n };
}
const toParText = (d) => (d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`);
function orderedScores(r) { return [...r.scores].sort((a, b) => S.users.findIndex((u) => u.id === a.userId) - S.users.findIndex((u) => u.id === b.userId)); }
function roundSummary(r) {
  return `<div class="row">${orderedScores(r).map((s) => { const t = totals(r, s); return `<span class="pill ${t.toPar < 0 ? 'ok' : ''} num">${esc(first(s.userId))} ${t.n ? `${t.strokes} (${toParText(t.toPar)})${t.n < r.holes ? ` thru ${t.n}` : ''}` : '—'}</span>`; }).join('')}</div>`;
}
function headToHead() {
  const out = [];
  for (const u of S.users) {
    if (u.id === S.me.id) continue;
    let w = 0, l = 0, t = 0;
    for (const r of S.rounds) {
      const a = r.scores.find((s) => s.userId === S.me.id), b = r.scores.find((s) => s.userId === u.id);
      if (!a || !b) continue;
      const ta = totals(r, a), tb = totals(r, b);
      if (ta.n !== r.holes || tb.n !== r.holes) continue;
      if (ta.strokes < tb.strokes) w++; else if (ta.strokes > tb.strokes) l++; else t++;
    }
    if (w + l + t) out.push(`<div class="line"><span class="grow">You vs ${esc(u.name)}</span><span class="mid num">${w}–${l}${t ? `–${t}` : ''}</span></div>`);
  }
  return out.join('');
}
function viewScores() {
  if (!ui.round) ui.round = { course: '', date: laParts(Date.now()).date, holes: 18, start: 1, players: S.users.map((u) => u.id), open: false };
  const n = ui.round;
  const h2h = headToHead();
  return frame({
    title: 'Rounds', tab: 'scores',
    body: `<section class="card">${n.open ? `<h2>New scorecard</h2>
      <label for="r-course">Course</label><input id="r-course" list="courses2" value="${esc(n.course)}" autocomplete="off"><datalist id="courses2">${S.courses.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <div class="grid2"><div><label for="r-date">Date</label><input id="r-date" type="date" value="${esc(n.date)}"></div>
      <div><label>Holes</label><div class="seg"><button data-act="r-holes" data-v="18" class="${n.holes === 18 ? 'on' : ''}">18</button><button data-act="r-holes" data-v="9" class="${n.holes === 9 && n.start === 1 ? 'on' : ''}">F9</button><button data-act="r-holes" data-v="9b" class="${n.holes === 9 && n.start === 10 ? 'on' : ''}">B9</button></div></div></div>
      <label>Players</label><div class="chips">${S.users.map((u) => `<button class="chip ${n.players.includes(u.id) ? 'on' : ''}" data-act="r-player" data-v="${u.id}">${esc(u.name)}</button>`).join('')}</div>
      <button class="primary block" style="margin-top:16px" data-act="r-start">Start scoring</button>`
      : `<button class="primary block" data-act="r-open">${icon('plus')} New scorecard</button>`}</section>
    <section class="card flush list"><a class="link-row" href="#/trends"><span class="ic">${icon('trend')}</span><span class="grow"><b>Your game</b><div class="small-text dim">Distance by club, misses, and scoring</div></span><span class="faint">${icon('chev')}</span></a></section>
    ${h2h ? `<section class="card"><div class="card-head"><h2>Head to head</h2></div><div class="list">${h2h}</div><p class="tiny faint" style="margin:8px 0 0">Completed rounds only, gross strokes.</p></section>` : ''}
    <section class="card"><div class="card-head"><h2>Rounds</h2></div><div class="list">${S.rounds.length ? S.rounds.map((r) => `<a class="line" href="#/r/${r.id}"><div class="grow"><div class="serif" style="font-size:16px">${esc(r.course)}</div><div class="tiny faint" style="margin-bottom:6px">${fDay(r.playedOn)} · ${r.holes === 9 ? (r.startHole === 10 ? 'back 9' : 'front 9') : '18 holes'}</div>${roundSummary(r)}</div><span class="faint">${icon('chev')}</span></a>`).join('')
      : `<div class="empty">No rounds yet. Start a scorecard from a tee time or here.</div>`}</div></section>`,
  });
}
async function startRound(body) {
  try { const r = await api('POST', '/api/rounds', body); await refresh(false); go(`#/r/${r.round.id}`); } catch (e) { toast(e.message); }
}
function holeFacts(r, holeNo) {
  const c = S.courses.find((x) => x.id === r.courseId);
  const info = c?.info, h = info?.holes?.[holeNo - 1];
  if (!h) return '';
  const tee = ui.tee[c.id] || (info.tees.find((t) => t.name.toLowerCase() === (S.me.tee || '').toLowerCase()) || info.tees[Math.min(1, info.tees.length - 1)])?.name;
  const t = info.tees.find((x) => x.name === tee);
  const y = t?.holes?.[holeNo - 1];
  return `${y ? `${y} yds ${teeDot(t.name)}` : ''}${h.hcp ? ` · hcp ${h.hcp}` : ''}`;
}
function viewRound(id) {
  const r = S.rounds.find((x) => x.id === id);
  if (!r) return frame({ title: 'Scorecard', back: '#/scores', tab: 'scores', body: `<div class="card empty">That scorecard isn't here any more.</div>` });
  const i = Math.min(ui.hole[id] ?? firstOpenHole(r), r.holes - 1);
  const holeNo = r.startHole + i;
  const par = r.pars[i] || 4;
  const sc = orderedScores(r);
  const done = (k) => sc.every((s) => s.strokes[k]);
  const cell = (s, k) => { const x = s.strokes[k]; if (!x) return '<td class="faint">·</td>'; const d = x - (r.pars[k] || 4); return `<td><span class="${d < 0 ? 'birdie tag-under' : d > 0 ? 'tag-over' : ''}">${x}</span></td>`; };
  const sum = (arr, a, b) => arr.slice(a, b).reduce((t, x) => t + (x || 0), 0) || '';
  const split18 = r.holes === 18;
  return frame({
    title: r.course, back: r.bookingId ? `#/b/${r.bookingId}` : '#/scores', tab: 'scores', right: `<a class="btn quiet" href="#/r/${r.id}/shots" aria-label="Shots">${icon('target')}</a>`,
    body: `<section class="card">
      <div class="holebar">${r.pars.map((_, k) => `<button class="${k === i ? 'on' : done(k) ? 'done' : ''}" data-act="hole" data-v="${k}">${r.startHole + k}</button>`).join('')}</div>
      <div class="holehead"><div><div class="h">Hole ${holeNo}</div><div class="facts">${holeFacts(r, holeNo)}</div></div><button class="chip" data-act="par" data-v="${i}">Par ${par} ↻</button></div>
      <div class="list">${sc.map((s) => { const x = s.strokes[i]; return `<div class="score"><span class="nm">${esc(user(s.userId).name)}</span>
        <button data-act="stroke" data-u="${s.userId}" data-d="-1" aria-label="One less">−</button><span class="n num ${x ? '' : 'faint'}" data-act="stroke" data-u="${s.userId}" data-d="0">${x || par}</span><button data-act="stroke" data-u="${s.userId}" data-d="1" aria-label="One more">+</button></div>`; }).join('')}</div>
      <p class="tiny faint" style="margin:4px 0 12px">A faint number is just the par: tap it to confirm, or use − / +.</p>
      <div class="row"><button class="grow outline" data-act="hole" data-v="${Math.max(0, i - 1)}" ${i === 0 ? 'disabled' : ''}>‹ ${holeNo - 1}</button><a class="btn grow" href="#/r/${r.id}/shots">${icon('target')}Shots</a><button class="grow primary" data-act="hole" data-v="${Math.min(r.holes - 1, i + 1)}" ${i === r.holes - 1 ? 'disabled' : ''}>${holeNo + 1} ›</button></div>
    </section>
    <section class="card cardtbl"><table>
      <tr><th>Hole</th>${r.pars.map((_, k) => `<th>${r.startHole + k}</th>${split18 && k === 8 ? '<th class="sum">Out</th>' : ''}`).join('')}${split18 ? '<th class="sum">In</th>' : ''}<th class="sum">Tot</th></tr>
      <tr><td>Par</td>${r.pars.map((p, k) => `<td class="faint">${p}</td>${split18 && k === 8 ? `<td class="sum faint">${sum(r.pars, 0, 9)}</td>` : ''}`).join('')}${split18 ? `<td class="sum faint">${sum(r.pars, 9, 18)}</td>` : ''}<td class="sum faint">${sum(r.pars, 0, r.holes)}</td></tr>
      ${sc.map((s) => `<tr><td>${esc(first(s.userId))}</td>${r.pars.map((_, k) => cell(s, k) + (split18 && k === 8 ? `<td class="sum">${sum(s.strokes, 0, 9)}</td>` : '')).join('')}${split18 ? `<td class="sum">${sum(s.strokes, 9, 18)}</td>` : ''}<td class="sum">${sum(s.strokes, 0, r.holes)}</td></tr>`).join('')}
    </table><div style="margin-top:12px">${roundSummary(r)}</div></section>
    <section class="card"><h2>Post to GHIN</h2><p class="small-text dim" style="margin-top:0">GHIN doesn't let personal apps post scores, so this copies your hole-by-hole scores to paste or read off in the GHIN app.</p>
      <div class="row"><button class="outline" data-act="ghin-copy" data-id="${r.id}">${icon('copy', 'sm')} Copy my scores</button><a class="btn outline" href="https://www.ghin.com/" target="_blank" rel="noopener">Open GHIN</a></div></section>
    <button class="quiet danger" data-act="del-round" data-id="${r.id}">Delete this scorecard</button>`,
  });
}
function firstOpenHole(r) { for (let k = 0; k < r.holes; k++) if (!r.scores.every((s) => s.strokes[k])) return k; return 0; }
function saveRoundSoon(r, payload) {
  clearTimeout(ui.saving[r.id]);
  ui.saving[r.id] = setTimeout(async () => {
    try { const x = await api('PUT', `/api/rounds/${r.id}`, payload()); Object.assign(r, x.round); } catch (e) { toast(e.message); }
  }, 500);
}

// ---------- me ----------
function viewMe() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const me = S.me;
  const teeNames = [...new Set(S.courses.flatMap((c) => c.info?.tees?.map((t) => t.name.split('/')[0]) || []))];
  return frame({
    title: 'Me', tab: 'me',
    body: `<section class="card" id="mf"><h2>Profile</h2>
      <label for="m-name">Name</label><input id="m-name" value="${esc(me.name)}">
      <label for="m-venmo">Venmo username</label><input id="m-venmo" value="${esc(me.venmo)}" placeholder="without the @" autocapitalize="off">
      <label for="m-tee">Tees you usually play</label><select id="m-tee"><option value="">No preference</option>${teeNames.map((t) => `<option ${t === me.tee ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <div class="over" style="margin:20px 0 2px">Getting there</div>
      <label for="m-home">Home address <span class="faint">(only you see it; used for “leave by” times)</span></label><input id="m-home" value="${esc(me.home)}" placeholder="Street, city, ZIP" autocomplete="street-address">
      <div class="grid2"><div><label for="m-arrive">Arrive early (minutes)</label><input id="m-arrive" inputmode="numeric" value="${esc(me.arriveMins)}"></div>
      <div><label for="m-phone">Mobile number</label><input id="m-phone" inputmode="tel" value="${esc(me.phone)}" placeholder="(310) 555-0123" autocomplete="tel"></div></div>
      <div class="row" style="margin-top:16px"><span class="grow"><b>Wake-up calls</b><div class="tiny faint">A phone call 30 minutes before you need to leave, for tee times before 8 a.m. Switch it off per tee time any time.</div></span>
        <button class="switch ${me.wakeOk ? 'on' : ''}" data-act="me-wake" aria-label="Wake-up calls"></button></div>
      ${S.features.calls && me.phone ? `<button class="outline block" style="margin-top:10px" data-act="test-call">${icon('phone')} Call me now (test)</button>` : ''}
      <div class="over" style="margin:22px 0 2px">L.A. City Player Card</div>
      <div class="row" style="margin-top:10px"><span class="grow"><b>I have a Player Card</b><div class="tiny faint">Twilight rates start an hour earlier for you. Kept here for safe keeping; only you see the number.</div></span>
        <button class="switch ${me.card ? 'on' : ''}" data-act="me-card" aria-label="Has a Player Card"></button></div>
      <div class="grid2"><div><label for="m-cardno">Card number</label><input id="m-cardno" value="${esc(me.cardNo)}" autocomplete="off" inputmode="numeric"></div>
      <div><label for="m-cardexp">Renews on</label><input id="m-cardexp" type="date" value="${esc(me.cardExp)}"></div></div>
      ${me.cardNo ? `<button class="chip" style="margin-top:8px" data-act="copy" data-v="${esc(me.cardNo)}">${icon('copy', 'sm')} Copy card number</button>` : ''}
      <button class="primary block" style="margin-top:16px" data-act="save-me">Save</button></section>
    <section class="card"><h2>Notifications</h2>
      <p class="small-text dim" style="margin-top:0">${S.push.mine ? `On for ${S.push.mine} device${S.push.mine > 1 ? 's' : ''}.` : perm === 'denied' ? 'Blocked. Allow notifications for this site in Chrome (lock icon › Permissions), then come back.' : perm === 'unsupported' ? 'This browser cannot do push notifications.' : 'Off on this device.'}
      You'll hear about new or changed tee times, “still in?” ${S.remindHours}h before free cancellation ends, the evening before a round, and new expenses.</p>
      <div class="row"><button class="primary" data-act="push-on">${S.push.mine ? 'Re-connect this device' : 'Turn on'}</button>${S.push.mine ? '<button class="outline" data-act="push-test">Send a test</button>' : ''}</div></section>
    <section class="card flush list">
      <a class="link-row" href="#/bag"><span class="ic">${icon('bag')}</span><span class="grow"><b>Your bag</b><div class="small-text dim">Clubs, balls, gloves, shoes and where to get support</div></span><span class="faint">${icon('chev')}</span></a>
      <a class="link-row" href="#/courses"><span class="ic">${icon('flag')}</span><span class="grow"><b>Courses</b><div class="small-text dim">${S.courses.length} on file</div></span><span class="faint">${icon('chev')}</span></a>
    </section>
    <section class="card"><h2>App</h2>${installEvt ? `<button class="block" data-act="install">Install GolfBuddy</button>` : `<p class="small-text dim" style="margin:0">To install: Chrome menu ⋮ › Add to Home screen. Once installed, GolfBuddy shows up in Android's Share menu, so you can share a confirmation email straight into it.</p>`}</section>
    ${me.admin ? viewAdmin() : ''}
    <section class="card"><h2>Password</h2><div class="grid2"><input id="p-old" type="password" placeholder="current"><input id="p-new" type="password" placeholder="new (6+)"></div>
      <button class="block outline" style="margin-top:10px" data-act="change-pass">Change password</button></section>
    <button class="quiet" data-act="logout">Log out</button>`,
  });
}
function viewAdmin() {
  const K = ui.keys;
  if (!K) api('GET', '/api/admin/keys').then((r) => { ui.keys = r.keys; render(); }).catch(() => {});
  const row = (k, label, hint, type = 'text') => `<label for="k-${k}">${label} ${K?.[k] ? `<span class="pill ok">set ${esc(K[k])}</span>` : '<span class="pill">not set</span>'}</label>
    <input id="k-${k}" data-key="${k}" type="${type}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${K?.[k] ? 'Paste a new one to replace it' : esc(hint)}">`;
  return `<section class="card"><h2>Admin</h2>
    <div class="kv"><span>Invite code</span><span><button class="chip" data-act="copy" data-v="${esc(S.invite)}">${esc(S.invite)} ${icon('copy', 'sm')}</button></span></div>
    <div class="over" style="margin:20px 0 0">Service keys</div>
    <p class="tiny faint" style="margin:6px 0 0">Pasted here, stored on the NAS and never shown again (only the last 4 characters). Leave a box empty to keep what's there.</p>
    ${row('google_server_key', 'Google server key', 'Routes API + Places API (New)', 'password')}
    ${row('google_browser_key', 'Google browser key', 'Maps JavaScript API, limited to golf.juno.nexus/*', 'password')}
    ${row('twilio_sid', 'Twilio Account SID', 'AC…')}
    ${row('twilio_token', 'Twilio Auth Token', '', 'password')}
    ${row('twilio_from', 'Twilio phone number', '+13105550123')}
    <div class="row" style="margin-top:14px"><button class="primary grow" data-act="save-keys">Save keys</button><button class="outline" data-act="test-google" ${S.features.google ? '' : 'disabled'}>Test Google</button></div>
    <label for="a-user" style="margin-top:22px">Reset someone's password</label><div class="row"><select id="a-user" class="grow">${S.users.filter((u) => u.id !== S.me.id).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <input id="a-pass" class="grow" placeholder="new password"><button class="outline" data-act="admin-pass">Set</button></div></section>`;
}
function viewCourses() {
  return frame({
    title: 'Courses', back: '#/me', tab: 'me', right: `<a class="btn quiet" href="#/course/new" aria-label="Add">${icon('plus')}</a>`,
    body: `<section class="card flush list">${S.courses.map((c) => `<a class="link-row" href="#/course/${c.id}"><span class="ic">${icon('flag')}</span><span class="grow"><b>${esc(c.name)}</b><div class="small-text dim">${c.info ? `Par ${c.info.par} · ${c.info.holes.length} holes · ` : c.pars ? `Par ${c.pars.reduce((a, x) => a + x, 0)} · ` : ''}free cancel ${c.cancelHours}h before</div></span><span class="faint">${icon('chev')}</span></a>`).join('')}</section>`,
  });
}
function viewCourse(id) {
  const c = id ? S.courses.find((x) => x.id === id) : { name: '', address: '', phone: '', cancelHours: 24, bookUrl: '', website: '', pars: null, notes: '' };
  if (!c) return frame({ title: 'Course', back: '#/courses', tab: 'me', body: '<div class="card empty">Not found.</div>' });
  const pars = c.pars || Array(18).fill('');
  return frame({
    title: id ? c.name : 'New course', back: '#/courses', tab: 'me',
    body: `${c.info ? `<section class="card">${briefCourse({}, c)}</section>` : ''}
    <section class="card" id="cf"><h2>Details</h2>
      <label for="c-name">Name</label><input id="c-name" value="${esc(c.name)}">
      <label for="c-address">Address</label><input id="c-address" value="${esc(c.address)}">
      <div class="grid2"><div><label for="c-phone">Phone</label><input id="c-phone" value="${esc(c.phone)}" inputmode="tel"></div>
      <div><label for="c-cancel">Free cancel (hours before)</label><input id="c-cancel" value="${esc(c.cancelHours)}" inputmode="numeric"></div></div>
      <label for="c-web">Website</label><input id="c-web" value="${esc(c.website || '')}" placeholder="https://">
      <label for="c-url">Booking website</label><input id="c-url" value="${esc(c.bookUrl)}" placeholder="https://">
      <label>Pars, holes 1–18 (fills in new scorecards)</label>
      <div class="pars">${pars.map((p, k) => `<input data-par="${k}" value="${esc(p)}" inputmode="numeric" maxlength="1" aria-label="Hole ${k + 1} par">`).join('')}</div>
      <label for="c-notes">Your notes</label><textarea id="c-notes" rows="2">${esc(c.notes)}</textarea>
      <button class="primary block" style="margin-top:14px" data-act="save-course" data-id="${id || ''}">Save</button></section>`,
  });
}

// ---------- login ----------
function viewAuth() {
  const reg = ui.authMode === 'register';
  return `<main class="auth card"><img class="logo" src="/icons/icon-192.png" alt=""><h1>Golf<i class="brass">Buddy</i></h1>
    <div class="seg" style="margin:18px 0 4px"><button data-act="auth-mode" data-v="login" class="${reg ? '' : 'on'}">Log in</button><button data-act="auth-mode" data-v="register" class="${reg ? 'on' : ''}">Create account</button></div>
    <form id="authf"><label for="u">Username</label><input id="u" autocomplete="username" autocapitalize="off" required>
    ${reg ? '<label for="n">Your name</label><input id="n" placeholder="Mike">' : ''}
    <label for="pw">Password</label><input id="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
    ${reg ? '<label for="inv">Invite code</label><input id="inv" autocapitalize="off" required>' : ''}
    <button class="primary block" style="margin-top:18px">${reg ? 'Create account' : 'Log in'}</button></form></main>`;
}

// ---------- render & events ----------
function render() {
  const app = $('#app');
  if (!S) { app.innerHTML = viewAuth(); return; }
  const { seg, q } = route();
  const id = Number(seg[1]);
  let html;
  if (seg[0] === 'b' && seg[2] === 'edit') html = viewForm(id);
  else if (seg[0] === 'b') html = viewBooking(id);
  else if (seg[0] === 'new') html = viewForm(null);
  else if (seg[0] === 'money' && seg[1] === 'add') html = viewAddExpense(q);
  else if (seg[0] === 'money' || seg[0] === 'ledger') html = viewMoney();
  else if (seg[0] === 'scores') html = viewScores();
  else if (seg[0] === 'r' && seg[2] && extraViews[seg[2]]) html = extraViews[seg[2]](id, q);
  else if (seg[0] === 'r') html = viewRound(id);
  else if (seg[0] === 'me') html = viewMe();
  else if (seg[0] === 'courses') html = viewCourses();
  else if (seg[0] === 'course') html = viewCourse(seg[1] === 'new' ? null : id);
  else if (seg[0] === 'practice') html = viewPractice();
  else if (extraViews[seg[0]]) html = extraViews[seg[0]](seg, q);
  else html = viewTeeTimes();
  app.innerHTML = html;
  if ($('#f-quote')) refreshFormQuote();
  if (window.afterRender) window.afterRender();
}
// Screens with a half-filled form are not redrawn when fresh data arrives in the background.
const busyForm = () => !!window.__scanning || (!!$('#bf, #xf, #cf, #mf, #gf') && document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
async function refresh(draw = true) {
  try {
    const res = await fetch('/api/state', { credentials: 'include' });
    if (res.status === 401) { S = null; render(); return; }
    if (!res.ok) return;
    S = await res.json();
    if (draw && !busyForm()) render();
  } catch { /* offline: keep what we have */ }
}

window.addEventListener('hashchange', () => {
  const { seg } = route();
  if (!(seg[0] === 'new' || seg[2] === 'edit')) ui.form = null;
  if (!(seg[0] === 'money' && seg[1] === 'add')) ui.exp = null;
  render(); window.scrollTo(0, 0);
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'authf') return;
  e.preventDefault();
  const reg = ui.authMode === 'register';
  try {
    await api('POST', reg ? '/api/register' : '/api/login', { username: $('#u').value, password: $('#pw').value, name: $('#n')?.value, invite: $('#inv')?.value });
    await refresh(); syncPush();
  } catch (err) { toast(err.message); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (['f-date', 'f-time', 'f-players', 'f-course'].includes(t.id) && ui.form) { readFormInputs(); refreshFormQuote(); }
  if (t.id === 'f-course') {
    readFormInputs();
    const c = S.courses.find((x) => x.name.toLowerCase() === t.value.trim().toLowerCase());
    if (c) { ui.form.address = c.address || ui.form.address; ui.form.cancelHours = c.cancelHours; render(); }
  }
  if (t.id === 'r-course' || t.id === 'r-date') { ui.round.course = $('#r-course').value; ui.round.date = $('#r-date').value; }
});

const handlers = {};   // extra click actions from track.js
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  const { seg } = route();
  const keepGoing = act === 'venmo'; // let the Venmo link open
  if (!keepGoing) e.preventDefault();
  try {
    if (handlers[act]) { await handlers[act](el, seg); return; }
    switch (act) {
      case 'auth-mode': ui.authMode = v; render(); break;
      case 'toggle-past': ui.showPast = !ui.showPast; render(); break;
      case 'push-on': await enablePush(); break;
      case 'push-test': { const r = await api('POST', '/api/push/test', {}); toast(r.sent ? 'Sent. It should pop up in a few seconds.' : 'No device is connected yet'); break; }
      case 'install': if (installEvt) { installEvt.prompt(); installEvt = null; } break;
      case 'copy': await navigator.clipboard.writeText(v); toast('Copied'); break;
      // tee times
      case 'rsvp': await api('POST', `/api/bookings/${seg[1]}/rsvp`, { rsvp: v }); delete ui.briefs[seg[1]]; await refresh(); toast(v === 'in' ? "You're in" : 'Marked you out. Your buddy was told.'); break;
      case 'brief-refresh': delete ui.briefs[el.dataset.id]; render(); break;
      case 'wake-toggle': case 'wake-auto': {
        const body = act === 'wake-auto' ? { wake: null } : { wake: v === '1' };
        const r = await api('POST', `/api/bookings/${el.dataset.id}/wake`, body); delete ui.briefs[el.dataset.id]; await refresh();
        toast(r.wake ? 'Wake-up call on' : 'Wake-up call off'); break;
      }
      case 'pick-tee': ui.tee[Number(el.dataset.c)] = v; render(); break;
      case 'ride': await api('POST', `/api/bookings/${el.dataset.id}/ride`, { ride: v }); await refresh(); break;
      case 'use-rate': await api('POST', `/api/bookings/${el.dataset.id}/price`, { auto: true }); await refresh(); toast('Using the City rate'); break;
      case 'paid': {
        const b = S.bookings.find((x) => x.id === Number(el.dataset.id));
        await api('POST', `/api/bookings/${b.id}/paid`, { by: v ? Number(v) : null }); await refresh();
        toast(v ? `Recorded: ${first(Number(v))} paid ${money(b.total - b.deposit)}` : 'Marked not paid yet'); break;
      }
      case 'f-ride': readFormInputs(); ui.form.ride = v; render(); break;
      case 'f-auto': readFormInputs(); ui.form.autoPrice = !ui.form.autoPrice; render(); break;
      case 'test-call': { await api('POST', '/api/me/test-call', {}); toast('Calling you now…'); break; }
      case 'me-card': el.classList.toggle('on'); break;
      case 'cancel': if (confirm('Mark this tee time as cancelled? (Cancel it with the course too. The deposit stays split, since it is usually lost.)')) { await api('POST', `/api/bookings/${el.dataset.id}/cancel`, {}); await refresh(); } break;
      case 'restore': await api('POST', `/api/bookings/${el.dataset.id}/restore`, {}); await refresh(); break;
      case 'delete-booking': if (confirm('Delete this tee time and its deposit line completely?')) { await api('DELETE', `/api/bookings/${el.dataset.id}`); await refresh(false); go('#/'); } break;
      case 'read-paste': await readPaste(); break;
      case 'paste-clip': try { ui.form.paste = await navigator.clipboard.readText(); readFormInputs(); $('#paste').value = ui.form.paste; await readPaste(); } catch { toast('Long-press the box and choose Paste'); } break;
      case 'holes': readFormInputs(); ui.form.holes = Number(v); render(); break;
      case 'roster': { readFormInputs(); const id = Number(v), r = ui.form.roster; ui.form.roster = r.includes(id) ? r.filter((x) => x !== id) : [...r, id]; render(); break; }
      case 'save-booking': await saveBooking(); break;
      case 'start-round': { const b = S.bookings.find((x) => x.id === Number(el.dataset.id)); await startRound({ bookingId: b.id, holes: b.holes, startHole: /back 9/i.test(b.notes) ? 10 : 1, players: b.roster.filter((r) => r.rsvp !== 'out').map((r) => r.userId), playedOn: b.teeAt }); break; }
      // practice
      case 'practice-here': await loadPractice('here'); break;
      case 'practice-home': await loadPractice('home'); break;
      case 'practice-kind': ui.practice.kind = v; render(); break;
      // money
      case 'x-cat': readExpInputs(); ui.exp.category = v; render(); break;
      case 'x-mode': readExpInputs(); ui.exp.mode = v; render(); break;
      case 'x-id': { readExpInputs(); const id = Number(v), r = ui.exp.ids; ui.exp.ids = r.includes(id) ? r.filter((x) => x !== id) : [...r, id]; render(); break; }
      case 'save-exp': await saveExpense(); break;
      case 'del-exp': if (confirm('Delete this expense?')) { await api('DELETE', `/api/expenses/${el.dataset.id}`); await refresh(); } break;
      case 'del-set': if (confirm('Undo this settle-up?')) { await api('DELETE', `/api/settlements/${el.dataset.id}`); await refresh(); } break;
      case 'venmo': ui.pendingPay = { fromId: Number(el.dataset.from), toId: Number(el.dataset.to), amount: Number(el.dataset.amt) }; setTimeout(render, 300); break;
      case 'mark-paid': if (confirm(`Record ${money(Number(el.dataset.amt))} from ${user(Number(el.dataset.from)).name} to ${user(Number(el.dataset.to)).name}?`)) await markPaid(Number(el.dataset.from), Number(el.dataset.to), Number(el.dataset.amt)); break;
      case 'pending-yes': await markPaid(ui.pendingPay.fromId, ui.pendingPay.toId, ui.pendingPay.amount); break;
      case 'pending-no': ui.pendingPay = null; render(); break;
      // scores
      case 'r-open': ui.round.open = true; render(); break;
      case 'r-holes': ui.round.course = $('#r-course').value; ui.round.date = $('#r-date').value; ui.round.holes = v === '18' ? 18 : 9; ui.round.start = v === '9b' ? 10 : 1; render(); break;
      case 'r-player': { ui.round.course = $('#r-course').value; ui.round.date = $('#r-date').value; const id = Number(v), p = ui.round.players; ui.round.players = p.includes(id) ? p.filter((x) => x !== id) : [...p, id]; render(); break; }
      case 'r-start': { const n = ui.round; n.course = $('#r-course').value; n.date = $('#r-date').value; await startRound({ course: n.course, playedOn: laTime(n.date, '12:00'), holes: n.holes, startHole: n.start, players: n.players }); ui.round = null; break; }
      case 'hole': ui.hole[Number(seg[1])] = Number(v); render(); break;
      case 'stroke': {
        const r = S.rounds.find((x) => x.id === Number(seg[1]));
        const i = Math.min(ui.hole[r.id] ?? firstOpenHole(r), r.holes - 1);
        ui.hole[r.id] = i;
        const s = r.scores.find((x) => x.userId === Number(el.dataset.u));
        const par = r.pars[i] || 4, cur = s.strokes[i] || par, d = Number(el.dataset.d);
        while (s.strokes.length < r.holes) s.strokes.push(null);
        s.strokes[i] = Math.max(1, Math.min(20, s.strokes[i] ? cur + d : par + d));
        render();
        saveRoundSoon(r, () => ({ scores: Object.fromEntries(r.scores.map((x) => [x.userId, x.strokes])) }));
        break;
      }
      case 'par': {
        const r = S.rounds.find((x) => x.id === Number(seg[1])), i = Number(v);
        r.pars[i] = ({ 3: 4, 4: 5, 5: 3 })[r.pars[i]] || 4;
        render(); saveRoundSoon(r, () => ({ pars: r.pars }));
        break;
      }
      case 'ghin-copy': {
        const r = S.rounds.find((x) => x.id === Number(el.dataset.id)), s = r.scores.find((x) => x.userId === S.me.id);
        if (!s) { toast("You're not on this card"); break; }
        const t = totals(r, s);
        const text = `${r.course} · ${fDay(r.playedOn)} · ${r.holes} holes\n` + s.strokes.slice(0, r.holes).map((x, k) => `${r.startHole + k}: ${x || '-'}`).join('  ') + `\nTotal ${t.strokes} (${toParText(t.toPar)})`;
        await navigator.clipboard.writeText(text); toast('Copied your scores');
        break;
      }
      case 'del-round': if (confirm('Delete this scorecard?')) { await api('DELETE', `/api/rounds/${el.dataset.id}`); await refresh(false); go('#/scores'); } break;
      // me
      case 'me-wake': el.classList.toggle('on'); break;
      case 'save-me': {
        const wakeOk = $('[data-act="me-wake"]').classList.contains('on');
        await api('POST', '/api/me', { name: $('#m-name').value, venmo: $('#m-venmo').value, tee: $('#m-tee').value, home: $('#m-home').value, phone: $('#m-phone').value,
          arriveMins: Number($('#m-arrive').value || 30), wakeOk, card: $('[data-act="me-card"]').classList.contains('on'), cardNo: $('#m-cardno').value, cardExp: $('#m-cardexp').value });
        ui.briefs = {}; await refresh(); toast('Saved'); break;
      }
      case 'change-pass': await api('POST', '/api/me', { name: S.me.name, venmo: S.me.venmo, password: $('#p-old').value, newPassword: $('#p-new').value }); toast('Password changed'); $('#p-old').value = $('#p-new').value = ''; break;
      case 'admin-pass': await api('POST', '/api/admin/password', { userId: Number($('#a-user').value), password: $('#a-pass').value }); toast('Password set. Tell them the new one.'); break;
      case 'save-keys': {
        const body = {};
        $$('[data-key]').forEach((i) => { if (i.value.trim()) body[i.dataset.key] = i.value.trim(); });
        if (!Object.keys(body).length) { toast('Paste a key first'); break; }
        const r = await api('POST', '/api/admin/keys', body); ui.keys = r.keys; ui.briefs = {}; await refresh(); toast('Keys saved'); break;
      }
      case 'test-google': { const r = await api('POST', '/api/admin/test-google', {}); toast(r.found ? `Google works: found ${r.found}` : 'Google answered, but found nothing'); break; }
      case 'save-course': {
        const pars = $$('[data-par]').map((x) => Number(x.value));
        const body = { name: $('#c-name').value, address: $('#c-address').value, phone: $('#c-phone').value, cancelHours: Number($('#c-cancel').value), bookUrl: $('#c-url').value,
          website: $('#c-web').value, notes: $('#c-notes').value, pars: pars.every((x) => !x) ? null : pars };
        const id = el.dataset.id;
        await api(id ? 'PUT' : 'POST', id ? `/api/courses/${id}` : '/api/courses', body); await refresh(false); toast('Saved'); go('#/courses');
        break;
      }
      case 'logout': await api('POST', '/api/logout', {}); S = null; render(); break;
    }
  } catch (err) { toast(err.message); }
});

// ---------- push ----------
function keyBytes(b64) { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
async function swReady() {
  if (!('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}
async function subscribe(reg) {
  const key = keyBytes(S.push.key);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for a different server key cannot be reused.
  if (sub && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() !== key.join()) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
}
async function enablePush() {
  const reg = await swReady();
  if (!reg || !('PushManager' in window)) return toast('This browser cannot do push notifications');
  const p = await Notification.requestPermission();
  if (p !== 'granted') return toast('Notifications are blocked for this site');
  await subscribe(reg); await refresh(); toast('Notifications are on');
}
// Every visit, make sure the server still has this device's subscription.
async function syncPush() {
  try { if (S && 'Notification' in window && Notification.permission === 'granted') { const reg = await swReady(); if (reg) await subscribe(reg); } else await swReady(); } catch { /* not fatal */ }
}

// ---------- start ----------
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.go) { const h = e.data.go.replace(/^\//, ''); location.hash = h.startsWith('#') ? h : '#/'; refresh(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
window.addEventListener('DOMContentLoaded', async () => {
  // Something shared into the app from another app's Share menu arrives at /share?text=...
  if (location.pathname === '/share') {
    const q = new URLSearchParams(location.search);
    ui.shareText = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join('\n');
    history.replaceState(null, '', '/#/new');
  }
  await refresh();
  if (!S) render();
  syncPush();
});
